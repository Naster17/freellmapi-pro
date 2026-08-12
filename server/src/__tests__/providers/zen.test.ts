import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getProvider, hasProvider, resolveProvider } from '../../providers/index.js';
import { ZenProvider } from '../../providers/zen.js';
import {
  acquireZenIpLease,
  currentZenIp,
  isZenIpExhausted,
  setZenKeylessMode,
  _resetZenKeylessState,
} from '../../services/zen-keyless.js';

const OK_BODY = {
  id: 'x',
  object: 'chat.completion',
  created: 0,
  model: 'mimo-v2.5-free',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const MESSAGES: Array<{ role: 'user'; content: string }> = [{ role: 'user', content: 'hi' }];

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function mockResponse(status: number, ok: boolean, body: unknown, capture?: (headers: Record<string, string>) => void) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
    capture?.((init?.headers ?? {}) as Record<string, string>);
    return {
      ok,
      status,
      json: () => Promise.resolve(body),
      headers: { get: () => null },
    } as unknown as Response;
  });
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  getDb().prepare('DELETE FROM api_keys').run();
  getDb().prepare('DELETE FROM settings').run();
  _resetZenKeylessState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ZenProvider registration', () => {
  it('is the opencode platform provider', () => {
    expect(hasProvider('opencode')).toBe(true);
    const provider = getProvider('opencode');
    expect(provider).toBeInstanceOf(ZenProvider);
    expect(provider?.name).toBe('OpenCode Zen');
    expect(resolveProvider('opencode')).toBe(provider);
  });
});

describe('ZenProvider headers', () => {
  it('sends a bearer header and no X-Real-IP when keyless mode is off', async () => {
    const cap = mockResponse(200, true, OK_BODY);
    const provider = new ZenProvider();
    await provider.chatCompletion('zen-test-key', MESSAGES, 'mimo-v2.5-free');
    const headers = (cap.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(String(cap.mock.calls[0][0])).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(headers.Authorization).toBe('Bearer zen-test-key');
    expect(headers['X-Real-IP']).toBeUndefined();
  });

  it('sends no auth and a per-stream X-Real-IP when keyless mode is on', async () => {
    setZenKeylessMode(true);
    let usedIp: string | undefined;
    const cap = mockResponse(200, true, OK_BODY, headers => { usedIp = headers['X-Real-IP']; });
    const provider = new ZenProvider();
    await provider.chatCompletion('zen-test-key', MESSAGES, 'mimo-v2.5-free');
    const headers = (cap.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
    expect(usedIp).toBeDefined();
    expect(usedIp!).toMatch(IP_RE);
  });

  it('hands concurrent streams distinct ips', async () => {
    setZenKeylessMode(true);
    const used: string[] = [];
    mockResponse(200, true, OK_BODY, headers => { used.push(headers['X-Real-IP'] ?? ''); });
    const provider = new ZenProvider();
    await Promise.all([
      provider.chatCompletion('zen-test-key', MESSAGES, 'mimo-v2.5-free'),
      provider.chatCompletion('zen-test-key', MESSAGES, 'mimo-v2.5-free'),
    ]);
    expect(used).toHaveLength(2);
    expect(used[0]).toMatch(IP_RE);
    expect(used[1]).toMatch(IP_RE);
    expect(used[0]).not.toBe(used[1]);
  });

  it('sends no auth and an X-Real-IP on the catalog endpoint', async () => {
    setZenKeylessMode(true);
    const cap = mockResponse(200, true, { object: 'list', data: [] });
    const provider = new ZenProvider();
    await provider.fetchModelCatalog('zen-test-key');
    const headers = (cap.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Real-IP']).toBe(currentZenIp());
  });
});

describe('ZenProvider upstream error handling', () => {
  it('disposes the stream ip on 429 while keyless', async () => {
    setZenKeylessMode(true);
    let usedIp = '';
    mockResponse(429, false, { error: { message: 'rate limited' } }, headers => { usedIp = headers['X-Real-IP'] ?? ''; });
    const provider = new ZenProvider();
    await expect(provider.chatCompletion('k', MESSAGES, 'mimo-v2.5-free')).rejects.toThrow();
    expect(usedIp).toMatch(IP_RE);
    expect(isZenIpExhausted(usedIp)).toBe(true);
    const next = acquireZenIpLease()!;
    expect(next.ip).not.toBe(usedIp);
    next.release();
  });

  it('disposes the stream ip on 5xx while keyless', async () => {
    setZenKeylessMode(true);
    let usedIp = '';
    mockResponse(500, false, { error: { message: 'subscription required' } }, headers => { usedIp = headers['X-Real-IP'] ?? ''; });
    const provider = new ZenProvider();
    await expect(provider.chatCompletion('k', MESSAGES, 'mimo-v2.5-free')).rejects.toThrow();
    expect(isZenIpExhausted(usedIp)).toBe(true);
    const next = acquireZenIpLease()!;
    expect(next.ip).not.toBe(usedIp);
    next.release();
  });

  it('keeps the stream ip on a 400 while keyless', async () => {
    setZenKeylessMode(true);
    let usedIp = '';
    mockResponse(400, false, { error: { message: 'bad request' } }, headers => { usedIp = headers['X-Real-IP'] ?? ''; });
    const provider = new ZenProvider();
    await expect(provider.chatCompletion('k', MESSAGES, 'mimo-v2.5-free')).rejects.toThrow();
    expect(usedIp).toMatch(IP_RE);
    expect(isZenIpExhausted(usedIp)).toBe(false);
  });

  it('does not touch the ip when keyless mode is off', async () => {
    mockResponse(429, false, { error: { message: 'rate limited' } });
    const provider = new ZenProvider();
    await expect(provider.chatCompletion('k', MESSAGES, 'mimo-v2.5-free')).rejects.toThrow();
    expect(currentZenIp()).toBeNull();
  });
});

describe('ZenProvider validateKey', () => {
  it('returns true without any network call while keyless', async () => {
    setZenKeylessMode(true);
    const cap = vi.spyOn(global, 'fetch');
    const provider = new ZenProvider();
    await expect(provider.validateKey('anything')).resolves.toBe(true);
    expect(cap).not.toHaveBeenCalled();
  });

  it('returns true for the no-key sentinel value without any network call', async () => {
    const cap = vi.spyOn(global, 'fetch');
    const provider = new ZenProvider();
    await expect(provider.validateKey('no-key')).resolves.toBe(true);
    expect(cap).not.toHaveBeenCalled();
  });

  it('delegates to the base probe otherwise', async () => {
    mockResponse(200, true, { object: 'list', data: [] });
    const provider = new ZenProvider();
    await expect(provider.validateKey('zen-test-key')).resolves.toBe(true);
  });

  it('reports an invalid key via the base probe', async () => {
    mockResponse(401, false, { error: { message: 'invalid api key' } });
    const provider = new ZenProvider();
    await expect(provider.validateKey('zen-test-key')).resolves.not.toBe(true);
  });
});
