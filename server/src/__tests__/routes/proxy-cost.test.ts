import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy, setStrictChain } from '../../services/router.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
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

function seedGroqKey() {
  const db = getDb();
  const key = encrypt('gsk_cost_test');
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'cost-test', ?, ?, ?, 'healthy', 1)
  `).run(key.encrypted, key.iv, key.authTag);
}

const SAMPLE_USAGE = () => ({
  prompt_tokens: 1000,
  completion_tokens: 500,
  total_tokens: 1500,
  prompt_tokens_details: { cached_tokens: 200 },
});

const EXPECTED_COST = 0.000245;

function mockChatCompletion(usage: any) {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
      const parsed = JSON.parse(String(init?.body));
      const freshUsage = usage();
      if (parsed.stream) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"id":"chatcmpl-cost","object":"chat.completion.chunk","created":123,"model":"llama-3.3-70b-versatile","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"id":"chatcmpl-cost","object":"chat.completion.chunk","created":123,"model":"llama-3.3-70b-versatile","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'chatcmpl-cost', object: 'chat.completion.chunk', created: 123, model: 'llama-3.3-70b-versatile', choices: [], usage: freshUsage })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return { ok: true, headers: new Headers(), body: stream } as any;
      }
      return {
        ok: true,
        headers: new Headers(),
        json: () => Promise.resolve({
          id: 'chatcmpl-cost',
          object: 'chat.completion',
          created: 123,
          model: 'llama-3.3-70b-versatile',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
          usage: freshUsage,
        }),
      } as any;
    }
    return origFetch(url, init);
  });
}

describe('POST /v1/chat/completions cost tracking', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    setRoutingStrategy('priority');
    setStrictChain(false);
    db.prepare("DELETE FROM settings WHERE key = 'cost_tracking_enabled'").run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    seedGroqKey();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits cost fields when the toggle is off', async () => {
    mockChatCompletion(SAMPLE_USAGE);
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.usage.cost).toBeUndefined();
    expect(body.spent).toBeUndefined();
  });

  it('adds usage.cost and spent when enabled, using catalog pricing and cached tokens', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('cost_tracking_enabled', '1')").run();
    mockChatCompletion(SAMPLE_USAGE);
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.usage.cost).toBe(EXPECTED_COST);
    expect(body.spent).toBe(EXPECTED_COST);
    expect(body.usage.prompt_tokens_details.cached_tokens).toBe(200);
  });

  it('keeps responses unchanged on a streamed completion with usage when enabled', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('cost_tracking_enabled', '1')").run();
    mockChatCompletion(SAMPLE_USAGE);
    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }, authHeaders());

    expect(status).toBe(200);

    const frames: any[] = [];
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      frames.push(JSON.parse(line.replace(/^data: /, '')));
    }
    const usageFrame = frames.find(f => f.usage);
    expect(usageFrame).toBeTruthy();
    expect(usageFrame.usage.cost).toBe(EXPECTED_COST);
    expect(usageFrame.usage.prompt_tokens).toBe(1000);
  });

  it('does not attach cost to streamed usage chunks when disabled', async () => {
    mockChatCompletion(SAMPLE_USAGE);
    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }, authHeaders());

    expect(status).toBe(200);
    expect(raw).not.toContain('"cost"');
  });

  it('adds usage.cost and spent on legacy completions when enabled', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('cost_tracking_enabled', '1')").run();
    mockChatCompletion(SAMPLE_USAGE);
    const { status, body } = await request(app, 'POST', '/v1/completions', {
      model: 'llama-3.3-70b-versatile',
      prompt: 'const answer',
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.usage.cost).toBe(EXPECTED_COST);
    expect(body.spent).toBe(EXPECTED_COST);
  });
});