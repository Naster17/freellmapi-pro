import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAuthorizeUrl,
  parseAuthorizationInput,
  parseStoredClineCredentials,
  clineAuthHeaderValue,
  isCredentialExpiring,
  exchangeClineCode,
  refreshClineTokenRequest,
} from '../../lib/cline-oauth.js';

const proxyFetchMock = vi.fn();
vi.mock('../../lib/proxy.js', () => ({
  proxyFetch: (...args: unknown[]) => proxyFetchMock(...args),
}));

// lib/cline-oauth.ts — the Cline account-OAuth protocol pieces (URL building,
// stored-credential parsing, code/token exchange against api.cline.bot).

describe('buildAuthorizeUrl', () => {
  it('points at the Cline authorize endpoint with the callback attached', () => {
    const url = new URL(buildAuthorizeUrl('http://localhost:3002/keys/cline/callback'));
    expect(url.origin).toBe('https://api.cline.bot');
    expect(url.pathname).toBe('/api/v1/auth/authorize');
    expect(url.searchParams.get('client_type')).toBe('extension');
    expect(url.searchParams.get('callback_url')).toBe('http://localhost:3002/keys/cline/callback');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3002/keys/cline/callback');
  });
});

describe('parseAuthorizationInput', () => {
  it('accepts a bare code', () => {
    expect(parseAuthorizationInput('abc123')).toBe('abc123');
  });

  it('extracts the code from a pasted redirect URL', () => {
    expect(parseAuthorizationInput('http://localhost:48801/auth?code=xyz&state=s')).toBe('xyz');
  });

  it('returns null for empty input or a URL without a code', () => {
    expect(parseAuthorizationInput('')).toBeNull();
    expect(parseAuthorizationInput('http://localhost:48801/auth')).toBeNull();
  });
});

describe('parseStoredClineCredentials', () => {
  it('parses the OAuth credential blob and strips the workos: prefix', () => {
    const creds = parseStoredClineCredentials(
      JSON.stringify({ accessToken: 'workos:jwt', refreshToken: 'r1', expiresAt: 123 }),
    );
    expect(creds).toEqual({ accessToken: 'jwt', refreshToken: 'r1', expiresAt: 123 });
  });

  it('accepts a raw pasted token', () => {
    expect(parseStoredClineCredentials('workos:raw')).toEqual({ accessToken: 'raw' });
  });

  it('rejects garbage', () => {
    expect(parseStoredClineCredentials('')).toBeNull();
    expect(parseStoredClineCredentials('{not json')).toBeNull();
    expect(parseStoredClineCredentials('{"refreshToken":"r"}')).toBeNull();
  });
});

describe('clineAuthHeaderValue / isCredentialExpiring', () => {
  it('prefixes the WorkOS bearer', () => {
    expect(clineAuthHeaderValue('workos:abc')).toBe('Bearer workos:abc');
  });

  it('flags tokens within the 5-minute refresh buffer', () => {
    expect(isCredentialExpiring({ accessToken: 'a', expiresAt: Date.now() + 60_000 })).toBe(true);
    expect(isCredentialExpiring({ accessToken: 'a', expiresAt: Date.now() + 600_000 })).toBe(false);
    expect(isCredentialExpiring({ accessToken: 'a' })).toBe(false);
  });
});

describe('exchangeClineCode / refreshClineTokenRequest', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exchanges an authorization code and maps the response payload', async () => {
    proxyFetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        accessToken: 'at',
        refreshToken: 'rt',
        tokenType: 'Bearer',
        expiresAt: '2026-09-03T00:00:00.000Z',
        userInfo: { email: 'a@b.c' },
      },
    }), { status: 200 }));

    const creds = await exchangeClineCode('code', 'http://localhost:48801/auth');
    expect(creds.accessToken).toBe('at');
    expect(creds.refreshToken).toBe('rt');
    expect(creds.email).toBe('a@b.c');

    const [url, init] = proxyFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cline.bot/api/v1/auth/token');
    expect(JSON.parse(String(init.body))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code',
      client_type: 'extension',
      redirect_uri: 'http://localhost:48801/auth',
    });
  });

  it('surfaces the gateway error message on a bad code', async () => {
    proxyFetchMock.mockResolvedValue(new Response(
      JSON.stringify({ success: false, data: '', error: 'invalid or expired authorization code' }),
      { status: 400 },
    ));
    await expect(exchangeClineCode('bad', 'http://localhost:48801/auth'))
      .rejects.toThrow('invalid or expired authorization code');
  });

  it('refreshes via the refresh endpoint', async () => {
    proxyFetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { accessToken: 'at2', refreshToken: 'rt2', expiresAt: '2026-09-03T00:00:00.000Z' },
    }), { status: 200 }));

    const creds = await refreshClineTokenRequest('rt1');
    expect(creds).toMatchObject({ accessToken: 'at2', refreshToken: 'rt2' });
    const [url, init] = proxyFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cline.bot/api/v1/auth/refresh');
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: 'rt1', grantType: 'refresh_token' });
  });
});
