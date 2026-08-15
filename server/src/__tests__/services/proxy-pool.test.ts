import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../lib/proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/proxy.js')>();
  return { ...actual, proxyFetchVia: vi.fn() };
});

import { initDb, getDb } from '../../db/index.js';
import * as proxyPool from '../../services/proxy-pool.js';
import { proxyFetchVia } from '../../lib/proxy.js';

const mockedProbe = vi.mocked(proxyFetchVia);

function okResponse(status = 204): Response {
  return { status } as Response;
}

function seedProxy(id: number, status: proxyPool.ProxyStatus, latency: number | null): void {
  getDb().prepare(`
    UPDATE proxies SET status = ?, latency_ms = ? WHERE id = ?
  `).run(status, latency, id);
}

describe('proxy pool (#821)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    proxyPool.resetProxyPoolStateForTests();
    getDb().prepare('DELETE FROM proxies').run();
    mockedProbe.mockReset();
  });

  describe('address parsing', () => {
    it('parses host:port', () => {
      expect(proxyPool.parseProxyAddress('127.0.0.1:1080')).toEqual({ host: '127.0.0.1', port: 1080 });
    });

    it('parses user:pass@host:port and a plain user@host:port', () => {
      expect(proxyPool.parseProxyAddress('user:secret@proxy.example:3128'))
        .toEqual({ host: 'proxy.example', port: 3128, username: 'user', password: 'secret' });
      expect(proxyPool.parseProxyAddress('bob@proxy.example:1080'))
        .toEqual({ host: 'proxy.example', port: 1080, username: 'bob' });
    });

    it('strips a leading scheme and trailing slashes', () => {
      expect(proxyPool.parseProxyAddress('socks5://proxy.example:1080/'))
        .toEqual({ host: 'proxy.example', port: 1080 });
    });

    it('parses bracketed IPv6 hosts', () => {
      expect(proxyPool.parseProxyAddress('[::1]:1080')).toEqual({ host: '::1', port: 1080 });
    });

    it('rejects a missing or invalid port', () => {
      expect(() => proxyPool.parseProxyAddress('proxy.example')).toThrow();
      expect(() => proxyPool.parseProxyAddress('proxy.example:0')).toThrow();
      expect(() => proxyPool.parseProxyAddress('proxy.example:99999')).toThrow();
    });
  });

  describe('CRUD', () => {
    it('builds a URL with encrypted credentials round-tripped', () => {
      const row = proxyPool.createProxy({ type: 'socks5', address: 'user:secret@1.2.3.4:1080', label: 'home' });
      expect(row.host).toBe('1.2.3.4');
      expect(row.port).toBe(1080);
      expect(row.encrypted_password).toBeTruthy();
      expect(proxyPool.buildProxyUrl(row)).toBe('socks5://user:secret@1.2.3.4:1080');

      const listed = proxyPool.listProxies();
      expect(listed).toHaveLength(1);
      expect(proxyPool.buildProxyUrl(listed[0]!)).toBe('socks5://user:secret@1.2.3.4:1080');
    });

    it('updates label/enabled and can clear credentials by re-adding an address', () => {
      const row = proxyPool.createProxy({ type: 'http', address: 'user:secret@host:8080' });
      const updated = proxyPool.updateProxy(row.id, { label: 'corp', enabled: false });
      expect(updated.label).toBe('corp');
      expect(updated.enabled).toBe(0);

      const cleared = proxyPool.updateProxy(row.id, { address: 'host:8080' });
      expect(cleared.username).toBeNull();
      expect(proxyPool.buildProxyUrl(cleared)).toBe('http://host:8080');
    });

    it('deletes a proxy', () => {
      const row = proxyPool.createProxy({ type: 'socks4', address: 'host:1080' });
      proxyPool.deleteProxy(row.id);
      expect(proxyPool.listProxies()).toHaveLength(0);
      expect(proxyPool.getProxy(row.id)).toBeUndefined();
    });
  });

  describe('rate-limit escalation', () => {
    it('assigns the lowest-latency healthy proxy after 5 rate limits, then rotates on each further burst', () => {
      const a = proxyPool.createProxy({ type: 'http', address: 'a:8080' });
      const b = proxyPool.createProxy({ type: 'http', address: 'b:8080' });
      const c = proxyPool.createProxy({ type: 'http', address: 'c:8080' });
      seedProxy(a.id, 'healthy', 50);
      seedProxy(b.id, 'healthy', 100);
      seedProxy(c.id, 'healthy', 200);
      proxyPool.initProxyPool();

      for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('google');
      expect(proxyPool.getProxyForPlatform('google')?.id).toBe(a.id);

      for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('google');
      expect(proxyPool.getProxyForPlatform('google')?.id).toBe(b.id);

      for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('google');
      expect(proxyPool.getProxyForPlatform('google')?.id).toBe(c.id);

      const activity = proxyPool.getProxyActivity();
      const kinds = activity.events.map(e => e.kind);
      expect(kinds).toEqual(['rotated', 'rotated', 'assigned']);
      expect(activity.events[0]).toMatchObject({ platform: 'google', proxyId: c.id, kind: 'rotated' });
      expect(activity.events[2]).toMatchObject({ platform: 'google', proxyId: a.id, kind: 'assigned' });
    });

    it('stays on the last proxy when the pool is exhausted', () => {
      const a = proxyPool.createProxy({ type: 'http', address: 'a:8080' });
      seedProxy(a.id, 'healthy', 50);
      proxyPool.initProxyPool();

      for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('groq');
      for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('groq');
      expect(proxyPool.getProxyForPlatform('groq')?.id).toBe(a.id);
      expect(proxyPool.getProxyActivity().events.filter(e => e.kind === 'assigned')).toHaveLength(1);
    });

    it('never assigns a proxy marked error', () => {
      const dead = proxyPool.createProxy({ type: 'http', address: 'dead:8080' });
      seedProxy(dead.id, 'error', null);
      const fine = proxyPool.createProxy({ type: 'http', address: 'fine:8080' });
      seedProxy(fine.id, 'healthy', 90);
      proxyPool.initProxyPool();

      for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('cerebras');
      expect(proxyPool.getProxyForPlatform('cerebras')?.id).toBe(fine.id);
    });

    it('disabling a proxy releases providers assigned to it', () => {
      const a = proxyPool.createProxy({ type: 'http', address: 'a:8080' });
      seedProxy(a.id, 'healthy', 50);
      proxyPool.initProxyPool();
      for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('mistral');
      expect(proxyPool.getProxyForPlatform('mistral')?.id).toBe(a.id);

      proxyPool.updateProxy(a.id, { enabled: false });
      expect(proxyPool.getProxyForPlatform('mistral')).toBeUndefined();
      const kinds = proxyPool.getProxyActivity().events.map(e => e.kind);
      expect(kinds).toContain('released');
    });

    it('the platform resolver returns the assigned proxy URL only for that platform', () => {
      const a = proxyPool.createProxy({ type: 'socks5', address: 'proxy:1080' });
      seedProxy(a.id, 'healthy', 40);
      proxyPool.initProxyPool();
      for (let i = 0; i < 5; i++) proxyPool.noteProxyRateLimit('openrouter');

      const resolver = proxyPool.getProxyForPlatform('openrouter')!;
      expect(proxyPool.buildProxyUrl(resolver)).toBe('socks5://proxy:1080');
      expect(proxyPool.getProxyForPlatform('google')).toBeUndefined();
    });
  });

  describe('health probe', () => {
    it('marks a proxy healthy with its measured latency', async () => {
      const row = proxyPool.createProxy({ type: 'socks5', address: 'proxy:1080' });
      mockedProbe.mockResolvedValue(okResponse(204));
      const result = await proxyPool.checkProxy(row.id);
      expect(result.status).toBe('healthy');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.lastError).toBeNull();
      expect(proxyPool.getProxy(row.id)?.status).toBe('healthy');
    });

    it('marks a proxy error and keeps latency null when the probe fails', async () => {
      const row = proxyPool.createProxy({ type: 'http', address: 'dead:8080' });
      mockedProbe.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const result = await proxyPool.checkProxy(row.id);
      expect(result.status).toBe('error');
      expect(result.latencyMs).toBeNull();
      expect(proxyPool.getProxy(row.id)?.last_error).toContain('Connection refused');
    });

    it('describes a MITM TLS failure as a cert interception rather than a crash', async () => {
      const row = proxyPool.createProxy({ type: 'socks5', address: 'mitm:1080' });
      mockedProbe.mockRejectedValue(new Error('unable to verify the first certificate'));
      const result = await proxyPool.checkProxy(row.id);
      expect(result.status).toBe('error');
      expect(proxyPool.getProxy(row.id)?.last_error).toContain('self-signed');
    });

    it('tries the next probe target when an earlier one answers 4xx/5xx', async () => {
      const row = proxyPool.createProxy({ type: 'http', address: 'a:8080' });
      const blocked = { status: 400 } as Response;
      mockedProbe
        .mockResolvedValueOnce(blocked)
        .mockResolvedValueOnce(okResponse(204));
      const result = await proxyPool.checkProxy(row.id);
      expect(mockedProbe).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('healthy');
    });

    it('still fails the proxy when every probe target errors the same way', async () => {
      const row = proxyPool.createProxy({ type: 'http', address: 'dead:8080' });
      mockedProbe.mockRejectedValue(new Error('connect ETIMEDOUT'));
      const result = await proxyPool.checkProxy(row.id);
      expect(result.status).toBe('error');
      expect(proxyPool.getProxy(row.id)?.last_error).toContain('Timed out');
    });

    it('aborts move on to the next probe target instead of failing the proxy', async () => {
      const row = proxyPool.createProxy({ type: 'socks5', address: 'slow:1080' });
      const abortErr = new Error('The operation was aborted') as Error & { name: string };
      abortErr.name = 'AbortError';
      mockedProbe
        .mockRejectedValueOnce(abortErr)
        .mockResolvedValueOnce(okResponse(204));
      const result = await proxyPool.checkProxy(row.id);
      expect(result.status).toBe('healthy');
    });

    it('checkAllProxies probes every row concurrently', async () => {
      const a = proxyPool.createProxy({ type: 'http', address: 'a:8080' });
      const b = proxyPool.createProxy({ type: 'http', address: 'b:8080' });
      mockedProbe.mockResolvedValue(okResponse(204));
      const results = await proxyPool.checkAllProxies();
      expect(results).toHaveLength(2);
      expect(new Set(results.map(r => r.id))).toEqual(new Set([a.id, b.id]));
    });
  });
});