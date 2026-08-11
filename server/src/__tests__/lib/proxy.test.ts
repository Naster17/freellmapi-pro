import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import https from 'https';
import {
  applyProxyUrl,
  applyProxyEnabled,
  applyProxyBypass,
  getProxyUrl,
  isProxyEnabled,
  getProxyBypassPlatforms,
  getNoProxyRules,
  isProxyActive,
  isSocksProxyUrl,
  PROXY_SCHEMES,
  proxyFetch,
  describeAbort,
} from '../../lib/proxy.js';

// Every env var the proxy config reads, in both the upper- and lower-case
// spellings the convention allows. Cleared around each test so a developer
// machine that genuinely sits behind a corporate proxy doesn't fail the suite.
const PROXY_ENV_VARS = ['PROXY_URL', 'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

function clearProxyEnv(): void {
  for (const name of PROXY_ENV_VARS) {
    delete process.env[name];
    delete process.env[name.toLowerCase()];
  }
}

// Reset module-level proxy state before each test so cases don't bleed into
// each other (the lib keeps a process-wide config + a short dispatcher cache).
beforeEach(() => {
  clearProxyEnv();
  applyProxyEnabled(true);
  applyProxyBypass('');
  applyProxyUrl(''); // clears the URL and the dispatcher cache
});

afterEach(() => {
  vi.restoreAllMocks();
  clearProxyEnv();
});

const okResponse = () => ({ ok: true, status: 200 }) as Response;

describe('proxy config accessors', () => {
  it('PROXY_URL env wins over the DB value', () => {
    process.env.PROXY_URL = 'http://env-proxy:8080';
    applyProxyUrl('http://db-proxy:3128');
    expect(getProxyUrl()).toBe('http://env-proxy:8080');
  });

  it('falls back to the DB value when no env var is set', () => {
    applyProxyUrl('http://db-proxy:3128');
    expect(getProxyUrl()).toBe('http://db-proxy:3128');
  });

  it('parses the comma-separated bypass list', () => {
    applyProxyBypass('groq, Google ,, cerebras');
    expect(getProxyBypassPlatforms().sort()).toEqual(['cerebras', 'google', 'groq']);
  });

  it('isProxyActive is false when no proxy URL is configured', () => {
    expect(isProxyActive()).toBe(false);
  });

  it('isProxyActive is true when an HTTP proxy is configured and enabled', () => {
    applyProxyUrl('http://proxy:8080');
    expect(isProxyActive()).toBe(true);
  });

  it('isProxyActive is false when a proxy is configured but disabled', () => {
    applyProxyUrl('http://proxy:8080');
    applyProxyEnabled(false);
    expect(isProxyEnabled()).toBe(false);
    expect(isProxyActive()).toBe(false);
  });
});

// #630: `socks5h://` (and its SOCKS4 sibling `socks4a://`) ask the proxy to
// resolve DNS, which is the whole point for users on DNS-poisoned networks.
// Scheme detection used to be `startsWith('socks5:') || startsWith('socks4:')`,
// so socks5h fell through to the undici ProxyAgent — which has no idea what
// SOCKS is — and every request failed. socks-proxy-agent has understood both
// schemes natively all along.
describe('SOCKS scheme detection (#630)', () => {
  it('recognises every SOCKS scheme socks-proxy-agent supports', () => {
    expect(isSocksProxyUrl('socks5://127.0.0.1:1080')).toBe(true);
    expect(isSocksProxyUrl('socks5h://127.0.0.1:1080')).toBe(true);
    expect(isSocksProxyUrl('socks4://127.0.0.1:1080')).toBe(true);
    expect(isSocksProxyUrl('socks4a://127.0.0.1:1080')).toBe(true);
  });

  it('is case-insensitive about the scheme', () => {
    expect(isSocksProxyUrl('SOCKS5H://127.0.0.1:1080')).toBe(true);
  });

  it('does not treat HTTP proxies as SOCKS', () => {
    expect(isSocksProxyUrl('http://proxy:8080')).toBe(false);
    expect(isSocksProxyUrl('https://proxy:8443')).toBe(false);
    expect(isSocksProxyUrl('')).toBe(false);
  });

  it('exposes the accepted scheme list for the settings validator', () => {
    expect(PROXY_SCHEMES).toEqual(
      expect.arrayContaining(['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']),
    );
  });
});

// SOCKS requests never go through global fetch() — they ride http/https.request
// with a SocksProxyAgent. Stubbing https.request lets us assert *which* agent
// the dispatcher picked (and that socks5h parsed into a real SOCKS5 agent)
// without opening a socket.
function stubHttpsRequest() {
  return vi.spyOn(https, 'request').mockImplementation(((_opts: any, cb: any) => {
    const req = new EventEmitter() as any;
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      res.statusMessage = 'OK';
      res.headers = {};
      res.destroy = () => {};
      cb(res);
      setImmediate(() => res.emit('end'));
    };
    return req;
  }) as any);
}

