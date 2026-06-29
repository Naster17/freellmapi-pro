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

async function get(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

describe('GET /api/health — cooldown dedup', () => {
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
    db.prepare("DELETE FROM api_keys WHERE platform = 'hf-router'").run();
    db.prepare("DELETE FROM models WHERE platform = 'hf-router'").run();

    const { encrypted, iv, authTag } = encrypt('hf-token');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('hf-router', 'hf-test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);

    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES
        ('hf-router', 'model-a', 'A', 1, 1, 1),
        ('hf-router', 'model-b', 'B', 2, 2, 1),
        ('hf-router', 'model-c', 'C', 3, 3, 1)
    `).run();
  });

  it('returns a single deduped cooldown chip when one key has cooldowns on multiple models with the same reason', async () => {
    const db = getDb();
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'hf-router'").get() as { id: number }).id;
    const oneDay = 24 * 60 * 60_000;
    const now = Date.now();
    setCooldown('hf-router', 'model-a', keyId, oneDay, 'payment_required');
    setCooldown('hf-router', 'model-b', keyId, oneDay, 'payment_required');
    setCooldown('hf-router', 'model-c', keyId, oneDay, 'payment_required');

    const { status, body } = await get(app, '/api/health');
    expect(status).toBe(200);
    const key = body.keys.find((k: any) => k.id === keyId);
    expect(key).toBeDefined();
    expect(key.cooldowns).toHaveLength(1);
    expect(key.cooldowns[0]).toMatchObject({ reason: 'payment_required', modelCount: 3 });
    expect(key.activeCooldowns).toBe(3);
  });

  it('keeps the longest expiry when deduping cooldowns with different expiresAtMs', async () => {
    const db = getDb();
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'hf-router'").get() as { id: number }).id;
    const now = Date.now();
    setCooldown('hf-router', 'model-a', keyId, 60_000, 'rate_limited');
    setCooldown('hf-router', 'model-b', keyId, 5 * 60_000, 'rate_limited');

    const { status, body } = await get(app, '/api/health');
    expect(status).toBe(200);
    const key = body.keys.find((k: any) => k.id === keyId);
    expect(key.cooldowns).toHaveLength(1);
    expect(key.cooldowns[0].modelCount).toBe(2);
    expect(key.cooldowns[0].expiresAtMs - now).toBeGreaterThan(4 * 60_000);
  });

  it('does not dedup cooldowns with different reasons on the same key', async () => {
    const db = getDb();
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'hf-router'").get() as { id: number }).id;
    setCooldown('hf-router', 'model-a', keyId, 60_000, 'rate_limited');
    setCooldown('hf-router', 'model-b', keyId, 60_000, 'payment_required');

    const { status, body } = await get(app, '/api/health');
    expect(status).toBe(200);
    const key = body.keys.find((k: any) => k.id === keyId);
    expect(key.cooldowns).toHaveLength(2);
  });
});
