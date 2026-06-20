import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('runtime provider key invalidation', () => {
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
    db.prepare('DELETE FROM requests').run();
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'google' AND model_id = 'gemma-4-26b-a4b-it'").run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables a Google key immediately on project-denied request errors', async () => {
    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'AIza_project_denied_test',
      label: 'project-denied',
    });
    expect(addKey.status).toBe(201);
    const keyId = addKey.body.id;

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com') && urlStr.includes(':generateContent')) {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: () => Promise.resolve({
            error: {
              code: 403,
              message: 'Your project has been denied access to this API.',
              status: 'PERMISSION_DENIED',
            },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const completion = await request(app, 'POST', '/v1/chat/completions', {
      model: 'google:gemma-4-26b-a4b-it',
      messages: [{ role: 'user', content: 'Reply only with: OK' }],
      max_tokens: 8,
      temperature: 0,
    }, authHeaders());

    expect(completion.status).toBe(429);
    const row = getDb().prepare('SELECT status, enabled, last_checked_at FROM api_keys WHERE id = ?').get(keyId) as any;
    expect(row.status).toBe('invalid');
    expect(row.enabled).toBe(0);
    expect(row.last_checked_at).toBeTruthy();
  });
});