describe('proxyFetch dispatcher selection for SOCKS schemes (#630)', () => {
  const cases: Array<[string, number]> = [
    ['socks5://127.0.0.1:1080', 5],
    ['socks5h://127.0.0.1:1080', 5],
    ['socks4://127.0.0.1:1080', 4],
    ['socks4a://127.0.0.1:1080', 4],
  ];

  for (const [url, socksType] of cases) {
    it(`routes ${url} through a SocksProxyAgent, not undici`, async () => {
      applyProxyUrl(url);
      const fetchSpy = vi.spyOn(global, 'fetch');
      const reqSpy = stubHttpsRequest();

      const res = await proxyFetch('https://api.example.com/v1', { method: 'POST' }, 'groq');

      expect(res.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      const agent = (reqSpy.mock.calls[0][0] as any).agent;
      expect(agent?.proxy?.type).toBe(socksType);
      expect(agent?.proxy?.port).toBe(1080);
    });
  }
});

// #666: the SOCKS fallback hardcoded a 120s socket timeout, so a user with
// PROVIDER_TIMEOUT_CUSTOM=600000 still lost the request at 120s. The fix only
// ever RAISES that guard — it never lowers it to the caller's timeout, because
// http.request's `timeout` is a socket inactivity timer armed across the whole
// streaming body while timeoutMs is a header deadline disarmed at headers
// (#553/#584 hand mid-stream time to the stall watchdog).
describe('SOCKS socket timeout guard (#666)', () => {
  const socketTimeoutOf = (spy: ReturnType<typeof stubHttpsRequest>): unknown =>
    (spy.mock.calls[0][0] as any).timeout;

  beforeEach(() => {
    applyProxyUrl('socks5://127.0.0.1:1080');
  });

  it('raises the guard past 120s for a long caller timeout, with a grace margin', async () => {
    const reqSpy = stubHttpsRequest();

    await proxyFetch('https://api.example.com/v1', { method: 'POST' }, 'groq', 'chat', 600_000);

    // +30s so the caller's own abort deadline always fires first and the
    // tagged AbortError survives instead of the bare socket 'timeout'.
    expect(socketTimeoutOf(reqSpy)).toBe(630_000);
  });

  it('never drops below 120s for a platform with a short chat timeout', async () => {
    const reqSpy = stubHttpsRequest();

    await proxyFetch('https://api.example.com/v1', { method: 'POST' }, 'groq', 'chat', 15_000);

    // A 15s socket idle timer would kill a healthy stream mid-prefill; the
    // ~90s stall watchdog stays the governing mid-stream budget.
    expect(socketTimeoutOf(reqSpy)).toBe(120_000);
  });

  it('keeps the historical 120s guard when no timeout is passed', async () => {
    const reqSpy = stubHttpsRequest();

    await proxyFetch('https://api.example.com/v1', { method: 'POST' }, 'groq');

    expect(socketTimeoutOf(reqSpy)).toBe(120_000);
  });

  it('disables the socket timer when the caller timeout is 0 (no timeout)', async () => {
    const reqSpy = stubHttpsRequest();

    await proxyFetch('https://api.example.com/v1', { method: 'POST' }, 'groq', 'chat', 0);

    expect(socketTimeoutOf(reqSpy)).toBe(0);
  });

  it('falls back to the 120s guard for malformed timeouts instead of disabling it', async () => {
    for (const bad of [NaN, -1, Infinity, '300000' as unknown as number]) {
      const reqSpy = stubHttpsRequest();
      await proxyFetch('https://api.example.com/v1', { method: 'POST' }, 'groq', 'chat', bad);
      expect(socketTimeoutOf(reqSpy)).toBe(120_000);
      vi.restoreAllMocks();
    }
  });
});

// #353: HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY are the de-facto
// standard for every other CLI on the box. Honouring them means a user who
// already exported them for curl/git gets a working app with no extra config —
// but an explicitly configured dashboard proxy must still win over ambient env.
describe('standard proxy env vars (#353)', () => {
  it('PROXY_URL wins over everything, including the dashboard value', () => {
    process.env.PROXY_URL = 'http://explicit:8080';
    process.env.ALL_PROXY = 'socks5://all:1080';
    process.env.HTTPS_PROXY = 'http://https-proxy:3128';
    applyProxyUrl('http://db-proxy:3128');
    expect(getProxyUrl()).toBe('http://explicit:8080');
  });

  it('a dashboard-configured proxy beats the ambient standard vars', () => {
    process.env.ALL_PROXY = 'socks5://all:1080';
    process.env.HTTPS_PROXY = 'http://https-proxy:3128';
    process.env.HTTP_PROXY = 'http://http-proxy:3128';
    applyProxyUrl('socks5h://db-proxy:1080');
    expect(getProxyUrl()).toBe('socks5h://db-proxy:1080');
  });

  it('falls back to ALL_PROXY when nothing is configured', () => {
    process.env.ALL_PROXY = 'socks5://all:1080';
    process.env.HTTPS_PROXY = 'http://https-proxy:3128';
    process.env.HTTP_PROXY = 'http://http-proxy:3128';
    applyProxyUrl('');
    expect(getProxyUrl()).toBe('socks5://all:1080');
  });

  it('prefers HTTPS_PROXY over HTTP_PROXY', () => {
    process.env.HTTPS_PROXY = 'http://https-proxy:3128';
    process.env.HTTP_PROXY = 'http://http-proxy:3128';
    applyProxyUrl('');
    expect(getProxyUrl()).toBe('http://https-proxy:3128');
  });

  it('falls back to HTTP_PROXY last', () => {
    process.env.HTTP_PROXY = 'http://http-proxy:3128';
    applyProxyUrl('');
    expect(getProxyUrl()).toBe('http://http-proxy:3128');
  });

  it('accepts the lower-case spellings the convention allows', () => {
    process.env.https_proxy = 'http://lower:3128';
    applyProxyUrl('');
    expect(getProxyUrl()).toBe('http://lower:3128');
  });

  it('ignores blank env values', () => {
    process.env.ALL_PROXY = '   ';
    process.env.HTTPS_PROXY = 'http://https-proxy:3128';
    applyProxyUrl('');
    expect(getProxyUrl()).toBe('http://https-proxy:3128');
  });
});

describe('proxy source logging (#353)', () => {
  it('names the source that won', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.HTTPS_PROXY = 'http://https-proxy:3128';
    applyProxyUrl('');
    expect(log.mock.calls.flat().join(' ')).toContain('HTTPS_PROXY');
  });

  it('names the dashboard as the source when the DB value wins', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.HTTPS_PROXY = 'http://https-proxy:3128';
    applyProxyUrl('http://db-proxy:3128');
    expect(log.mock.calls.flat().join(' ')).toContain('dashboard');
  });

  it('never logs credentials embedded in the proxy URL', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.ALL_PROXY = 'socks5h://alice:hunter2@proxy.internal:1080';
    applyProxyUrl('');
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('alice');
    expect(logged).toContain('***@proxy.internal:1080');
  });

  it('redacts credentials in the dispatcher-failure log too', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A failed dispatcher falls back to a direct fetch — stub it so the test
    // never touches the network.
    vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    // A port outside the valid range makes SocksProxyAgent throw on construction.
    applyProxyUrl('socks5h://alice:hunter2@proxy.internal:not-a-port');
    await proxyFetch('https://api.example.com/v1', undefined, 'groq');
    const logged = err.mock.calls.flat().join(' ');
    expect(logged).not.toContain('hunter2');
  });
});

