import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hasNetwork, _resetNetworkCacheForTests } from '../../lib/network.js';

vi.mock('../../lib/proxy.js', () => ({
  proxyFetch: vi.fn(),
}));

import { proxyFetch } from '../../lib/proxy.js';

const mockedFetch = vi.mocked(proxyFetch);

beforeEach(() => {
  _resetNetworkCacheForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetNetworkCacheForTests();
  vi.restoreAllMocks();
});

describe('hasNetwork', () => {
  it('returns true when the probe URL returns a 2xx', async () => {
    mockedFetch.mockResolvedValueOnce({ status: 204 } as Response);
    await expect(hasNetwork({ forceRefresh: true })).resolves.toBe(true);
  });

  it('returns true for any 3xx redirect', async () => {
    mockedFetch.mockResolvedValueOnce({ status: 301 } as Response);
    await expect(hasNetwork({ forceRefresh: true })).resolves.toBe(true);
  });

  it('returns false when the probe URL returns a 5xx', async () => {
    mockedFetch.mockResolvedValueOnce({ status: 503 } as Response);
    await expect(hasNetwork({ forceRefresh: true })).resolves.toBe(false);
  });

  it('returns false when the probe throws (network unreachable)', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(hasNetwork({ forceRefresh: true })).resolves.toBe(false);
  });

  it('caches the result so repeated calls within the TTL do not re-probe', async () => {
    mockedFetch.mockResolvedValueOnce({ status: 204 } as Response);
    await expect(hasNetwork({ forceRefresh: true })).resolves.toBe(true);
    await expect(hasNetwork()).resolves.toBe(true);
    await expect(hasNetwork()).resolves.toBe(true);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh bypasses the cache', async () => {
    mockedFetch.mockResolvedValue({ status: 204 } as Response);
    await hasNetwork({ forceRefresh: true });
    await hasNetwork({ forceRefresh: true });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent probes (in-flight single call)', async () => {
    let resolve: (v: Response) => void = () => {};
    mockedFetch.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
    const a = hasNetwork({ forceRefresh: true });
    const b = hasNetwork({ forceRefresh: true });
    const c = hasNetwork({ forceRefresh: true });
    resolve({ status: 204 } as Response);
    await expect(Promise.all([a, b, c])).resolves.toEqual([true, true, true]);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('probes via the "health" platform so the proxy bypass list is honored', async () => {
    mockedFetch.mockResolvedValueOnce({ status: 204 } as Response);
    await hasNetwork({ forceRefresh: true });
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://www.google.com/generate_204',
      expect.objectContaining({ method: 'GET' }),
      'health',
    );
  });
});
