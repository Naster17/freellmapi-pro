import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Keys API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('GET /api/keys returns empty array initially', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/keys creates a new key', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
      label: 'My Groq Key',
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.label).toBe('My Groq Key');
    expect(body.maskedKey).toContain('...');
  });

  it('GET /api/keys returns the created key', async () => {
    // First create a key
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].platform).toBe('groq');
  });

  it('POST /api/keys rejects invalid platform', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'invalid_platform',
      key: 'test',
    });
    expect(status).toBe(400);
  });

  it('POST /api/keys rejects missing key', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
    });
    expect(status).toBe(400);
  });

  it('POST /api/keys creates multiple keyless provider entries', async () => {
    const first = await request(app, 'POST', '/api/keys', {
      platform: 'kilo',
      label: 'Kilo slot 1',
    });
    const second = await request(app, 'POST', '/api/keys', {
      platform: 'kilo',
      label: 'Kilo slot 2',
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);

    const { body: keys } = await request(app, 'GET', '/api/keys');
    expect(keys).toHaveLength(2);
    expect(keys.map((k: any) => k.label).sort()).toEqual(['Kilo slot 1', 'Kilo slot 2']);
  });

  it('DELETE /api/keys/:id removes a key', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status } = await request(app, 'DELETE', `/api/keys/${created.id}`);
    expect(status).toBe(200);

    const { body: after } = await request(app, 'GET', '/api/keys');
    expect(after).toHaveLength(0);
  });

  it('DELETE /api/keys/:id returns 404 for nonexistent key', async () => {
    const { status } = await request(app, 'DELETE', '/api/keys/99999');
    expect(status).toBe(404);
  });

  it('PATCH /api/keys/:id updates label', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status, body } = await request(app, 'PATCH', `/api/keys/${created.id}`, {
      label: 'Production key',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.label).toBe('Production key');

    const { body: keys } = await request(app, 'GET', '/api/keys');
    expect(keys[0].label).toBe('Production key');
  });

  it('PATCH /api/keys/:id updates both enabled and label', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status, body } = await request(app, 'PATCH', `/api/keys/${created.id}`, {
      enabled: false,
      label: 'Disabled key',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.label).toBe('Disabled key');

    const { body: keys } = await request(app, 'GET', '/api/keys');
    expect(keys[0].enabled).toBe(false);
    expect(keys[0].label).toBe('Disabled key');
  });

  it('PATCH /api/keys/:id clears label', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
      label: 'Temporary label',
    });

    const { status, body } = await request(app, 'PATCH', `/api/keys/${created.id}`, {
      label: '',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.label).toBe('');

    const { body: keys } = await request(app, 'GET', '/api/keys');
    expect(keys[0].label).toBe('');
  });

  it('PATCH /api/keys/:id returns 400 when no fields provided', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status } = await request(app, 'PATCH', `/api/keys/${created.id}`, {});
    expect(status).toBe(400);
  });

  it('PATCH /api/keys/:id returns 404 for nonexistent key', async () => {
    const { status } = await request(app, 'PATCH', '/api/keys/99999', { label: 'test' });
    expect(status).toBe(404);
  });
});

