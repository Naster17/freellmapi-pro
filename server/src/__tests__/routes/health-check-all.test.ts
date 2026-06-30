import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

vi.mock('../../lib/network.js', () => ({
  hasNetwork: vi.fn().mockResolvedValue(true),
}));

const { createApp } = await import('../../app.js');
const { initDb, getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { mintDashboardToken, isGatedApiPath } = await import('../helpers/auth.js');
const { _resetInFlightForTests } = await import('../../services/health.js');

let dashToken = '';
let app: Express;

async function post(path: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  const addr = server.address() as any;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method: 'POST',
      headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  const addr = server.address() as any;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('POST /api/health/check-all', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterAll(() => {
    _resetInFlightForTests();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    const enc = encrypt('test-key');
    db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status) VALUES (?, ?, ?, ?, ?, 1, 'healthy')`)
      .run('groq', 'g1', enc.encrypted, enc.iv, enc.authTag);
    _resetInFlightForTests();
  });

  it('returns 202 immediately and reports the startedAt timestamp', async () => {
    const { status, body } = await post('/api/health/check-all');
    expect(status).toBe(202);
    expect(body).toMatchObject({ accepted: true, alreadyInFlight: false });
    expect(typeof body.startedAt).toBe('number');
  });

  it('reports alreadyInFlight=true on a second call while a check is still running', async () => {
    const first = await post('/api/health/check-all');
    expect(first.status).toBe(202);
    expect(first.body.alreadyInFlight).toBe(false);

    const second = await post('/api/health/check-all');
    expect(second.status).toBe(202);
    expect(second.body.alreadyInFlight).toBe(true);
  });

  it('GET /api/health exposes checkAllInFlight to the dashboard', async () => {
    const before = await get('/api/health');
    expect(before.body.checkAllInFlight).toBe(false);
    expect(before.body.checkAllStartedAt).toBeNull();

    await post('/api/health/check-all');

    const during = await get('/api/health');
    expect(during.body.checkAllInFlight).toBe(true);
    expect(typeof during.body.checkAllStartedAt).toBe('number');
  });
});
