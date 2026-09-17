import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../lib/proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/proxy.js')>();
  return { ...actual, proxyFetchVia: vi.fn() };
});

import { initDb, getDb } from '../../db/index.js';
import * as proxyPool from '../../services/proxy-pool.js';
import { minePublicProxies, getMinerKeepBest, setMinerKeepBest, getMinerBatchSize, setMinerBatchSize, getMinerMaxLatencyMs, setMinerMaxLatencyMs } from '../../services/proxy-miner.js';
import { proxyFetchVia } from '../../lib/proxy.js';

const mockedProbe = vi.mocked(proxyFetchVia);

function okResponse(status = 204): Response {
  return { status } as Response;
}

function listFetch(text: string, status = 200): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) })) as unknown as typeof fetch;
}

describe('public proxy miner', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    proxyPool.resetProxyPoolStateForTests();
    getDb().prepare('DELETE FROM proxies').run();
    getDb().prepare("DELETE FROM settings WHERE key IN ('proxy_miner_enabled', 'proxy_miner_keep_best', 'proxy_miner_batch_size', 'proxy_miner_max_latency_ms', 'proxy_miner_types', 'proxy_pool_rate_limit_threshold')").run();
    mockedProbe.mockReset();
    mockedProbe.mockResolvedValue(okResponse());
  });

  it('imports plaintext lists, probes them, and deletes the dead immediately', async () => {
    mockedProbe.mockImplementation(async (_url: string, _init?: unknown, proxyUrl?: string) => {
      if (proxyUrl?.includes('1.1.1.1')) {
        await new Promise(r => setTimeout(r, 30));
        return okResponse();
      }
      if (proxyUrl?.includes('2.2.2.2')) return okResponse();
      throw new Error('Connection refused');
    });
    const fetchImpl = listFetch('1.1.1.1:1080\n2.2.2.2:1080\n3.3.3.3:1080\nnot-a-proxy\n');
    const summary = await minePublicProxies(fetchImpl);
    expect(summary.sourcesOk).toBeGreaterThan(0);
    expect(summary.added).toBe(3);
    expect(summary.healthy).toBe(2);
    expect(summary.kept).toBe(2);
    expect(summary.removed).toBe(1);
    const rows = proxyPool.listProxies();
    expect(rows).toHaveLength(2);
    expect(rows.every(r => (r.source ?? 'manual') === 'public')).toBe(true);
    const byHost = new Map(rows.map(r => [r.host, r]));
    expect(byHost.get('1.1.1.1')?.enabled).toBe(1);
    expect(byHost.get('2.2.2.2')?.enabled).toBe(1);
    expect(byHost.has('3.3.3.3')).toBe(false);
  });

  it('tests at most 50 random candidates per run', async () => {
    const lines = Array.from({ length: 70 }, (_, i) => `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}:1080`).join('\n');
    const summary = await minePublicProxies(listFetch(lines));
    expect(summary.fetched).toBe(70);
    expect(summary.added).toBeLessThanOrEqual(50);
    expect(proxyPool.listProxies().length).toBeLessThanOrEqual(50);
  });

  it('trims previously kept public proxies beyond keep-best to the fastest', async () => {
    const { setMinerKeepBest } = await import('../../services/proxy-miner.js');
    setMinerKeepBest(5);
    mockedProbe.mockImplementation(async (_url: string, _init?: unknown, proxyUrl?: string) => {
      if (proxyUrl?.includes('10.9.')) return okResponse();
      throw new Error('Connection refused');
    });
    const lines = Array.from({ length: 8 }, (_, i) => `10.9.0.${i + 1}:1080`).join('\n');
    const summary = await minePublicProxies(listFetch(lines));
    expect(summary.kept).toBe(5);
    const rows = proxyPool.listProxies();
    expect(rows).toHaveLength(5);
    expect(rows.every(r => r.enabled === 1)).toBe(true);
  });

  it('skips duplicates of already-known proxies', async () => {
    proxyPool.createProxy({ type: 'socks5', address: '9.9.9.9:1080' });
    const summary = await minePublicProxies(listFetch('9.9.9.9:1080\n8.8.8.8:1080\n'));
    expect(summary.added).toBe(1);
    expect(proxyPool.listProxies()).toHaveLength(2);
  });

  it('records failed lists without failing the run', async () => {
    const summary = await minePublicProxies(listFetch('nope', 500));
    expect(summary.sourcesFailed).toBeGreaterThan(0);
    expect(summary.added).toBe(0);
    expect(summary.errors.length).toBeGreaterThan(0);
  });

  it('validates the keep-best window', () => {
    expect(getMinerKeepBest()).toBe(30);
    setMinerKeepBest(10);
    expect(getMinerKeepBest()).toBe(10);
    setMinerKeepBest(500);
    expect(getMinerKeepBest()).toBe(500);
    expect(() => setMinerKeepBest(0)).toThrow();
    expect(() => setMinerKeepBest(Number.NaN)).toThrow();
  });

  it('validates the per-run batch size', () => {
    expect(getMinerBatchSize()).toBe(50);
    setMinerBatchSize(12);
    expect(getMinerBatchSize()).toBe(12);
    setMinerBatchSize(300);
    expect(getMinerBatchSize()).toBe(300);
    expect(() => setMinerBatchSize(0)).toThrow();
  });

  it('validates the max-latency ceiling', () => {
    expect(getMinerMaxLatencyMs()).toBe(8000);
    setMinerMaxLatencyMs(1500);
    expect(getMinerMaxLatencyMs()).toBe(1500);
    expect(() => setMinerMaxLatencyMs(-5)).toThrow();
  });

  it('parses schemed lines and drops unroutable 0.0.0.0 entries', async () => {
    const summary = await minePublicProxies(listFetch('socks5://9.9.9.9:1080\n0.0.0.0:80\n8.8.8.8:1080\nnot-a-proxy\n'));
    expect(summary.added).toBe(2);
    expect(summary.fetched).toBe(2);
    const rows = proxyPool.listProxies();
    expect(rows.map(r => r.host).sort()).toEqual(['8.8.8.8', '9.9.9.9']);
  });

  it('mines only the enabled proxy types', async () => {
    const { getMinerTypes, setMinerTypes } = await import('../../services/proxy-miner.js');
    expect(getMinerTypes()).toEqual(['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h']);
    setMinerTypes(['http']);
    expect(getMinerTypes()).toEqual(['http']);
    expect(() => setMinerTypes([])).toThrow();
    expect(() => setMinerTypes(['quic'])).toThrow();
    setMinerTypes(['socks4a']);
    const summary = await minePublicProxies(listFetch('1.2.3.4:1080\n'));
    expect(summary.added).toBe(0);
    expect(summary.fetched).toBe(0);
  });

  it('drops finds slower than the latency ceiling even when within keep-best', async () => {
    setMinerMaxLatencyMs(1000);
    mockedProbe.mockImplementation(async (_url: string, _init?: unknown, proxyUrl?: string) => {
      if (proxyUrl?.includes('10.20.0.1')) return okResponse();
      if (proxyUrl?.includes('10.20.0.2')) {
        await new Promise(r => setTimeout(r, 1200));
        return okResponse();
      }
      throw new Error('Connection refused');
    });
    const summary = await minePublicProxies(listFetch('10.20.0.1:1080\n10.20.0.2:1080\n10.20.0.3:1080\n'));
    expect(summary.healthy).toBe(2);
    expect(summary.tooSlow).toBe(1);
    expect(summary.kept).toBe(1);
    const rows = proxyPool.listProxies();
    expect(rows).toHaveLength(1);
    expect(rows[0].host).toBe('10.20.0.1');
    expect(rows[0].enabled).toBe(1);
  });

  it('honors a custom batch size for the random candidate window', async () => {
    setMinerBatchSize(5);
    const lines = Array.from({ length: 20 }, (_, i) => `10.30.0.${i + 1}:1080`).join('\n');
    const summary = await minePublicProxies(listFetch(lines));
    expect(summary.added).toBeLessThanOrEqual(5);
    expect(proxyPool.listProxies().length).toBeLessThanOrEqual(5);
  });

  it('tracks per-proxy quality from probe outcomes', async () => {
    mockedProbe.mockImplementation(async (_url: string, _init?: unknown, proxyUrl?: string) => {
      if (proxyUrl?.includes('10.40.0.1')) return okResponse();
      throw new Error('Connection refused');
    });
    const summary = await minePublicProxies(listFetch('10.40.0.1:1080\n'));
    expect(summary.kept).toBe(1);
    const row = proxyPool.listProxies()[0];
    expect(row.success_count).toBe(1);
    expect(row.failure_count).toBe(0);
    expect(proxyPool.proxyQualityScore({ success_count: row.success_count, failure_count: row.failure_count })).toBeGreaterThan(0.5);
    expect(proxyPool.proxyQualityScore({ success_count: 0, failure_count: 3 })).toBeLessThan(0.5);
    expect(proxyPool.proxyQualityScore({ success_count: 0, failure_count: 0 })).toBe(0.5);
  });

  it('prefers higher-quality proxies over merely faster raw probes when sorting', () => {
    const slow = proxyPool.createProxy({ type: 'socks5', address: '10.50.0.1:1080' });
    const fast = proxyPool.createProxy({ type: 'socks5', address: '10.50.0.2:1080' });
    getDb().prepare("UPDATE proxies SET status = 'healthy', latency_ms = 4000 WHERE id = ?").run(slow.id);
    getDb().prepare("UPDATE proxies SET status = 'healthy', latency_ms = 50 WHERE id = ?").run(fast.id);
    proxyPool.recordProxyOutcome(fast.id, false);
    proxyPool.recordProxyOutcome(fast.id, false);
    proxyPool.recordProxyOutcome(fast.id, false);
    proxyPool.initProxyPool();
    for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('groq');
    expect(proxyPool.getProxyForPlatform('groq')?.id).toBe(slow.id);
  });

  it('makes the rate-limit threshold tunable with a safe default', () => {
    expect(proxyPool.getProxyRateLimitThreshold()).toBe(5);
    proxyPool.setProxyRateLimitThreshold(3);
    expect(proxyPool.getProxyRateLimitThreshold()).toBe(3);
    expect(() => proxyPool.setProxyRateLimitThreshold(0)).toThrow();
  });

  it('uses enabled public rows even when auto-mining is off (row switch controls traffic)', () => {
    const pub = proxyPool.createProxy({ type: 'socks5', address: '7.7.7.7:1080', source: 'public' });
    getDb().prepare("UPDATE proxies SET status = 'healthy', latency_ms = 10 WHERE id = ?").run(pub.id);
    proxyPool.initProxyPool();
    for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('groq');
    expect(proxyPool.getProxyForPlatform('groq')?.id).toBe(pub.id);
  });
});
