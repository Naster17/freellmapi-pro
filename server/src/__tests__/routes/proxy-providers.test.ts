import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function request(app: Express, method: string, path: string, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, { method, headers });
  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('GET /v1/providers', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES
        ('google', 'Google', 'x', 'x', 'x', 'healthy', 1),
        ('mistral', 'Mistral', 'x', 'x', 'x', 'unknown', 1),
        ('nvidia', 'NVIDIA', 'x', 'x', 'x', 'invalid', 1),
        ('groq', 'Groq', 'x', 'x', 'x', 'healthy', 0)
    `).run();
  });

  it('requires the unified API key', async () => {
    const { status, body } = await request(app, 'GET', '/v1/providers');

    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('returns enabled providers with per-status rollups', async () => {
    const { status, body } = await request(app, 'GET', '/v1/providers', authHeaders());

    expect(status).toBe(200);
    expect(body.providers).toHaveLength(3);
    expect(body.providers.find((p: any) => p.platform === 'google')).toMatchObject({ status: 'healthy', keys: 1 });
    expect(body.providers.find((p: any) => p.platform === 'mistral')).toMatchObject({ status: 'unknown', keys: 1 });
    expect(body.providers.find((p: any) => p.platform === 'nvidia')).toMatchObject({ status: 'invalid', keys: 1 });
    expect(body.providers.find((p: any) => p.platform === 'groq')).toBeUndefined();
    expect(body.counts).toEqual({ healthy: 1, rate_limited: 0, invalid: 1, unknown: 1 });
  });
});
