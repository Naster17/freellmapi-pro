import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../lib/proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/proxy.js')>();
  return { ...actual, proxyFetchVia: vi.fn() };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import * as proxyPool from '../../services/proxy-pool.js';
import { proxyFetchVia } from '../../lib/proxy.js';

const mockedProbe = vi.mocked(proxyFetchVia);

let dashToken = '';
let app: Express;

async function request(
  expressApp: Express,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
) {
  const server = expressApp.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

describe('proxy pool routes (#821)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('proxies@example.com');
  });

  beforeEach(() => {
    proxyPool.resetProxyPoolStateForTests();
    getDb().prepare('DELETE FROM proxies').run();
    mockedProbe.mockReset();
  });

  it('lists proxies, empty by default', async () => {
    const { status, body } = await request(app, 'GET', '/api/proxies', { token: dashToken });
    expect(status).toBe(200);
    expect(body.proxies).toEqual([]);
  });

  it('creates a proxy and never returns its credentials', async () => {
    const { status, body } = await request(app, 'POST', '/api/proxies', {
      token: dashToken,
      body: { type: 'socks5', address: 'user:secret@127.0.0.1:1080', label: 'privacy' },
    });
    expect(status).toBe(201);
    expect(body.proxy).toMatchObject({ type: 'socks5', address: '127.0.0.1:1080', hasAuth: true, label: 'privacy', enabled: true, status: 'unknown' });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('rejects a proxy without a port', async () => {
    const { status } = await request(app, 'POST', '/api/proxies', {
      token: dashToken,
      body: { type: 'http', address: 'nodots' },
    });
    expect(status).toBe(400);
  });

  it('toggles enabled and deletes', async () => {
    const created = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'http', address: 'proxy.corp:8080' },
    });
    const id = created.body.proxy.id;

    const patched = await request(app, 'PATCH', `/api/proxies/${id}`, {
      token: dashToken, body: { enabled: false, label: 'corp' },
    });
    expect(patched.body.proxy.enabled).toBe(false);
    expect(patched.body.proxy.label).toBe('corp');

    const del = await request(app, 'DELETE', `/api/proxies/${id}`, { token: dashToken });
    expect(del.status).toBe(200);
    expect((await request(app, 'GET', '/api/proxies', { token: dashToken })).body.proxies).toEqual([]);
    expect((await request(app, 'DELETE', `/api/proxies/${id}`, { token: dashToken })).status).toBe(404);
  });

  it('check-all is accepted and probes every proxy', async () => {
    await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'http', address: 'a:8080' },
    });
    await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'http', address: 'b:8080' },
    });
    mockedProbe.mockResolvedValue({ status: 204 } as Response);
    const { status, body } = await request(app, 'POST', '/api/proxies/check-all', { token: dashToken });
    expect(status).toBe(202);
    expect(body.accepted).toBe(true);
    await vi.waitFor(async () => {
      const list = await request(app, 'GET', '/api/proxies', { token: dashToken });
      expect(list.body.proxies.every((p: any) => p.status === 'healthy')).toBe(true);
    });
  });

  it('check on a single proxy returns its verdict', async () => {
    const created = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'socks5', address: 'fast:1080' },
    });
    mockedProbe.mockRejectedValue(new Error('timeout'));
    const { status, body } = await request(app, 'POST', `/api/proxies/${created.body.proxy.id}/check`, { token: dashToken });
    expect(status).toBe(200);
    expect(body.result.status).toBe('error');
    expect(body.result.latencyMs).toBeNull();
  });

  it('exposes assignments and activity events', async () => {
    const created = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'http', address: 'x:8080' },
    });
    getDb().prepare('UPDATE proxies SET status = ?, latency_ms = ? WHERE id = ?')
      .run('healthy', 42, created.body.proxy.id);
    proxyPool.initProxyPool();
    for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('google');

    const { body } = await request(app, 'GET', '/api/proxies/activity', { token: dashToken });
    expect(body.assignments[0]).toMatchObject({ platform: 'google' });
    expect(body.assignments[0].proxy.id).toBe(created.body.proxy.id);
    expect(body.events[0]).toMatchObject({ kind: 'assigned', platform: 'google' });
  });

  it('requires dashboard auth', async () => {
    expect((await request(app, 'GET', '/api/proxies')).status).toBe(401);
  });
});