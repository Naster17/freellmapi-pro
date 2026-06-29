import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let app: Express;
let dashToken = '';

async function request(method: string, path: string, body?: any) {
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

describe('GET/PUT /api/settings/context-handoff', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.FREELLMAPI_CONTEXT_HANDOFF;
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM settings WHERE key = 'context_handoff_mode'").run();
  });

  afterAll(() => {
    getDb().prepare("DELETE FROM settings WHERE key = 'context_handoff_mode'").run();
  });

  it('returns enabled=false by default', async () => {
    const res = await request('GET', '/api/settings/context-handoff');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it('persists a PUT of enabled=true', async () => {
    const res = await request('PUT', '/api/settings/context-handoff', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });

    const get = await request('GET', '/api/settings/context-handoff');
    expect(get.body).toEqual({ enabled: true });
  });

  it('persists a PUT of enabled=false', async () => {
    await request('PUT', '/api/settings/context-handoff', { enabled: true });
    const res = await request('PUT', '/api/settings/context-handoff', { enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it('rejects missing enabled', async () => {
    const res = await request('PUT', '/api/settings/context-handoff', {});
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('rejects non-boolean enabled', async () => {
    const res = await request('PUT', '/api/settings/context-handoff', { enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('honors env var when DB is unset', async () => {
    process.env.FREELLMAPI_CONTEXT_HANDOFF = 'on_model_switch';
    const res = await request('GET', '/api/settings/context-handoff');
    expect(res.body).toEqual({ enabled: true });
    delete process.env.FREELLMAPI_CONTEXT_HANDOFF;
  });

  it('DB setting overrides env var', async () => {
    process.env.FREELLMAPI_CONTEXT_HANDOFF = 'on_model_switch';
    await request('PUT', '/api/settings/context-handoff', { enabled: false });
    const res = await request('GET', '/api/settings/context-handoff');
    expect(res.body).toEqual({ enabled: false });
    delete process.env.FREELLMAPI_CONTEXT_HANDOFF;
  });
});

describe('GET/PUT /api/settings/analytics-retention', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.REQUEST_ANALYTICS_RETENTION_DAYS;
    delete process.env.REQUEST_ANALYTICS_MAX_ROWS;
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM settings WHERE key IN ('analytics_retention_days', 'analytics_max_rows')").run();
  });

  afterAll(() => {
    getDb().prepare("DELETE FROM settings WHERE key IN ('analytics_retention_days', 'analytics_max_rows')").run();
  });

  it('returns the hardcoded defaults when nothing is saved', async () => {
    const res = await request('GET', '/api/settings/analytics-retention');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ retentionDays: 90, maxRows: 100000 });
  });

  it('persists a full PUT', async () => {
    const res = await request('PUT', '/api/settings/analytics-retention', { retentionDays: 30, maxRows: 50000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ retentionDays: 30, maxRows: 50000 });

    const get = await request('GET', '/api/settings/analytics-retention');
    expect(get.body).toEqual({ retentionDays: 30, maxRows: 50000 });
  });

  it('accepts a partial update — retentionDays only', async () => {
    await request('PUT', '/api/settings/analytics-retention', { retentionDays: 30, maxRows: 50000 });
    const res = await request('PUT', '/api/settings/analytics-retention', { retentionDays: 60 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ retentionDays: 60, maxRows: 50000 });
  });

  it('accepts a partial update — maxRows only', async () => {
    await request('PUT', '/api/settings/analytics-retention', { retentionDays: 30, maxRows: 50000 });
    const res = await request('PUT', '/api/settings/analytics-retention', { maxRows: 25000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ retentionDays: 30, maxRows: 25000 });
  });

  it('accepts 0 to disable', async () => {
    const res = await request('PUT', '/api/settings/analytics-retention', { retentionDays: 0, maxRows: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ retentionDays: 0, maxRows: 0 });
  });

  it('rejects negative values', async () => {
    const res = await request('PUT', '/api/settings/analytics-retention', { retentionDays: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('rejects non-integer values', async () => {
    const res = await request('PUT', '/api/settings/analytics-retention', { retentionDays: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('rejects string values', async () => {
    const res = await request('PUT', '/api/settings/analytics-retention', { retentionDays: '30' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('honors env vars when DB is unset', async () => {
    process.env.REQUEST_ANALYTICS_RETENTION_DAYS = '7';
    process.env.REQUEST_ANALYTICS_MAX_ROWS = '1000';
    const res = await request('GET', '/api/settings/analytics-retention');
    expect(res.body).toEqual({ retentionDays: 7, maxRows: 1000 });
    delete process.env.REQUEST_ANALYTICS_RETENTION_DAYS;
    delete process.env.REQUEST_ANALYTICS_MAX_ROWS;
  });

  it('DB setting overrides env vars', async () => {
    process.env.REQUEST_ANALYTICS_RETENTION_DAYS = '7';
    await request('PUT', '/api/settings/analytics-retention', { retentionDays: 14 });
    const res = await request('GET', '/api/settings/analytics-retention');
    expect(res.body.retentionDays).toBe(14);
    delete process.env.REQUEST_ANALYTICS_RETENTION_DAYS;
  });
});
