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
    getDb().prepare("DELETE FROM settings WHERE key IN ('proxy_miner_enabled', 'proxy_miner_keep_best', 'proxy_pool_rate_limit_threshold', 'proxy_pool_direct_platforms')").run();
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

  it('deletes unchecked and error proxies, keeps healthy and disabled-but-healthy ones', async () => {
    const on = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'socks5', address: 'on:1080' },
    });
    const off = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'socks5', address: 'off:1080' },
    });
    const fresh = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'socks5', address: 'fresh:1080' },
    });
    const broken = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'socks5', address: 'broken:1080' },
    });
    await request(app, 'PATCH', `/api/proxies/${off.body.proxy.id}`, {
      token: dashToken, body: { enabled: false },
    });
    getDb().prepare("UPDATE proxies SET status = 'healthy', latency_ms = 20 WHERE id = ?").run(on.body.proxy.id);
    getDb().prepare("UPDATE proxies SET status = 'healthy', latency_ms = 20 WHERE id = ?").run(off.body.proxy.id);
    getDb().prepare("UPDATE proxies SET status = 'error', last_error = 'boom' WHERE id = ?").run(broken.body.proxy.id);
    const del = await request(app, 'DELETE', '/api/proxies/inactive', { token: dashToken });
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(2);
    const list = await request(app, 'GET', '/api/proxies', { token: dashToken });
    expect(list.body.proxies.map((p: any) => p.id).sort((a: number, b: number) => a - b))
      .toEqual([on.body.proxy.id, off.body.proxy.id].sort((a: number, b: number) => a - b));
    expect(fresh.body.proxy.id).not.toBe(on.body.proxy.id);
  });

  it('exposes miner settings with safe defaults and validates updates', async () => {
    const get = await request(app, 'GET', '/api/proxies/miner', { token: dashToken });
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ enabled: false, keepBest: 30, batchSize: 50, maxLatencyMs: 8000, mineTypes: ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'], rateLimitThreshold: 5, rateLimitDisableAfter: 3, mining: false, directPlatforms: [] });

    const put = await request(app, 'PUT', '/api/proxies/miner', {
      token: dashToken, body: { enabled: true, keepBest: 10, batchSize: 12, maxLatencyMs: 1500, mineTypes: ['socks5', 'http'], rateLimitThreshold: 3, rateLimitDisableAfter: 2 },
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ enabled: true, keepBest: 10, batchSize: 12, maxLatencyMs: 1500, mineTypes: ['socks5', 'http'], rateLimitThreshold: 3, rateLimitDisableAfter: 2, mining: false, directPlatforms: [] });

    const bad = await request(app, 'PUT', '/api/proxies/miner', {
      token: dashToken, body: { keepBest: 0 },
    });
    expect(bad.status).toBe(400);

    const badBatch = await request(app, 'PUT', '/api/proxies/miner', {
      token: dashToken, body: { batchSize: 'many' },
    });
    expect(badBatch.status).toBe(400);

    const badLatency = await request(app, 'PUT', '/api/proxies/miner', {
      token: dashToken, body: { maxLatencyMs: -50 },
    });
    expect(badLatency.status).toBe(400);

    const badDisable = await request(app, 'PUT', '/api/proxies/miner', {
      token: dashToken, body: { rateLimitDisableAfter: 0 },
    });
    expect(badDisable.status).toBe(400);

    const badTypes = await request(app, 'PUT', '/api/proxies/miner', {
      token: dashToken, body: { mineTypes: [] },
    });
    expect(badTypes.status).toBe(400);

    const badType = await request(app, 'PUT', '/api/proxies/miner', {
      token: dashToken, body: { mineTypes: ['quic'] },
    });
    expect(badType.status).toBe(400);

    const platforms = await request(app, 'PUT', '/api/proxies/miner', {
      token: dashToken, body: { directPlatforms: ['opencode', 'groq'] },
    });
    expect(platforms.status).toBe(200);
    expect(platforms.body.directPlatforms).toEqual(['opencode', 'groq']);

    const badPlatforms = await request(app, 'PUT', '/api/proxies/miner', {
      token: dashToken, body: { directPlatforms: ['no way!'] },
    });
    expect(badPlatforms.status).toBe(400);
  });

  it('deletes every disabled proxy via DELETE /api/proxies/disabled', async () => {
    const on = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'http', address: 'keep:8080' },
    });
    const off = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'http', address: 'drop:8080' },
    });
    await request(app, 'PATCH', `/api/proxies/${off.body.proxy.id}`, {
      token: dashToken, body: { enabled: false },
    });
    const del = await request(app, 'DELETE', '/api/proxies/disabled', { token: dashToken });
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(1);
    const list = await request(app, 'GET', '/api/proxies', { token: dashToken });
    expect(list.body.proxies.map((p: any) => p.id)).toEqual([on.body.proxy.id]);
  });

  it('deletes every proxy via DELETE /api/proxies', async () => {
    const first = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'http', address: 'gone-a:8080' },
    });
    const second = await request(app, 'POST', '/api/proxies', {
      token: dashToken, body: { type: 'socks5', address: 'gone-b:1080' },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const del = await request(app, 'DELETE', '/api/proxies', { token: dashToken });
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(2);
    const list = await request(app, 'GET', '/api/proxies', { token: dashToken });
    expect(list.body.proxies).toEqual([]);
  });

  it('reports zen-check status and accepts a trigger', async () => {
    const idle = await request(app, 'GET', '/api/proxies/check-zen', { token: dashToken });
    expect(idle.status).toBe(200);
    expect(idle.body.inFlight).toBe(false);
    const { status, body } = await request(app, 'POST', '/api/proxies/check-zen', { token: dashToken });
    expect(status).toBe(202);
    expect(body.accepted).toBe(true);
  });

  it('accepts a mine trigger', async () => {
    const { status, body } = await request(app, 'POST', '/api/proxies/mine', { token: dashToken });
    expect(status).toBe(202);
    expect(body.accepted).toBe(true);
  });
});