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

describe('Proxy strict-pin: explicit model requests never silently fail over to a different model', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    const db = getDb();
    setRoutingStrategy('priority');
    const groq = encrypt('groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(groq.encrypted, groq.iv, groq.authTag);
    const cerebras = encrypt('cerebras-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('cerebras', 'test', ?, ?, ?, 'healthy', 1)
    `).run(cerebras.encrypted, cerebras.iv, cerebras.authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    _clearInMemoryRateLimitStateForTest();
    setStrictChain(false);
  });

  it('returns 429 with unavailableModel when the pinned model has no usable key (no silent swap)', async () => {
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
    expect(body.error.unavailableModel).toBeDefined();
    expect(body.error.unavailableModel.modelId).toBe(pinned.model_id);
    expect(body.error.cooldown).toBeDefined();
    expect(body.error.cooldown.length).toBeGreaterThan(0);
  });

  it('serves the pinned model when it has a usable key, never touching the other platform', async () => {
    chatCompletion.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'served by pinned' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const db = getDb();
    const groqTop = db.prepare("SELECT model_id FROM models WHERE platform = 'groq' AND enabled = 1 ORDER BY intelligence_rank ASC LIMIT 1").get() as { model_id: string };
    const { status, body } = await post(app, '/v1/chat/completions', {
      model: groqTop.model_id,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('served by pinned');
  });

  it('serves a model on a different platform when the user requests auto and the first model is cooled', async () => {
    const db = getDb();
    const groqKeyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'groq'").get() as { id: number }).id;
    const groqTop = db.prepare("SELECT model_id FROM models WHERE platform = 'groq' ORDER BY intelligence_rank ASC LIMIT 1").get() as { model_id: string };
    setCooldown('groq', groqTop.model_id, groqKeyId, 5 * 60_000, 'rate_limited');
    db.prepare("UPDATE fallback_config SET priority = 1 WHERE model_db_id = (SELECT id FROM models WHERE platform = ? AND model_id = ?)").run('groq', groqTop.model_id);

    chatCompletion.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'served by cerebras' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('served by cerebras');
  });

  it('returns 429 with unavailableModel on the second attempt too (cooldowns still active), preserving the rich body', async () => {
    const db = getDb();
    const groqKeyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'groq'").get() as { id: number }).id;
    const pinned = db.prepare("SELECT model_id FROM models WHERE platform = 'groq' AND enabled = 1 ORDER BY intelligence_rank ASC LIMIT 1").get() as { model_id: string };
    setCooldown('groq', pinned.model_id, groqKeyId, 5 * 60_000, 'rate_limited');

    const { status, body } = await post(app, '/v1/chat/completions', {
      model: pinned.model_id,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(429);
    expect(body.error.unavailableModel).toBeDefined();
    expect(body.error.unavailableModel.modelId).toBe(pinned.model_id);
    expect(body.error.cooldown).toBeDefined();
  });
});
