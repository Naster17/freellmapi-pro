import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../lib/proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/proxy.js')>();
  return { ...actual, proxyFetchVia: vi.fn() };
});

import { initDb, getDb } from '../../db/index.js';
import * as proxyPool from '../../services/proxy-pool.js';
import { checkZenPool, getLastZenCheck } from '../../services/zen-check.js';
import { proxyFetchVia } from '../../lib/proxy.js';

const mockedFetchVia = vi.mocked(proxyFetchVia);

function okJson(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ id: 'msg_x', type: 'message', content: [{ type: 'text', text: 'ok' }] }),
  } as unknown as Response;
}

function errJson(status: number, type: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ type: 'error', error: { type, message: 'limited' } }),
  } as unknown as Response;
}

describe('zen checker', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    proxyPool.resetProxyPoolStateForTests();
    getDb().prepare('DELETE FROM proxies').run();
    mockedFetchVia.mockReset();
  });

  it('disables proxies that answer 429 and keeps the ones that serve', async () => {
    const good = proxyPool.createProxy({ type: 'http', address: 'good:8080' });
    const bad = proxyPool.createProxy({ type: 'http', address: 'bad:8080' });
    getDb().prepare("UPDATE proxies SET status = 'healthy', latency_ms = 50 WHERE id IN (?, ?)").run(good.id, bad.id);
    proxyPool.initProxyPool();
    mockedFetchVia.mockImplementation(async (_url: string, _init?: unknown, proxyUrl?: string) => {
      if (proxyUrl?.includes('bad:8080')) return errJson(429, 'RateLimitError');
      return okJson();
    });
    const summary = await checkZenPool();
    expect(summary.checked).toBe(2);
    expect(summary.served).toBe(1);
    expect(summary.rateLimited).toBe(1);
    expect(summary.disabled).toHaveLength(1);
    expect(proxyPool.getProxy(bad.id)?.enabled).toBe(0);
    expect(proxyPool.getProxy(bad.id)?.last_error).toMatch(/upstream 429/);
    expect(proxyPool.getProxy(good.id)?.enabled).toBe(1);
    expect(getLastZenCheck()?.served).toBe(1);
  });

  it('keeps proxies on non-429 failures but records the loss', async () => {
    const flaky = proxyPool.createProxy({ type: 'http', address: 'flaky:8080' });
    getDb().prepare("UPDATE proxies SET status = 'healthy', latency_ms = 50 WHERE id = ?").run(flaky.id);
    proxyPool.initProxyPool();
    mockedFetchVia.mockResolvedValue(errJson(403, 'FreeTierError'));
    const summary = await checkZenPool();
    expect(summary.checked).toBe(1);
    expect(summary.served).toBe(0);
    expect(summary.rateLimited).toBe(0);
    expect(summary.otherFailed).toBe(1);
    expect(proxyPool.getProxy(flaky.id)?.enabled).toBe(1);
  });

  it('disables proxies that die in transport', async () => {
    const dead = proxyPool.createProxy({ type: 'http', address: 'dead:8080' });
    getDb().prepare("UPDATE proxies SET status = 'healthy', latency_ms = 50 WHERE id = ?").run(dead.id);
    proxyPool.initProxyPool();
    mockedFetchVia.mockRejectedValue(new Error('Proxy connection timed out'));
    const summary = await checkZenPool();
    expect(summary.transportFailed).toBe(1);
    expect(proxyPool.getProxy(dead.id)?.enabled).toBe(0);
  });

  it('skips error and disabled proxies', async () => {
    const off = proxyPool.createProxy({ type: 'http', address: 'off:8080' });
    const err = proxyPool.createProxy({ type: 'http', address: 'err:8080' });
    getDb().prepare("UPDATE proxies SET enabled = 0 WHERE id = ?").run(off.id);
    getDb().prepare("UPDATE proxies SET status = 'error' WHERE id = ?").run(err.id);
    proxyPool.initProxyPool();
    mockedFetchVia.mockResolvedValue(okJson());
    const summary = await checkZenPool();
    expect(summary.checked).toBe(0);
    expect(mockedFetchVia).not.toHaveBeenCalled();
  });
});