describe('Keys export/import', () => {
  let app: Express;
  let localToken = '';

  async function localRequest(method: string, path: string, body?: any) {
    const server = app.listen(0);
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(isGatedApiPath(path) ? { Authorization: `Bearer ${localToken}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body: data };
  }

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '1'.repeat(64);
    initDb(':memory:');
    app = createApp();
    localToken = mintDashboardToken('export@example.com');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('GET /api/keys/export returns unmasked keys with the v1 format', async () => {
    await localRequest('POST', '/api/keys', { platform: 'groq', key: 'gsk_export_test_123', label: 'export me' });
    await localRequest('POST', '/api/keys', { platform: 'kilo', label: 'keyless' });

    const { status, body } = await localRequest('GET', '/api/keys/export');
    expect(status).toBe(200);
    expect(body.format).toBe('freellmapi-keys-v1');
    expect(typeof body.exportedAt).toBe('string');
    expect(body.count).toBe(2);
    const groq = body.keys.find((k: any) => k.platform === 'groq');
    expect(groq.key).toBe('gsk_export_test_123');
    expect(groq.label).toBe('export me');
    const kilo = body.keys.find((k: any) => k.platform === 'kilo');
    expect(kilo.key).toBe('no-key');
  });

  it('GET /api/keys/export requires dashboard auth', async () => {
    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/export`);
    server.close();
    expect(res.status).toBe(401);
  });

  it('POST /api/keys/import adds new keys and skips duplicates', async () => {
    await localRequest('POST', '/api/keys', { platform: 'groq', key: 'gsk_existing_001' });

    const { status, body } = await localRequest('POST', '/api/keys/import', {
      format: 'freellmapi-keys-v1',
      keys: [
        { platform: 'groq', key: 'gsk_existing_001' },
        { platform: 'groq', key: 'gsk_new_002' },
        { platform: 'cerebras', key: 'csk_new_003', label: 'Cerebras new' },
        { platform: 'kilo' },
      ],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(3);
    expect(body.skipped).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.skippedKeys[0].reason).toMatch(/key already exists/);

    const { body: list } = await localRequest('GET', '/api/keys');
    const platforms = list.map((k: any) => `${k.platform}:${k.maskedKey}`).sort();
    expect(platforms).toContain('groq:gsk_..._001');
  });

  it('POST /api/keys/import dedupes within the batch itself', async () => {
    const { status, body } = await localRequest('POST', '/api/keys/import', {
      format: 'freellmapi-keys-v1',
      keys: [
        { platform: 'groq', key: 'gsk_dup_001' },
        { platform: 'groq', key: 'gsk_dup_001' },
      ],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.skippedKeys[0].reason).toMatch(/duplicate key in batch/);
  });

  it('POST /api/keys/import dedupes custom providers by baseUrl', async () => {
    await localRequest('POST', '/api/keys/custom', { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:4b' });

    const { status, body } = await localRequest('POST', '/api/keys/import', {
      format: 'freellmapi-keys-v1',
      keys: [
        { platform: 'custom', baseUrl: 'http://localhost:11434/v1/', key: 'abc', models: [] },
        { platform: 'custom', baseUrl: 'http://other.local:9000/v1', key: 'xyz', models: [] },
      ],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.skippedKeys[0].reason).toMatch(/baseUrl/);
  });

  it('POST /api/keys/import rejects unknown format', async () => {
    const { status, body } = await localRequest('POST', '/api/keys/import', {
      format: 'something-else',
      keys: [{ platform: 'groq', key: 'gsk_x' }],
    });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/Unsupported format/);
  });

  it('POST /api/keys/import rejects empty key list', async () => {
    const { status } = await localRequest('POST', '/api/keys/import', { keys: [] });
    expect(status).toBe(400);
  });

  it('POST /api/keys/import exports, re-imports, then a second import skips the new keys', async () => {
    await localRequest('POST', '/api/keys', { platform: 'groq', key: 'gsk_round_trip' });

    const exp = await localRequest('GET', '/api/keys/export');
    expect(exp.status).toBe(200);
    const before = getDb().prepare('SELECT COUNT(*) as n FROM api_keys').get() as { n: number };

    const first = await localRequest('POST', '/api/keys/import', { format: exp.body.format, keys: exp.body.keys });
    expect(first.status).toBe(200);
    expect(first.body.skipped).toBeGreaterThanOrEqual(1);

    const after = getDb().prepare('SELECT COUNT(*) as n FROM api_keys').get() as { n: number };
    expect(after.n).toBe(before.n);

    const second = await localRequest('POST', '/api/keys/import', { format: exp.body.format, keys: exp.body.keys });
    expect(second.status).toBe(200);
    expect(second.body.imported).toBe(0);
    expect(second.body.skipped).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/keys/import dedupes by label when dedupeByLabel is enabled (default)', async () => {
    await localRequest('POST', '/api/keys', { platform: 'groq', key: 'gsk_label_existing', label: 'Production' });

    const { status, body } = await localRequest('POST', '/api/keys/import', {
      format: 'freellmapi-keys-v1',
      keys: [
        { platform: 'groq', key: 'gsk_label_new', label: 'Production' },
        { platform: 'groq', key: 'gsk_label_other', label: 'staging' },
        { platform: 'groq', key: 'gsk_label_no_label' },
      ],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(2);
    expect(body.skipped).toBe(1);
    const skipped = body.skippedKeys[0];
    expect(skipped.label).toBe('Production');
    expect(skipped.reason).toMatch(/label already exists/);
  });

  it('POST /api/keys/import label dedup is case-insensitive and trimmed', async () => {
    await localRequest('POST', '/api/keys', { platform: 'groq', key: 'gsk_seed', label: '  My Key  ' });

    const { status, body } = await localRequest('POST', '/api/keys/import', {
      format: 'freellmapi-keys-v1',
      keys: [
        { platform: 'groq', key: 'gsk_different_value', label: 'my KEY' },
      ],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.skippedKeys[0].reason).toMatch(/label already exists/);
  });

  it('POST /api/keys/import label dedup respects dedupeByLabel=false', async () => {
    await localRequest('POST', '/api/keys', { platform: 'groq', key: 'gsk_a', label: 'shared' });

    const { status, body } = await localRequest('POST', '/api/keys/import', {
      format: 'freellmapi-keys-v1',
      dedupeByLabel: false,
      keys: [
        { platform: 'groq', key: 'gsk_b', label: 'shared' },
      ],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(0);
  });

  it('POST /api/keys/import dedupes by label within the same batch', async () => {
    const { status, body } = await localRequest('POST', '/api/keys/import', {
      format: 'freellmapi-keys-v1',
      keys: [
        { platform: 'groq', key: 'gsk_x1', label: 'dup-label' },
        { platform: 'groq', key: 'gsk_x2', label: 'DUP-LABEL' },
      ],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.skippedKeys[0].reason).toMatch(/duplicate label in batch/);
  });

  it('POST /api/keys/import dedupes custom providers by baseUrl label combination', async () => {
    await localRequest('POST', '/api/keys/custom', {
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:4b',
      label: 'Home Ollama',
    });

    const { status, body } = await localRequest('POST', '/api/keys/import', {
      format: 'freellmapi-keys-v1',
      keys: [
        { platform: 'custom', baseUrl: 'http://other.local:9000/v1', key: 'k', label: 'home ollama', models: [] },
      ],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.skippedKeys[0].reason).toMatch(/label already exists/);
  });
});
