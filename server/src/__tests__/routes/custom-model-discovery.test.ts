import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// #488: a relay's model list changes weekly, so the endpoint's own /models
// route is the source of truth for what the USER's key can reach. This is
// discovery on the operator's OWN endpoint with the operator's OWN key — it
// never touches the published provider catalog.

const ENDPOINT = 'http://127.0.0.1:18099/v1';
const DISCOVER = '/api/keys/custom/discover-models';
const realFetch = globalThis.fetch;

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown, auth = true) {
  const server = app.listen(0);
  const addr = server.address() as any;
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

const post = (app: Express, path: string, body: unknown) => request(app, 'POST', path, body);

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubRelay(payload: unknown, status = 200) {
  const mock = vi.fn(async () => jsonResponse(payload, status));
  globalThis.fetch = mock as any;
  return mock;
}

function customKeyIds(baseUrl = ENDPOINT): number[] {
  return (getDb().prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND base_url = ? ORDER BY id")
    .all(baseUrl) as { id: number }[]).map(r => r.id);
}

function chatModel(modelId: string) {
  return getDb().prepare(`
    SELECT id, key_id, intelligence_rank, speed_rank, size_label, source
      FROM models WHERE platform = 'custom' AND model_id = ?
  `).get(modelId) as
    { id: number; key_id: number | null; intelligence_rank: number; speed_rank: number; size_label: string; source: string } | undefined;
}

describe('custom endpoint model discovery (#488)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('requires dashboard auth', async () => {
    stubRelay({ data: [{ id: 'relay-a' }] });
    const { status } = await request(app, 'POST', DISCOVER, { baseUrl: ENDPOINT }, false);
    expect(status).toBe(401);
  });

  it('lists the endpoint models and flags the ones already registered', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const mock = stubRelay({
      object: 'list',
      data: [{ id: 'relay-a', owned_by: 'acme' }, { id: 'relay-b', owned_by: 'acme' }],
    });

    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT });

    expect(status).toBe(200);
    expect(body.baseUrl).toBe(ENDPOINT);
    expect(body.keyId).toBe(customKeyIds()[0]);
    expect(body.models).toEqual([
      { id: 'relay-a', ownedBy: 'acme', registered: true },
      { id: 'relay-b', ownedBy: 'acme', registered: false },
    ]);
    expect(body.registeredCount).toBe(1);

    // Reuses the key-validation fetch: GET ${baseUrl}/models with the stored bearer.
    expect(String(mock.mock.calls[0]![0])).toBe(`${ENDPOINT}/models`);
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer relay-secret');
  });

  it('accepts a key id instead of a base url', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;
    stubRelay({ data: [{ id: 'relay-b' }] });

    const { status, body } = await post(app, DISCOVER, { keyId });
    expect(status).toBe(200);
    expect(body.baseUrl).toBe(ENDPOINT);
    expect(body.models.map((m: any) => m.id)).toEqual(['relay-b']);
  });

  it('discovers against an endpoint that is not registered yet', async () => {
    stubRelay({ data: [{ id: 'relay-b' }] });
    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'fresh-secret' });
    expect(status).toBe(200);
    expect(body.keyId).toBeNull();
    expect(body.models).toEqual([{ id: 'relay-b', ownedBy: null, registered: false }]);
    expect(customKeyIds()).toHaveLength(0); // discovery never writes
  });

  it('parses a non-standard relay envelope', async () => {
    stubRelay({ models: [{ name: 'qwen3:4b' }, { name: 'llama3:8b' }] });
    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'k' });
    expect(status).toBe(200);
    expect(body.models.map((m: any) => m.id)).toEqual(['llama3:8b', 'qwen3:4b']);
  });

  it('reports an unreachable endpoint as 502', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) as any;
    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'k' });
    expect(status).toBe(502);
    expect(String(body.error.message)).toMatch(/could not reach/i);
  });

  it('passes an upstream 401 through as 401', async () => {
    stubRelay({ error: { message: 'invalid api key' } }, 401);
    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'bad' });
    expect(status).toBe(401);
    expect(String(body.error.message)).toMatch(/invalid api key/i);
  });

  it('rejects a catalog body that blows past the size cap', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"data":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024) },
    })) as any;
    const { status } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'k' });
    expect(status).toBe(502);
  });

  it('reports a relay that answers with no model list', async () => {
    stubRelay({ hello: 'world' });
    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'k' });
    expect(status).toBe(502);
    expect(String(body.error.message)).toMatch(/model list/i);
  });

  it('rejects a request with neither baseUrl nor keyId', async () => {
    const { status } = await post(app, DISCOVER, {});
    expect(status).toBe(400);
  });
});

