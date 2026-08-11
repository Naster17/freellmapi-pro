import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { setStrictChain } from '../../services/router.js';
import { mintDashboardToken } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();

  return { status: res.status, body: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('Analytics input-token accounting', () => {
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
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_analytics_cached_test',
      label: 'analytics-cached',
    }, { Authorization: `Bearer ${dashToken}` });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs only the non-cached portion as input tokens but forwards full usage to the client', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-cached',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.usage.prompt_tokens).toBe(100);
    expect(body.usage.prompt_tokens_details.cached_tokens).toBe(30);

    const row = getDb().prepare(
      "SELECT input_tokens, output_tokens, cached_tokens FROM requests WHERE status = 'success' ORDER BY id DESC LIMIT 1",
    ).get() as { input_tokens: number; output_tokens: number; cached_tokens: number };
    expect(row.input_tokens).toBe(70);
    expect(row.output_tokens).toBe(20);
    expect(row.cached_tokens).toBe(30);
  });

  it('clamps to zero when cached tokens exceed prompt tokens', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-cached-clamp',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: { cached_tokens: 30 } },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(200);

    const row = getDb().prepare(
      "SELECT input_tokens, cached_tokens FROM requests WHERE status = 'success' ORDER BY id DESC LIMIT 1",
    ).get() as { input_tokens: number; cached_tokens: number };
    expect(row.input_tokens).toBe(0);
    expect(row.cached_tokens).toBe(30);
  });
});