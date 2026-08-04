import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { applyProxyUrl } from '../../lib/proxy.js';

async function request(app: Express, method: string, path: string, body: any, token: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json };
}

// PUT /api/settings/proxy is the only place a proxy URL is validated, so the
// scheme allow-list here is what actually decides whether a user can save
// `socks5h://` from the dashboard (#630).
describe('PUT /api/settings/proxy scheme validation', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.PROXY_URL;
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  afterAll(() => {
    applyProxyUrl('');
  });

  const accepted = [
    'http://proxy.corp.com:8080',
    'https://proxy.corp.com:8443',
    'socks5://127.0.0.1:1080',
    'socks5h://127.0.0.1:1080',
    'socks4://127.0.0.1:1080',
    'socks4a://127.0.0.1:1080',
  ];

  for (const proxyUrl of accepted) {
    it(`accepts ${proxyUrl}`, async () => {
      const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { proxyUrl }, token);
      expect(status).toBe(200);
      expect(body.proxyUrl).toBe(proxyUrl);
    });
  }

  it('accepts socks5h with credentials', async () => {
    const proxyUrl = 'socks5h://user:pass@127.0.0.1:1080';
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { proxyUrl }, token);
    expect(status).toBe(200);
    expect(body.proxyUrl).toBe(proxyUrl);
  });

  it('rejects an unsupported scheme', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { proxyUrl: 'ftp://proxy:21' }, token);
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/socks5h/);
  });

  it('rejects a malformed URL', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { proxyUrl: 'not a url' }, token);
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('clears the proxy on an empty string', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { proxyUrl: '' }, token);
    expect(status).toBe(200);
    expect(body.proxyUrl).toBe('');
  });
});