describe('bulk registration of discovered models (#488)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('registers a selection against the endpoint binding and reports what was new', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'first-secret' });
    // A second credential for the same endpoint (#640/#619): models bind to the
    // endpoint, and the pool rotates underneath that binding.
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'second-secret' });
    const [firstKeyId, secondKeyId] = customKeyIds();

    const { status, body } = await post(app, '/api/keys/custom', {
      keyId: secondKeyId,
      models: ['relay-a', 'relay-b', 'relay-c'],
    });

    expect(status).toBe(201);
    expect(body.keyId).toBe(secondKeyId);
    expect(body.baseUrl).toBe(ENDPOINT);
    expect(body.models.map((m: any) => [m.model, m.created])).toEqual([
      ['relay-a', false], ['relay-b', true], ['relay-c', true],
    ]);
    expect(body.created).toBe(2);
    expect(body.alreadyRegistered).toBe(1);

    // relay-a keeps its original binding; the new ones bind to the submitted key.
    expect(chatModel('relay-a')!.key_id).toBe(firstKeyId);
    expect(chatModel('relay-b')!.key_id).toBe(secondKeyId);
    expect(chatModel('relay-c')!.key_id).toBe(secondKeyId);
    expect(chatModel('relay-b')!.source).toBe('user');
  });

  it('does not duplicate a model that is already registered', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'first-secret' });
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, models: ['relay-a', 'relay-a', 'relay-b'] });

    const rows = getDb().prepare("SELECT model_id FROM models WHERE platform = 'custom' ORDER BY model_id")
      .all() as { model_id: string }[];
    expect(rows.map(r => r.model_id)).toEqual(['relay-a', 'relay-b']);
  });

  it('rejects a keyId that is not a custom endpoint', async () => {
    const { body: added } = await post(app, '/api/keys', { platform: 'groq', key: 'gsk_test' });
    const { status } = await post(app, '/api/keys/custom', { keyId: added.id, models: ['relay-a'] });
    expect(status).toBe(400);
  });

  it('rejects a baseUrl that contradicts the submitted keyId', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'first-secret' });
    const { status } = await post(app, '/api/keys/custom', {
      keyId: customKeyIds()[0], baseUrl: 'http://127.0.0.1:18098/v1', models: ['relay-b'],
    });
    expect(status).toBe(400);
  });
});

describe('median seeding for custom models (#488)', () => {
  let app: Express;

  function seedCatalog() {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    const insert = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                          rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled)
      VALUES ('groq', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', 1)
    `);
    const rows: Array<[string, number, number]> = [
      ['Small', 40, 4], ['Medium', 20, 3], ['Large', 10, 2], ['Frontier', 2, 1], ['Frontier', 1, 5],
    ];
    rows.forEach(([label, intel, speed], i) => insert.run(`cat-${i}`, `Cat ${i}`, intel, speed, label));
  }

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    seedCatalog();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('seeds a bulk-registered custom model at the catalog median', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, models: ['relay-a', 'relay-b'], apiKey: 'k' });
    for (const id of ['relay-a', 'relay-b']) {
      const row = chatModel(id)!;
      expect(row.size_label).toBe('Large');
      expect(row.intelligence_rank).toBe(10);
      expect(row.speed_rank).toBe(3);
    }
  });

  it('seeds a singly-added custom model the same way', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-solo', apiKey: 'k' });
    const row = chatModel('relay-solo')!;
    expect(row.size_label).toBe('Large');
    expect(row.intelligence_rank).toBe(10);
    expect(row.speed_rank).toBe(3);
  });

  it('never overwrites ranks the operator has since tuned', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'k' });
    const modelDbId = chatModel('relay-a')!.id;
    getDb().prepare('UPDATE models SET intelligence_rank = 1, speed_rank = 1, size_label = ? WHERE id = ?')
      .run('Frontier', modelDbId);

    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, models: ['relay-a', 'relay-b'], apiKey: 'k' });

    const kept = chatModel('relay-a')!;
    expect([kept.intelligence_rank, kept.speed_rank, kept.size_label]).toEqual([1, 1, 'Frontier']);
    expect(chatModel('relay-b')!.size_label).toBe('Large');
  });
});
