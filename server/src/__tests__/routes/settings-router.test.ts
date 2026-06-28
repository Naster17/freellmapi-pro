import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

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

describe('GET/PUT /api/settings/router', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM settings WHERE key IN ('router_probe_on_cooldown', 'router_strict_chain')").run();
  });

  afterAll(() => {
    getDb().prepare("DELETE FROM settings WHERE key IN ('router_probe_on_cooldown', 'router_strict_chain')").run();
  });

  it('returns the defaults when nothing is saved', async () => {
    const res = await request(app, 'GET', '/api/settings/router');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ probeOnCooldown: true, strictChain: true });
  });

  it('persists a PUT of both flags', async () => {
    const res = await request(app, 'PUT', '/api/settings/router', { probeOnCooldown: false, strictChain: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ probeOnCooldown: false, strictChain: false });

    const get = await request(app, 'GET', '/api/settings/router');
    expect(get.body).toEqual({ probeOnCooldown: false, strictChain: false });
  });

  it('accepts a partial update (just one flag)', async () => {
    await request(app, 'PUT', '/api/settings/router', { strictChain: false });

    const res = await request(app, 'PUT', '/api/settings/router', { probeOnCooldown: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ probeOnCooldown: false, strictChain: false });
  });

  it('rejects non-boolean values', async () => {
    const res = await request(app, 'PUT', '/api/settings/router', { probeOnCooldown: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });
});
