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