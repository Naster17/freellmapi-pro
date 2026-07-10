import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyProxyUrl,
  applyProxyEnabled,
  flushProxyCache,
  proxyFetch,
} from '../../lib/proxy.js';

describe('proxy cache flush', () => {
  beforeEach(() => {
    delete process.env.PROXY_URL;
    applyProxyEnabled(true);
    applyProxyUrl('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PROXY_URL;
  });

  it('flushProxyCache is callable without error when no proxy configured', () => {
    expect(() => flushProxyCache()).not.toThrow();
  });

  it('forces a fresh dispatcher lookup after flush', async () => {
    applyProxyUrl('http://proxy.example:8080');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    await proxyFetch('https://api.example.com/test', undefined, 'groq');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    flushProxyCache();

    await proxyFetch('https://api.example.com/test2', undefined, 'groq');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
