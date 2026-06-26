import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { getStickyModel, setStickyModel } from '../../routes/proxy.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Stream turn-integrity (#231 audit): the proxy must deliver agent-usable
// TURNS, not transport bytes. These tests feed crafted upstream SSE bodies
// through a mocked fetch and assert the failure modes observed live are
// either failed over (before headers) or surfaced honestly (after).

async function request(app: Express, path: string, body: any, extraHeaders: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getUnifiedApiKey()}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE body */ }
  return { status: res.status, headers: res.headers, text, body: json };
}

/** Parse an SSE response body into JSON frames (excluding [DONE]). */
function frames(text: string): any[] {
  return text.split('\n')
    .filter(l => l.startsWith('data: ') && l.trim() !== 'data: [DONE]')
    .map(l => JSON.parse(l.slice(6)));
}

const sse = (...payloads: (object | string)[]) =>
  payloads.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');

const roleChunk = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] };
const textChunk = (s: string, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: s }, finish_reason: finish }] });
const finishChunk = (reason: string) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: reason }] });

const TOOLS = [{ type: 'function', function: { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } }];

// Sequential upstream responder: call N gets script[N] (last entry repeats).
// Captures the request body of every upstream call so tests can assert on
// what the proxy actually sent (e.g. stream_options.include_usage).
function mockUpstream(script: Array<{ body: string; status?: number }>) {
  const origFetch = global.fetch;
  let call = 0;
  const seen: Array<{ model: string; stream_options?: any; body: any }> = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    // Only intercept provider upstreams; the test's own localhost request
    // and anything else goes through.
    if (!/api\.groq\.com|openrouter\.ai|api\.cohere|generativelanguage|integrate\.api\.nvidia|api\.cerebras|api\.mistral|router\.huggingface|api\.cloudflare|models\.github|open\.bigmodel|api\.llm7|api\.kilo|text\.pollinations|ollama\.com|opencode\.ai/.test(urlStr)) {
      return origFetch(url as any, init);
    }
    const reqBody = JSON.parse(String((init as RequestInit).body));
    seen.push({ model: reqBody.model, stream_options: reqBody.stream_options, body: reqBody });
    const step = script[Math.min(call++, script.length - 1)];
    return new Response(step.body, {
      status: step.status ?? 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  return { seen, calls: () => call };
}

describe('proxy stream turn-integrity', () => {
  let app: Express;
  let dashToken = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    // One groq key: the seeded chain has several tool-capable groq models, so
    // failover hops between groq models while staying on this mock.
    const { status } = await request(app, '/api/keys',
      { platform: 'groq', key: 'gsk_stream_integrity', label: 't' },
      { Authorization: `Bearer ${dashToken}` });
    expect(status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails over when the upstream stream opens with an in-band error frame (Groq tool_use_failed)', async () => {
    const up = mockUpstream([
      { body: sse({ error: { message: "Failed to call a function. Please adjust your prompt.", type: 'invalid_request_error', code: 'tool_use_failed', status_code: 400 } }, '[DONE]') },
      { body: sse(roleChunk, textChunk('All good from the next model.'), finishChunk('stop'), '[DONE]') },
    ]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'in-band error failover test' }],
    });
    expect(r.status).toBe(200);
    expect(up.calls()).toBe(2);
    expect(r.headers.get('x-fallback-attempts')).toBe('1');
    const fs = frames(r.text);
    expect(fs.some(f => f.choices?.[0]?.delta?.content?.includes('All good'))).toBe(true);
    expect(fs.some(f => f.error)).toBe(false);
    expect(r.headers.get('x-request-id')).toMatch(/\S+/);

    const rows = getDb().prepare("SELECT status, error FROM requests ORDER BY id").all() as any[];
    expect(rows[0].status).toBe('error');
    expect(rows[0].error).toMatch(/in-band provider error/);
    expect(rows[1].status).toBe('success');
  });

  it('synthesizes finish_reason tool_calls and ids for a stream that ends without a terminal reason', async () => {
    // minimax/command-r live shape: valid tool_call deltas, then [DONE] with
    // no finish_reason chunk at all.
    const tcChunk = (frag: object) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { tool_calls: [frag] }, finish_reason: null }] });
    mockUpstream([{
      body: sse(
        roleChunk,
        tcChunk({ index: 0, function: { name: 'Read', arguments: '{"file_pa' } }),
        tcChunk({ index: 0, function: { arguments: 'th":"/tmp/a"}' } }),
        '[DONE]',
      ),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'finish synthesis test' }],
    });
    expect(r.status).toBe(200);
    const fs = frames(r.text);
    const tcFrame = fs.find(f => f.choices?.[0]?.delta?.tool_calls);
    expect(tcFrame).toBeDefined();
    const call = tcFrame.choices[0].delta.tool_calls[0];
    expect(call.function.name).toBe('Read');
    expect(JSON.parse(call.function.arguments)).toEqual({ file_path: '/tmp/a' });
    expect(call.id).toBe('call_stream_1'); // synthesized — upstream sent none
    const finishes = fs.map(f => f.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishes).toEqual(['tool_calls']);
  });

  it('rescues a streamed inline dialect turn into structured tool_calls', async () => {
    mockUpstream([{
      body: sse(
        roleChunk,
        textChunk('<|tool_calls_sec'),
        textChunk('tion_begin|><|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"file_path":"/a"}<|tool_call_end|><|tool_calls_section_end|>'),
        finishChunk('stop'),
        '[DONE]',
      ),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'dialect stream rescue test' }],
    });
    expect(r.status).toBe(200);
    const fs = frames(r.text);
    // The raw dialect text never reaches the client...
    expect(fs.some(f => typeof f.choices?.[0]?.delta?.content === 'string' && f.choices[0].delta.content.includes('<|tool_call'))).toBe(false);
    // ...a structured call does, with the correct terminal reason.
    const tcFrame = fs.find(f => f.choices?.[0]?.delta?.tool_calls);
    expect(tcFrame.choices[0].delta.tool_calls[0].function.name).toBe('Read');
    expect(tcFrame.choices[0].delta.tool_calls[0].id).toBe('call_rescued_1');
    expect(fs.map(f => f.choices?.[0]?.finish_reason).filter(Boolean)).toEqual(['tool_calls']);
  });

  it('fails over an unparseable dialect turn (degraded id token) before headers', async () => {
    const up = mockUpstream([
      { body: sse(roleChunk, textChunk('<|tool_call_begin|> chatcmpl-tool-bde5 <|tool_call_argument_begin|> {"file_path": "/a"}'), finishChunk('stop'), '[DONE]') },
      { body: sse(roleChunk, textChunk('Recovered by the next model.'), finishChunk('stop'), '[DONE]') },
    ]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'unparseable dialect failover test' }],
    });
    expect(r.status).toBe(200);
    expect(up.calls()).toBe(2);
    expect(frames(r.text).some(f => f.choices?.[0]?.delta?.content?.includes('Recovered'))).toBe(true);
  });

  it('fails over an abrupt EOF that happens before any payload', async () => {
    const up = mockUpstream([
      { body: sse(roleChunk) /* EOF: no [DONE], no finish_reason, no payload */ },
      { body: sse(roleChunk, textChunk('Second model answers.'), finishChunk('stop'), '[DONE]') },
    ]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'pre-payload truncation test' }],
    });
    expect(r.status).toBe(200);
    expect(up.calls()).toBe(2);
    expect(frames(r.text).some(f => f.choices?.[0]?.delta?.content?.includes('Second model'))).toBe(true);
    const rows = getDb().prepare("SELECT status, error FROM requests ORDER BY id").all() as any[];
    expect(rows[0].status).toBe('error');
    expect(rows[0].error).toMatch(/stream ended unexpectedly/);
  });

  it('surfaces an honest error frame when truncation happens after payload reached the client', async () => {
    mockUpstream([
      { body: sse(roleChunk, textChunk('Partial ans')) /* EOF mid-generation */ },
    ]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'post-payload truncation test' }],
    });
    expect(r.status).toBe(200);
    const fs = frames(r.text);
    expect(fs.some(f => f.choices?.[0]?.delta?.content === 'Partial ans')).toBe(true);
    expect(fs.some(f => f.error?.type === 'stream_error')).toBe(true);
    const rows = getDb().prepare("SELECT status FROM requests ORDER BY id").all() as any[];
    expect(rows[0].status).toBe('error'); // truncation is never a success
  });

  it('fails over a stream that completes with no content and no tool calls', async () => {
    const up = mockUpstream([
      { body: sse(roleChunk, finishChunk('stop'), '[DONE]') },
      { body: sse(roleChunk, textChunk('Non-empty.'), finishChunk('stop'), '[DONE]') },
    ]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'empty stream failover test' }],
    });
    expect(r.status).toBe(200);
    expect(up.calls()).toBe(2);
    expect(frames(r.text).some(f => f.choices?.[0]?.delta?.content?.includes('Non-empty'))).toBe(true);
  });

  it('never leaks raw tool_call deltas riding on role/reasoning chunks (OpenRouter shape)', async () => {
    // OpenRouter attaches tool_call fragments to chunks that also carry a
    // role or reasoning key. Those must be accumulated, not forwarded raw —
    // forwarding both the fragments AND the assembled call duplicates it.
    mockUpstream([{
      body: sse(
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', reasoning: '', tool_calls: [{ index: 0, id: 'or_1', function: { name: 'Read', arguments: '{"file_' } }] }, finish_reason: null }] },
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { reasoning: null, tool_calls: [{ index: 0, function: { arguments: 'path":"/x"}' } }] }, finish_reason: null }] },
        finishChunk('tool_calls'),
        '[DONE]',
      ),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'delta leak test' }],
    });
    expect(r.status).toBe(200);
    const fs = frames(r.text);
    const tcFrames = fs.filter(f => f.choices?.[0]?.delta?.tool_calls);
    expect(tcFrames).toHaveLength(1); // exactly one complete emission, no raw fragments
    const call = tcFrames[0].choices[0].delta.tool_calls[0];
    expect(call.id).toBe('or_1');
    expect(JSON.parse(call.function.arguments)).toEqual({ file_path: '/x' });
  });

  it('streams ordinary text through unmodified, always ending in a terminal finish_reason', async () => {
    mockUpstream([
      { body: sse(roleChunk, textChunk('Hello'), textChunk(' world'), finishChunk('stop'), '[DONE]') },
    ]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'plain passthrough test' }],
    });
    const fs = frames(r.text);
    const text = fs.map(f => f.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Hello world');
    expect(fs.map(f => f.choices?.[0]?.finish_reason).filter(Boolean)).toEqual(['stop']);
    expect(r.text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  // — Usage / cached-token forwarding (#stream-usage-capture) —
  // Two upstream shapes carry a usage block:
  //   (a) OpenAI standard: a SEPARATE usage-only frame (choices: [], usage: …)
  //       arriving AFTER the finish_reason chunk.
  //   (b) opencode zen / DeepSeek-style shims: usage ATTACHED to the
  //       finish_reason chunk itself (choices: [{…, finish_reason: "stop"}],
  //       usage: …) with no separate usage-only frame.
  // The proxy must capture cached_tokens from BOTH shapes and forward them to
  // the client; previously shape (b) was silently dropped and the proxy
  // synthesized a cache-less fallback, hiding real cache hits.

  it('forces stream_options.include_usage=true upstream even when the client omits it', async () => {
    const up = mockUpstream([{
      body: sse(roleChunk, textChunk('hi'), finishChunk('stop'),
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
        '[DONE]'),
    }]);
    await request(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'include_usage probe' }],
    });
    expect(up.seen[0].stream_options).toEqual({ include_usage: true });
  });

  it('forwards cached_tokens from an OpenAI-standard usage-only frame (choices: [])', async () => {
    const usageFrame = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 80 } } };
    mockUpstream([{
      body: sse(roleChunk, textChunk('hi'), finishChunk('stop'), usageFrame, '[DONE]'),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'openai-shape cached tokens test' }],
    });
    expect(r.status).toBe(200);
    const fs = frames(r.text);
    const usage = fs.find(f => Array.isArray(f.choices) && f.choices.length === 0 && f.usage);
    expect(usage).toBeDefined();
    expect(usage.usage.prompt_tokens_details.cached_tokens).toBe(80);
  });

  it('forwards cached_tokens when usage is attached to the finish_reason chunk (opencode zen / DeepSeek shape)', async () => {
    // opencode zen live shape: a single chunk carries finish_reason AND usage,
    // with cache info in BOTH the OpenAI-standard prompt_tokens_details and
    // the DeepSeek prompt_cache_hit_tokens alias.
    const finishWithUsage = {
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 346, completion_tokens: 22, total_tokens: 368,
        prompt_tokens_details: { cached_tokens: 256 },
        completion_tokens_details: { reasoning_tokens: 20 },
        prompt_cache_hit_tokens: 256, prompt_cache_miss_tokens: 90,
      },
    };
    mockUpstream([{
      body: sse(roleChunk, textChunk('4'), finishWithUsage, '[DONE]'),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'opencode-zen shape cached tokens test' }],
    });
    expect(r.status).toBe(200);
    const fs = frames(r.text);
    // Exactly one terminal finish_reason (the proxy synthesizes mkChunk({},
    // finish); the captured usage must NOT re-emit the upstream's finish chunk).
    const finishes = fs.map(f => f.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishes).toEqual(['stop']);
    // The usage chunk must be a clean OpenAI usage-only frame (choices: [])
    // carrying the cached_tokens from the upstream.
    const usage = fs.find(f => Array.isArray(f.choices) && f.choices.length === 0 && f.usage);
    expect(usage).toBeDefined();
    expect(usage.usage.prompt_tokens).toBe(346);
    expect(usage.usage.prompt_tokens_details.cached_tokens).toBe(256);
    // DeepSeek alias is left in place (normalizeUsage only adds the standard
    // field when missing; it doesn't strip the alias here because the
    // standard field was already present from the upstream).
    expect(usage.usage.prompt_cache_hit_tokens).toBe(256);
  });

  it('maps DeepSeek prompt_cache_hit_tokens into prompt_tokens_details.cached_tokens when only the alias is present', async () => {
    const finishWithUsage = {
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50 },
    };
    mockUpstream([{
      body: sse(roleChunk, textChunk('ans'), finishWithUsage, '[DONE]'),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'deepseek alias mapping test' }],
    });
    const fs = frames(r.text);
    const usage = fs.find(f => Array.isArray(f.choices) && f.choices.length === 0 && f.usage);
    expect(usage).toBeDefined();
    expect(usage.usage.prompt_tokens_details.cached_tokens).toBe(150);
  });

  it('synthesizes a cache-less fallback usage chunk only when the client asked for include_usage and the upstream sent none', async () => {
    mockUpstream([{
      body: sse(roleChunk, textChunk('no usage here'), finishChunk('stop'), '[DONE]'),
    }]);
    // Client opted in via stream_options.include_usage — proxy must synthesize
    // a usage-only frame so clients reading the spec'd choices:[] usage frame
    // still get real token counts even when the provider didn't emit one.
    const r = await request(app, '/v1/chat/completions', {
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'no-upstream-usage fallback test' }],
    });
    expect(r.status).toBe(200);
    const fs = frames(r.text);
    const usage = fs.find(f => Array.isArray(f.choices) && f.choices.length === 0 && f.usage);
    expect(usage).toBeDefined();
    expect(usage.usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.usage.completion_tokens).toBeGreaterThan(0);
    expect(usage.usage.total_tokens).toBe(usage.usage.prompt_tokens + usage.usage.completion_tokens);
    // No cache info available → cached_tokens absent (or 0 if a client defaults it).
    expect(usage.usage.prompt_tokens_details?.cached_tokens ?? 0).toBe(0);
  });

  it('does NOT emit a usage-only frame when the client did not request include_usage (OpenAI spec)', async () => {
    mockUpstream([{
      body: sse(roleChunk, textChunk('no usage opt-out'), finishChunk('stop'), '[DONE]'),
    }]);
    // No stream_options.include_usage: the OpenAI spec forbids emitting a
    // usage-only choices:[] frame the client didn't ask for. Strict SDK parsers
    // reject that as a spec violation, so the proxy must stay silent.
    const r = await request(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'include_usage opt-out spec test' }],
    });
    expect(r.status).toBe(200);
    const fs = frames(r.text);
    const usage = fs.find(f => Array.isArray(f.choices) && f.choices.length === 0 && f.usage);
    expect(usage).toBeUndefined();
  });

  it('rescues a non-streaming inline dialect answer into structured tool_calls', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (!urlStr.includes('api.groq.com')) return origFetch(url as any, init);
      return new Response(JSON.stringify({
        id: 'r1', object: 'chat.completion', created: 1, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: '<function=Read{"file_path": "/tmp/a"}</function>' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const r = await request(app, '/v1/chat/completions', {
      stream: false, tools: TOOLS, messages: [{ role: 'user', content: 'non-stream dialect rescue test' }],
    });
    expect(r.status).toBe(200);
    const msg = r.body.choices[0].message;
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].function.name).toBe('Read');
    expect(msg.tool_calls[0].id).toBe('call_rescued_1');
    expect(msg.content).toBeNull();
    expect(r.body.choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('sticky session integrity', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('keeps affinity from turn 1 to turn 2 (the old single/multi key gap)', () => {
    const t1 = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'sticky turn gap probe' },
    ];
    setStickyModel(t1, 42);
    const t2 = [...t1,
      { role: 'assistant' as const, content: 'answer' },
      { role: 'user' as const, content: 'follow-up' },
    ];
    expect(getStickyModel(t2)).toBe(42);
  });

  it('applies to array-of-blocks content (opencode-style agents)', () => {
    const t1 = [
      { role: 'user' as const, content: [{ type: 'text', text: 'array content sticky probe' }] as any },
    ];
    setStickyModel(t1, 7);
    const t2 = [...t1,
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: [{ type: 'text', text: 'next' }] as any },
    ];
    expect(getStickyModel(t2)).toBe(7);
  });

  it('honors an explicit x-session-id over message hashing', () => {
    const conv1 = [{ role: 'user' as const, content: 'conversation one' }];
    setStickyModel(conv1, 11, 'session-abc');
    const conv2 = [
      { role: 'user' as const, content: 'completely different opener' },
      { role: 'assistant' as const, content: 'hi' },
      { role: 'user' as const, content: 'next' },
    ];
    expect(getStickyModel(conv2, 'session-abc')).toBe(11);
    expect(getStickyModel(conv2)).toBeUndefined();
  });
});
