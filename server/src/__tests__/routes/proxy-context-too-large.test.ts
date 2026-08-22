import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { mockProbeCooldownKeys } = vi.hoisted(() => ({ mockProbeCooldownKeys: vi.fn() }));
vi.mock('../../services/cooldown-probe.js', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, probeCooldownKeys: mockProbeCooldownKeys };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');
const { resetRateLimitProbeHits } = await import('../../lib/fallback-loop.js');
const { _clearInMemoryRateLimitStateForTest } = await import('../../services/ratelimit.js');

async function post(app: Express, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json };
}

const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

const CONTEXT_ERROR = Object.assign(
  new Error(`API error 413: This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.`),
  { status: 413, code: 'context_length_exceeded' },
);

describe('context-too-large rejections are honest 413s, never fake cooldowns', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();

    const { encrypted, iv, authTag } = encrypt('groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);

    db.prepare("UPDATE models SET enabled = 0").run();
    db.prepare("UPDATE models SET tpm_limit = 6000, tpd_limit = NULL, context_window = 200000").run();
    const row = db.prepare("SELECT platform, model_id FROM models WHERE platform = 'groq' LIMIT 1").get() as { platform: string; model_id: string };
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = ? AND model_id = ?").run(row.platform, row.model_id);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    mockProbeCooldownKeys.mockReset();
    resetRateLimitProbeHits();
    _clearInMemoryRateLimitStateForTest();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    getDb().prepare('DELETE FROM rate_limit_usage').run();
  });

  it('returns 413 context_length_exceeded without benching the key or penalizing the model when the provider rejects the request as too large', async () => {
    chatCompletion.mockRejectedValue(CONTEXT_ERROR);

    const { status, body } = await post(app, {
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 20,
    }, key);

    expect(status).toBe(413);
    expect(body.error.code).toBe('context_length_exceeded');
    const keyRow = getDb().prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get('groq') as { id: number };
    const cooldown = getDb().prepare('SELECT 1 FROM rate_limit_cooldowns WHERE key_id = ?').get(keyRow.id);
    expect(cooldown).toBeUndefined();
  });

  it('the same key stays routable after a context rejection (no bench)', async () => {
    chatCompletion.mockRejectedValueOnce(CONTEXT_ERROR).mockResolvedValueOnce(GOOD_RESULT);

    const first = await post(app, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }, key);
    expect(first.status).toBe(413);

    const second = await post(app, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }, key);
    expect(second.status).toBe(200);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('recurring bare-429s are rewritten into a context 413 when a ping probe proves the key healthy', async () => {
    chatCompletion.mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), { status: 429 }));
    chatCompletion.mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), { status: 429 }));
    mockProbeCooldownKeys.mockResolvedValue({ target: {}, available: true } as any);
    chatCompletion.mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), { status: 429 }));

    const clearCooldowns = () => {
      _clearInMemoryRateLimitStateForTest();
      getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    };

    const r1 = await post(app, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }, key);
    clearCooldowns();
    const r2 = await post(app, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }, key);
    clearCooldowns();
    const r3 = await post(app, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }, key);

    expect(r1.status).toBe(429);
    expect(r2.status).toBe(429);
    expect(r3.status).toBe(413);
    expect(r3.body.error.code).toBe('context_length_exceeded');
    expect(mockProbeCooldownKeys).toHaveBeenCalledTimes(1);
    const cooldownsAfterProbe = getDb().prepare('SELECT platform, key_id FROM rate_limit_cooldowns').all();
    expect(cooldownsAfterProbe).toHaveLength(0);
  });

  it('believes the 429 and keeps the normal bench when the probe does not pass', async () => {
    chatCompletion.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { status: 429 }));
    mockProbeCooldownKeys.mockResolvedValue(null);

    const clearCooldowns = () => {
      _clearInMemoryRateLimitStateForTest();
      getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    };

    const r1 = await post(app, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }, key);
    clearCooldowns();
    const r2 = await post(app, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }, key);
    clearCooldowns();
    const r3 = await post(app, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }, key);

    expect(r1.status).toBe(429);
    expect(r2.status).toBe(429);
    expect(r3.status).toBe(429);
    expect(mockProbeCooldownKeys).toHaveBeenCalled();
  });
});