describe('NO_PROXY bypass (#353)', () => {
  const dispatcherFor = async (url: string) => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await proxyFetch(url, { method: 'POST' }, 'groq');
    return (spy.mock.calls[0][1] as any)?.dispatcher;
  };

  it('parses a comma-separated list, lower-cased', () => {
    process.env.NO_PROXY = 'localhost, .Internal.Corp ,, 10.0.0.1';
    applyProxyUrl('http://proxy:8080');
    expect(getNoProxyRules()).toEqual(['localhost', '.internal.corp', '10.0.0.1']);
  });

  it('bypasses an exact host match', async () => {
    process.env.NO_PROXY = 'api.example.com';
    applyProxyUrl('http://proxy:8080');
    expect(await dispatcherFor('https://api.example.com/v1')).toBeUndefined();
  });

  it('still proxies hosts that do not match', async () => {
    process.env.NO_PROXY = 'api.example.com';
    applyProxyUrl('http://proxy:8080');
    expect(await dispatcherFor('https://api.groq.com/v1')).toBeDefined();
  });

  it('treats a bare domain as a suffix match on its subdomains', async () => {
    process.env.NO_PROXY = 'example.com';
    applyProxyUrl('http://proxy:8080');
    expect(await dispatcherFor('https://api.example.com/v1')).toBeUndefined();
  });

  it('does not let a suffix rule match an unrelated host that merely ends with it', async () => {
    process.env.NO_PROXY = 'example.com';
    applyProxyUrl('http://proxy:8080');
    expect(await dispatcherFor('https://notexample.com/v1')).toBeDefined();
  });

  it('supports the leading-dot spelling', async () => {
    process.env.NO_PROXY = '.example.com';
    applyProxyUrl('http://proxy:8080');
    expect(await dispatcherFor('https://api.example.com/v1')).toBeUndefined();
  });

  it('matches case-insensitively', async () => {
    process.env.NO_PROXY = 'API.EXAMPLE.COM';
    applyProxyUrl('http://proxy:8080');
    expect(await dispatcherFor('https://api.example.com/v1')).toBeUndefined();
  });

  it('ignores a port qualifier on the rule', async () => {
    process.env.NO_PROXY = 'api.example.com:443';
    applyProxyUrl('http://proxy:8080');
    expect(await dispatcherFor('https://api.example.com/v1')).toBeUndefined();
  });

  it('"*" bypasses every host', async () => {
    process.env.NO_PROXY = '*';
    applyProxyUrl('http://proxy:8080');
    expect(await dispatcherFor('https://api.groq.com/v1')).toBeUndefined();
  });

  it('accepts the lower-case spelling', async () => {
    process.env.no_proxy = 'api.example.com';
    applyProxyUrl('http://proxy:8080');
    expect(await dispatcherFor('https://api.example.com/v1')).toBeUndefined();
  });

  it('leaves the per-platform bypass list untouched', () => {
    process.env.NO_PROXY = 'api.example.com';
    applyProxyBypass('groq');
    applyProxyUrl('http://proxy:8080');
    expect(getProxyBypassPlatforms()).toEqual(['groq']);
  });
});

