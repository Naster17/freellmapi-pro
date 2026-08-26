import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { setStrictChain } from '../../services/router.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { resetToolReasoningStore } from '../../lib/reasoning-store.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('Proxy tool-calling support', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    setStrictChain(false);
    resetToolReasoningStore();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_proxy_tool_test',
      label: 'proxy-tools',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes tools/tool_choice to provider and returns tool_calls', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-tool',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Karachi"}',
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      // No `model` → auto-route via fallback chain.
      messages: [{ role: 'user', content: 'What is the weather in Karachi?' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      }],
      tool_choice: 'required',
    }, authHeaders());

    expect(status).toBe(200);
    expect(providerBody.tools).toHaveLength(1);
    expect(providerBody.tool_choice).toBe('required');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
  });

  it('accepts assistant tool_calls + tool messages in follow-up turns', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-final',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'It is 30C in Karachi.',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'Weather in Karachi?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_weather_1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Karachi"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_weather_1',
          content: '{"temp_c":30}',
        },
      ],
    }, authHeaders());

    expect(status).toBe(200);
    expect(providerBody.messages[1].role).toBe('assistant');
    expect(providerBody.messages[1].content).toBeNull();
    expect(providerBody.messages[1].tool_calls).toHaveLength(1);
    expect(providerBody.messages[2].role).toBe('tool');
    expect(providerBody.messages[2].tool_call_id).toBe('call_weather_1');
    expect(body.choices[0].message.content).toContain('30C');
  });

  it('round-trips assistant reasoning_content on follow-up turns (DeepSeek thinking — #255)', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-r', object: 'chat.completion', created: 1, model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'think then answer' },
        {
          role: 'assistant',
          content: 'partial',
          // What a DeepSeek thinking model returned last turn and the client
          // replayed. Stripping it makes OpenCode Zen 400 on this request.
          reasoning_content: 'Let me reason about this step by step...',
        },
        { role: 'user', content: 'continue' },
      ],
    }, authHeaders());

    expect(status).toBe(200);
    expect(providerBody.messages[1].role).toBe('assistant');
    expect(providerBody.messages[1].reasoning_content).toBe('Let me reason about this step by step...');
  });

  it('backfills cached reasoning_content on Zen tool turns the client replayed bare', async () => {
    const addZenKey = await request(app, 'POST', '/api/keys', {
      platform: 'opencode',
      key: 'zen_backfill_test',
      label: 'zen-backfill',
    });
    expect(addZenKey.status).toBe(201);

    const origFetch = global.fetch;
    const zenBodies: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('opencode.ai/zen/v1/chat/completions')) {
        const parsed = JSON.parse((init as any).body);
        zenBodies.push(parsed);
        const isToolFollowUp = parsed.messages.some((m: any) => m.role === 'tool');
        return {
          ok: true,
          json: () => Promise.resolve(isToolFollowUp
            ? {
                id: 'chatcmpl-zen-2', object: 'chat.completion', created: 2, model: 'mimo-v2.5-free',
                choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
              }
            : {
                id: 'chatcmpl-zen-1', object: 'chat.completion', created: 1, model: 'mimo-v2.5-free',
                choices: [{
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: '',
                    reasoning_content: 'Need to call the read tool for a.txt.',
                    tool_calls: [{ id: 'call_zen_read', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
                  },
                  finish_reason: 'tool_calls',
                }],
                usage: { prompt_tokens: 6, completion_tokens: 5, total_tokens: 11 },
              }),
        } as any;
      }
      return origFetch(url, init);
    });

    const tools = [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
    const first = await request(app, 'POST', '/v1/chat/completions', {
      model: 'mimo-v2.5-free',
      messages: [{ role: 'user', content: 'read a.txt' }],
      tools,
    }, authHeaders());
    expect(first.status).toBe(200);
    expect(first.body.choices[0].message.reasoning_content).toBe('Need to call the read tool for a.txt.');

    const second = await request(app, 'POST', '/v1/chat/completions', {
      model: 'mimo-v2.5-free',
      messages: [
        { role: 'user', content: 'read a.txt' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_zen_read', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_zen_read', content: 'alpha beta gamma' },
      ],
      tools,
    }, authHeaders());
    expect(second.status).toBe(200);

    expect(zenBodies).toHaveLength(2);
    const replayed = zenBodies[1].messages.find((m: any) => m.role === 'assistant');
    expect(replayed.reasoning_content).toBe('Need to call the read tool for a.txt.');
  });

  it('backfills a placeholder on Zen tool turns the proxy never saw (model switched onto Zen)', async () => {
    const addZenKey = await request(app, 'POST', '/api/keys', {
      platform: 'opencode',
      key: 'zen_placeholder_test',
      label: 'zen-placeholder',
    });
    expect(addZenKey.status).toBe(201);

    const origFetch = global.fetch;
    let zenBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('opencode.ai/zen/v1/chat/completions')) {
        zenBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-zen-3', object: 'chat.completion', created: 3, model: 'mimo-v2.5-free',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'mimo-v2.5-free',
      messages: [
        { role: 'user', content: 'run ls' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_from_other_model', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_from_other_model', content: 'a.txt b.txt' },
        { role: 'user', content: 'what files?' },
      ],
      tools: [{ type: 'function', function: { name: 'bash', description: 'run command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
    }, authHeaders());
    expect(status).toBe(200);

    const replayed = zenBody.messages.find((m: any) => m.role === 'assistant');
    expect(replayed.reasoning_content).toBe('[reasoning unavailable]');
  });

  it('does not backfill reasoning_content for providers without the replay rule', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-r', object: 'chat.completion', created: 1, model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'run ls' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_foreign', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_foreign', content: 'a.txt' },
        { role: 'user', content: 'what files?' },
      ],
      tools: [{ type: 'function', function: { name: 'bash', description: 'run command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
    }, authHeaders());

    expect(status).toBe(200);
    const replayed = providerBody.messages.find((m: any) => m.role === 'assistant');
    expect(replayed.reasoning_content).toBeUndefined();
  });
});
