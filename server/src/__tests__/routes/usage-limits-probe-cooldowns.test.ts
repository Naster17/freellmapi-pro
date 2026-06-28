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
const { initDb, getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setCooldown } = await import('../../services/ratelimit.js');
const { mintDashboardToken, isGatedApiPath } = await import('../helpers/auth.js');

let dashToken = '';

async function post(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

describe('POST /api/usage-limits/probe-cooldowns', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    const db = getDb();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare("DELETE FROM models WHERE platform = 'groq'").run();
    db.prepare("DELETE FROM api_keys WHERE platform = 'groq'").run();

    const { encrypted, iv, authTag } = encrypt('test-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'probe-test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES ('groq', 'm1', 'M1', 1, 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO fallback_config (model_db_id, priority, enabled)
      SELECT id, 1, 1 FROM models WHERE platform = 'groq'
    `).run();
  });

  it('returns probed=0 and no recovered keys when there are no (key, model) pairs to test', async () => {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = \'groq\')').run();
    db.prepare("DELETE FROM models WHERE platform = 'groq'").run();
    const { status, body } = await post(app, '/api/usage-limits/probe-cooldowns');
    expect(status).toBe(200);
    expect(body).toMatchObject({ probed: 0, recovered: [], newlyCooled: [], stillCooled: 0, timedOut: false });
    expect(typeof body.generatedAt).toBe('string');
  });

  it('clears the existing cooldown and reports the pair as recovered when the probe succeeds', async () => {
    const db = getDb();
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'groq'").get() as { id: number }).id;

    setCooldown('groq', 'm1', keyId, 5 * 60_000, 'rate_limited');
    chatCompletion.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });

    const { status, body } = await post(app, '/api/usage-limits/probe-cooldowns');
    expect(status).toBe(200);
    expect(body.probed).toBe(1);
    expect(body.recovered).toEqual([{ platform: 'groq', modelId: 'm1', keyId }]);
    expect(body.newlyCooled).toEqual([]);
    expect(body.stillCooled).toBe(0);
    expect(body.timedOut).toBe(false);
  });

  it('writes a fresh cooldown row when the probe still hits a 429', async () => {
    const db = getDb();
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'groq'").get() as { id: number }).id;

    chatCompletion.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));

    const { status, body } = await post(app, '/api/usage-limits/probe-cooldowns');
    expect(status).toBe(200);
    expect(body.probed).toBe(1);
    expect(body.recovered).toEqual([]);
    expect(body.newlyCooled).toEqual([{ platform: 'groq', modelId: 'm1', keyId, reason: 'rate_limited' }]);
    expect(body.stillCooled).toBe(0);
  });
});