describe('proxyFetch routing', () => {
  it('passes straight through to fetch when no proxy is configured (default for all users)', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await proxyFetch('https://api.example.com/v1', { method: 'POST' });
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0];
    // No dispatcher injected on the direct path.
    expect((init as any)?.dispatcher).toBeUndefined();
  });

  it('routes through the dispatcher for an HTTP proxy', async () => {
    applyProxyUrl('http://proxy:8080');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await proxyFetch('https://api.example.com/v1', { method: 'POST' }, 'groq');
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0];
    expect((init as any)?.dispatcher).toBeDefined();
  });

  it('bypasses the proxy for a platform on the bypass list', async () => {
    applyProxyUrl('http://proxy:8080');
    applyProxyBypass('groq');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await proxyFetch('https://api.example.com/v1', { method: 'POST' }, 'groq');
    const [, init] = spy.mock.calls[0];
    expect((init as any)?.dispatcher).toBeUndefined(); // direct, not proxied
  });

  it('bypasses the proxy globally when disabled', async () => {
    applyProxyUrl('http://proxy:8080');
    applyProxyEnabled(false);
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await proxyFetch('https://api.example.com/v1', undefined, 'google');
    const [, init] = spy.mock.calls[0];
    expect((init as any)?.dispatcher).toBeUndefined();
  });
});

