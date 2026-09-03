import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

const proxyFetchMock = vi.fn();
vi.mock('../../lib/proxy.js', () => ({
  proxyFetch: (...args: unknown[]) => proxyFetchMock(...args),
}));

// routes/cline-oauth.ts + the platform wiring: the dashboard-facing half of the
// Cline OAuth flow (start → browser → complete) and the provider checklist.
// The token exchange itself is mocked at proxyFetch; the protocol-level tests
// (URL building, payload mapping, error surfacing) live in
// __tests__/lib/cline-oauth.test.ts.

async function request(app: Express, method: string, path: string, token: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

describe('Cline OAuth routes', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '1'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('lists cline in the provider checklist', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys/providers', token);
    expect(status).toBe(200);
    const providers = Array.isArray(body) ? body : body.providers;
    expect(providers.map((p: any) => p.platform ?? p.id ?? p.name)).toContain('cline');
  });

  it('starts a flow with an api.cline.bot authorize URL and a state', async () => {
    const { status, body } = await request(app, 'POST', '/api/cline/oauth/start', token, {
      redirectUri: 'http://127.0.0.1:3002',
    });
    expect(status).toBe(200);
    const url = new URL(body.authUrl);
    expect(url.origin).toBe('https://api.cline.bot');
    expect(url.pathname).toBe('/api/v1/auth/authorize');
    expect(url.searchParams.get('callback_url')).toBe('http://127.0.0.1:3002/keys/cline/callback');
    expect(body.state).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects a non-http redirectUri', async () => {
    const { status } = await request(app, 'POST', '/api/cline/oauth/start', token, {
      redirectUri: 'ftp://evil',
    });
    expect(status).toBe(400);
  });

  it('completes with a pasted URL, exchanging the code and inserting the key', async () => {
    proxyFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresAt: '2026-09-03T00:00:00.000Z',
        userInfo: { email: 'dev@example.com' },
      },
    }), { status: 200 }));

    const { status, body } = await request(app, 'POST', '/api/cline/oauth/complete', token, {
      url: 'http://localhost:48801/auth?code=good-code',
    });
    expect(status).toBe(201);
    expect(body.platform).toBe('cline');
    expect(body.email).toBe('dev@example.com');

    // The stored credential blob is encrypted at rest but round-trips through
    // the same decrypt path the provider uses.
    const { decrypt } = await import('../../lib/crypto.js');
    const row = getDb().prepare("SELECT label, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'cline' ORDER BY id DESC LIMIT 1")
      .get() as any;
    expect(row.label).toBe('Cline (dev@example.com)');
    const stored = JSON.parse(decrypt(row.encrypted_key, row.iv, row.auth_tag));
    expect(stored).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', email: 'dev@example.com' });
  });

  it('rejects a bad authorization code with the gateway message', async () => {
    proxyFetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ success: false, data: '', error: 'invalid or expired authorization code' }),
      { status: 400 },
    ));
    const { status, body } = await request(app, 'POST', '/api/cline/oauth/complete', token, {
      code: 'bad',
    });
    expect(status).toBe(400);
    expect(body.error.message).toContain('invalid or expired authorization code');
  });

  it('returns 400 when no code can be parsed', async () => {
    const { status } = await request(app, 'POST', '/api/cline/oauth/complete', token, {
      url: 'http://localhost:48801/auth?state=only',
    });
    expect(status).toBe(400);
  });
});

describe('ClineProvider key validation', () => {
  it('marks a revoked token invalid via /users/me (not the public /models)', async () => {
    process.env.ENCRYPTION_KEY = '1'.repeat(64);
    const { ClineProvider } = await import('../../providers/cline.js');
    const provider = new ClineProvider();

    proxyFetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'Unauthorized: Please make sure you\'re using the latest version of Cline and re-authenticate your Cline account.' }),
      { status: 401 },
    ));
    const result = await provider.validateKey(JSON.stringify({
      accessToken: 'dead', refreshToken: 'dead', expiresAt: Date.now() + 600_000,
    }));
    expect(result).toEqual({ valid: false, error: expect.stringContaining('401') });
    const urls = proxyFetchMock.mock.calls.map(c => c[0] as string);
    expect(urls).toContain('https://api.cline.bot/api/v1/users/me');
  });

  it('rejects a stored value that is not an OAuth credential', async () => {
    const { ClineProvider } = await import('../../providers/cline.js');
    const provider = new ClineProvider();
    const result = await provider.validateKey('{broken json');
    expect(result.valid).toBe(false);
  });
});
