import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { setZenKeylessMode, getZenSentinelKeyId, _resetZenKeylessState } from '../../services/zen-keyless.js';
import { encrypt } from '../../lib/crypto.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function insertKey(platform: string, label: string, enabled = 1): number {
  const { encrypted, iv, authTag } = encrypt('dummy-key');
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', ?)
  `).run(platform, label, encrypted, iv, authTag, enabled);
  return Number(result.lastInsertRowid);
}

describe('Keys API zen keyless annotations', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM settings').run();
    _resetZenKeylessState();
  });

  it('flags no key anonymous while zen keyless mode is off', async () => {
    insertKey('groq', 'groq-a');
    insertKey('opencode', 'zen-a');

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    for (const key of body) {
      expect(key.anonymous).toBe(false);
    }
  });

  it('flags only the sentinel key anonymous while zen keyless mode is on', async () => {
    const zenKeyId = insertKey('opencode', 'zen-a');
    insertKey('groq', 'groq-a');

    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);

    const byId = new Map<number, { id: number; anonymous: boolean; enabled: boolean; label: string }>(body.map((k: any) => [k.id, k]));
    expect(byId.get(sentinelId)!.anonymous).toBe(true);
    expect(byId.get(zenKeyId)!.anonymous).toBe(false);
    expect(byId.get(zenKeyId)!.enabled).toBe(false);
    expect(byId.get(sentinelId)!.label).toBe('anon 1');
  });

  it('keeps the sentinel flagged anonymous after the mode is turned off', async () => {
    const zenKeyId = insertKey('opencode', 'zen-a');
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;
    setZenKeylessMode(false);

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);

    const byId = new Map<number, { id: number; anonymous: boolean; enabled: boolean; label: string }>(body.map((k: any) => [k.id, k]));
    expect(byId.get(sentinelId)!.anonymous).toBe(true);
    expect(byId.get(sentinelId)!.enabled).toBe(false);
    expect(byId.get(zenKeyId)!.enabled).toBe(true);
  });
});

describe('DELETE /api/settings/zen-keyless/anon-keys', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM settings').run();
    getDb().prepare('DELETE FROM requests').run();
    _resetZenKeylessState();
  });

  it('removes only anon keys and reports the updated state', async () => {
    const zenKeyId = insertKey('opencode', 'zen-a');
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms)
      VALUES ('opencode', 'mimo-v2.5-free', ?, 'success', 10, 5, 100)
    `).run(sentinelId);

    const { status, body } = await request(app, 'DELETE', '/api/settings/zen-keyless/anon-keys');
    expect(status).toBe(200);
    expect(body).toEqual({
      removed: 1,
      enabled: true,
      sentinelKeyId: null,
      zenKeyCount: 1,
      disabledZenKeyCount: 1,
      anonKeyCount: 0,
    });

    const keysLeft = getDb().prepare('SELECT id, label FROM api_keys ORDER BY id').all() as Array<{ id: number; label: string }>;
    expect(keysLeft).toEqual([{ id: zenKeyId, label: 'zen-a' }]);
    const stats = getDb().prepare(
      "SELECT COUNT(*) AS c FROM requests WHERE key_id = ? AND status = 'success'",
    ).get(sentinelId) as { c: number };
    expect(stats.c).toBe(1);

    const state = await request(app, 'GET', '/api/settings/zen-keyless');
    expect(state.body.anonKeyCount).toBe(0);
  });

  it('returns a zero-removed state when there is nothing to clear', async () => {
    const { status, body } = await request(app, 'DELETE', '/api/settings/zen-keyless/anon-keys');
    expect(status).toBe(200);
    expect(body.removed).toBe(0);
    expect(body.anonKeyCount).toBe(0);
  });
});