// SSRF guard, request-time half (#440). The save-time check validates the
// literal base_url, but fetch()'s default redirect: 'follow' would re-request
// a 3xx Location target with no re-validation — a public base_url answering
// 302 → http://169.254.169.254/ used to defeat the guard entirely. Custom
// providers therefore never follow redirects; the 3xx becomes an explicit
// error naming the target so the operator can fix base_url.
describe('proxyFetch custom-provider redirect guard', () => {
  const redirectResponse = (status: number, location?: string) =>
    ({ ok: false, status, headers: new Headers(location ? { location } : {}) }) as Response;

  it('forces redirect: "manual" on custom-provider requests', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await proxyFetch('http://93.184.216.34/v1/chat/completions', { method: 'POST' }, 'custom');
    const [, init] = spy.mock.calls[0];
    expect((init as any)?.redirect).toBe('manual');
  });

  it('rejects a custom-provider 302 instead of following it', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      redirectResponse(302, 'http://169.254.169.254/latest/meta-data/'),
    );
    await expect(proxyFetch('http://93.184.216.34/v1', { method: 'POST' }, 'custom'))
      .rejects.toThrow(/redirects are not followed/);
    // The Location target is never requested.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects every redirect status the same way', async () => {
    for (const status of [301, 303, 307, 308]) {
      vi.spyOn(global, 'fetch').mockResolvedValue(redirectResponse(status, 'http://10.0.0.1/'));
      await expect(proxyFetch('http://93.184.216.34/v1', undefined, 'custom'))
        .rejects.toThrow(new RegExp(`redirected \\(${status}\\)`));
    }
  });

  it('names the redirect target in the error so the operator can fix base_url', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(redirectResponse(301, 'https://api.example.com/v1/'));
    await expect(proxyFetch('http://93.184.216.34/v1', undefined, 'custom'))
      .rejects.toThrow(/https:\/\/api\.example\.com\/v1\//);
  });

  it('passes 3xx responses through untouched for built-in platforms', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(redirectResponse(302, 'https://elsewhere.example.com/'));
    const res = await proxyFetch('https://api.example.com/v1', undefined, 'groq');
    expect(res.status).toBe(302);
  });

  it('blocks hex-form IPv4-mapped metadata literals before any fetch happens', async () => {
    // new URL() canonicalises [::ffff:169.254.169.254] to [::ffff:a9fe:a9fe].
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await expect(proxyFetch('http://[::ffff:169.254.169.254]/latest/', undefined, 'custom'))
      .rejects.toThrow(/metadata/);
    expect(spy).not.toHaveBeenCalled();
  });
});

