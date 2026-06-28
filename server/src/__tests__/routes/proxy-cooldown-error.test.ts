import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy, setStrictChain } = await import('../../services/router.js');
const { setCooldown, _clearInMemoryRateLimitStateForTest } = await import('../../services/ratelimit.js');

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json, raw, headers: res.headers };
}

describe('Proxy cooldown error shape (strict chain mode)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    const db = getDb();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    _clearInMemoryRateLimitStateForTest();
    setStrictChain(false);
  });

  it('returns 429 with unavailableModel and cooldown field when an explicit model is on cooldown', async () => {
    const db = getDb();
    const groqKeyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'groq'").get() as { id: number }).id;
    const allGroq = db.prepare("SELECT model_id FROM models WHERE platform = 'groq' AND enabled = 1").all() as { model_id: string }[];
    for (const m of allGroq) {
      setCooldown('groq', m.model_id, groqKeyId, 5 * 60_000, 'rate_limited');
    }
    const pinned = allGroq[0]!;

    const { status, body } = await post(app, '/v1/chat/completions', {
      model: pinned.model_id,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(429);
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toMatch(/rate-limited on every available key/);
    expect(body.error.cooldown).toBeDefined();
    expect(Array.isArray(body.error.cooldown)).toBe(true);
    expect(body.error.cooldown.length).toBeGreaterThan(0);
    expect(body.error.cooldown[0]).toMatchObject({
      platform: 'groq',
      modelId: pinned.model_id,
      reason: 'rate_limited',
    });
    expect(body.error.cooldown[0].remainingSeconds).toBeGreaterThan(0);
    expect(body.error.unavailableModel).toBeDefined();
    expect(body.error.unavailableModel.modelId).toBe(pinned.model_id);
  });

  it('returns 429 for the explicitly pinned model instead of silently routing to the next chain entry when the pinned model is in cooldown', async () => {
    const db = getDb();
    const groqKeyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'groq'").get() as { id: number }).id;
    const pinned = db.prepare("SELECT model_id FROM models WHERE platform = 'groq' AND enabled = 1 ORDER BY intelligence_rank ASC LIMIT 1").get() as { model_id: string };
    setCooldown('groq', pinned.model_id, groqKeyId, 5 * 60_000, 'rate_limited');

    const { status, body } = await post(app, '/v1/chat/completions', {
      model: pinned.model_id,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(429);
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toMatch(/rate-limited on every available key/);
    expect(body.error.unavailableModel).toBeDefined();
    expect(body.error.unavailableModel.modelId).toBe(pinned.model_id);
  });

  it('does not include cooldown field when strict mode is off and the model is not pinned', async () => {
    setStrictChain(false);
    chatCompletion.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('ok');
  });
});
