import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

const ENDPOINT = 'http://127.0.0.1:18099/v1';
const realFetch = globalThis.fetch;

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown, auth = true) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data as any };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubModalModels(models: string[]) {
  globalThis.fetch = vi.fn(async () => jsonResponse({
    object: 'list',
    data: models.map(id => ({ id })),
  })) as any;
}

describe('Modal shared-endpoint keys', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS;
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('requires a baseUrl for a modal key', async () => {
    const { status } = await request(app, 'POST', '/api/keys', { platform: 'modal', key: 'wk-x.ws-y' });
    expect(status).toBe(400);
  });

  it('stores the endpoint URL and the probed model scope', async () => {
    stubModalModels(['moonshotai/Kimi-K3']);

    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'modal', key: 'wk-x.ws-y', baseUrl: ENDPOINT, label: 'kimi',
    });

    expect(status).toBe(201);
    expect(body.modelScope).toEqual(['moonshotai/Kimi-K3']);
    expect(body.notice ?? null).toBeNull();

    const row = getDb().prepare('SELECT base_url, model_scope_json FROM api_keys WHERE id = ?')
      .get(body.id) as { base_url: string | null; model_scope_json: string | null };
    expect(row.base_url).toBe(ENDPOINT);
    expect(JSON.parse(row.model_scope_json!)).toEqual(['moonshotai/Kimi-K3']);

    const list = await request(app, 'GET', '/api/keys');
    expect(list.body[0].baseUrl).toBe(ENDPOINT);
    expect(list.body[0].exportable).toBe(true);
    expect(list.body[0].modelScope).toEqual(['moonshotai/Kimi-K3']);
  });

  it('adds the key unscoped with a notice when the endpoint is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) as any;

    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'modal', key: 'wk-x.ws-y', baseUrl: ENDPOINT,
    });

    expect(status).toBe(201);
    expect(body.modelScope).toBeNull();
    expect(body.notice).toBeTruthy();

    const row = getDb().prepare('SELECT base_url, model_scope_json FROM api_keys WHERE id = ?')
      .get(body.id) as { base_url: string | null; model_scope_json: string | null };
    expect(row.base_url).toBe(ENDPOINT);
    expect(row.model_scope_json).toBeNull();
  });

  it('appends /v1 to a bare endpoint URL before probing and storing', async () => {
    const baseUrl = 'http://127.0.0.1:18099';
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return jsonResponse({ object: 'list', data: [{ id: 'moonshotai/Kimi-K3' }] });
    }) as any;

    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'modal', key: 'wk-x.ws-y', baseUrl,
    });

    expect(status).toBe(201);
    expect(calls).toContain(`${baseUrl}/v1/models`);
    const row = getDb().prepare('SELECT base_url, model_scope_json FROM api_keys WHERE id = ?')
      .get(body.id) as { base_url: string | null; model_scope_json: string | null };
    expect(row.base_url).toBe(`${baseUrl}/v1`);
    expect(JSON.parse(row.model_scope_json!)).toEqual(['moonshotai/Kimi-K3']);
  });

  it('rejects a cloud-metadata base URL', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'modal', key: 'wk-x.ws-y', baseUrl: 'http://169.254.169.254/latest/meta-data',
    });
    expect(status).toBe(400);
    expect(String(body.error.message)).toMatch(/baseUrl rejected/);
  });
});

describe('Modal key export round trip', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS;
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  async function exportText(format: string): Promise<string> {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const res = await realFetch(`http://127.0.0.1:${addr.port}/api/keys/export?format=${format}`, {
      headers: { Authorization: `Bearer ${dashToken}`, 'x-reauth-password': 'password123' },
    });
    const text = await res.text();
    server.close();
    return text;
  }

  async function importFile(filename: string, content: string) {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'text/plain' }), filename);
    const res = await realFetch(`http://127.0.0.1:${addr.port}/api/keys/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${dashToken}` },
      body: form,
    });
    const body = await res.json();
    server.close();
    return { status: res.status, body };
  }

  function seedModalKey() {
    const { encrypted, iv, authTag } = encrypt('wk-x.ws-y');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, model_scope_json)
      VALUES ('modal', 'kimi', ?, ?, ?, 'healthy', 1, ?, ?)
    `).run(encrypted, iv, authTag, ENDPOINT, JSON.stringify(['moonshotai/Kimi-K3']));
  }

  function snapshot(): string[] {
    return (getDb().prepare('SELECT platform, base_url, encrypted_key, iv, auth_tag, model_scope_json FROM api_keys').all() as any[])
      .map(r => {
        let secret = '';
        try { secret = decrypt(r.encrypted_key, r.iv, r.auth_tag); } catch { secret = '[undecryptable]'; }
        return `${r.platform}|${r.base_url ?? ''}|${secret}|${r.model_scope_json ?? ''}`;
      })
      .sort();
  }

  it('.env pairs the endpoint URL with the proxy token', async () => {
    seedModalKey();
    const text = await exportText('env');
    expect(text).toContain('MODAL_1_BASE_URL=http://127.0.0.1:18099/v1');
    expect(text).toContain('MODAL_1_KEY=wk-x.ws-y');
  });

  it.each(['env', 'csv', 'json'])('a %s export re-imports the modal key with its scope', async (format) => {
    seedModalKey();
    stubModalModels(['moonshotai/Kimi-K3']);
    const before = snapshot();
    const text = await exportText(format);

    getDb().prepare('DELETE FROM api_keys').run();
    const { body } = await importFile(`keys.${format}`, text);
    expect(body.errors).toEqual([]);

    expect(snapshot()).toEqual(before);
  });
});