// Compact abort-error triage tag formatting. The string written to
// `requests.error` is `The operation was aborted (<platform>, <type>, <N>s)`
// — round-trip what's already on the row so an operator can read the abort
// cause without joining against the columns.
describe('describeAbort', () => {
  it('formats platform + type + timeout-in-seconds', () => {
    expect(describeAbort('cloudflare', 'chat', 15_000)).toBe('cloudflare, chat, 15s');
    expect(describeAbort('opencode', 'embedding', 30_000)).toBe('opencode, embedding, 30s');
    expect(describeAbort('nvidia', 'image', 60_000)).toBe('nvidia, image, 60s');
    expect(describeAbort('google', 'audio', 60_000)).toBe('google, audio, 60s');
  });

  it('rounds sub-second milliseconds up to 1s (no "0s")', () => {
    expect(describeAbort('x', 'chat', 500)).toBe('x, chat, 1s');
    expect(describeAbort('x', 'chat', 0)).toBe('x, chat');
  });

  it('falls back to "unknown" when platform or type is missing', () => {
    expect(describeAbort(undefined, 'chat', 15_000)).toBe('unknown, chat, 15s');
    expect(describeAbort('  ', 'chat', 15_000)).toBe('unknown, chat, 15s');
    expect(describeAbort('cloudflare', 'unknown', 15_000)).toBe('cloudflare, unknown, 15s');
  });

  it('omits the timeout suffix when no timeout is provided', () => {
    expect(describeAbort('cloudflare', 'chat', undefined)).toBe('cloudflare, chat');
    expect(describeAbort('cloudflare', 'chat', 0)).toBe('cloudflare, chat');
  });
});

// Regression: previously every abort through proxyFetch surfaced as the bare
// string "The operation was aborted" with no upstream URL or platform context.
// The fix wraps proxyFetch's catch with an enrichAbort() that rewrites the
// DOMException message to `The operation was aborted (<platform>, <type>, <N>s)`
// — no URL, no credentials — so an operator reading the requests.error column
// gets the same triage info as the requests row columns (platform, request_type,
// latency_ms / timeout). The `name: 'AbortError'` is preserved so
// isRetryableError() (which matches the substring "aborted") keeps
// classifying it as retryable.
describe('proxyFetch abort error enrichment', () => {
  it('rewrites a native AbortError to include platform, type, and timeout', async () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    vi.spyOn(global, 'fetch').mockRejectedValue(abortErr);
    await expect(
      proxyFetch('https://api.openrouter.ai/api/v1/chat/completions', undefined, 'openrouter', 'chat', 15_000),
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('openrouter, chat, 15s'),
    });
  });

  it('does not include any URL or path in the enriched message', async () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    vi.spyOn(global, 'fetch').mockRejectedValue(abortErr);
    let caught: Error | null = null;
    try {
      await proxyFetch(
        'https://api.openrouter.ai/api/v1/chat/completions',
        undefined,
        'openrouter',
        'chat',
        15_000,
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain('api.openrouter.ai');
    expect(caught!.message).not.toContain('/v1/chat/completions');
  });

  it('omits the timeout suffix when none was supplied (older call sites)', async () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    vi.spyOn(global, 'fetch').mockRejectedValue(abortErr);
    await expect(
      proxyFetch('https://api.example.com/v1', undefined, 'groq', 'chat'),
    ).rejects.toMatchObject({
      message: expect.stringContaining('groq, chat)'),
    });
  });

  it('does not rewrite non-AbortError rejections', async () => {
    const typeErr = new TypeError('fetch failed');
    vi.spyOn(global, 'fetch').mockRejectedValue(typeErr);
    await expect(
      proxyFetch('https://api.example.com/v1', undefined, 'groq', 'chat', 15_000),
    ).rejects.toBe(typeErr);
  });
});
