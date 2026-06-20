import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { appendServerLog, clearServerLogs } from '../../lib/server-logs.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, path: string, init?: RequestInit) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...init?.headers,
    },
  });
  const data = await res.json().catch(() => null);
  server.close();

  return { status: res.status, body: data };
}

describe('Server logs API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    clearServerLogs();
  });

  it('returns recent logs with level filtering and redaction', async () => {
    appendServerLog('info', ['server ready']);
    appendServerLog('error', ['Google API error', 'api_key=AIza123456789012345678901234567890']);

    const { status, body } = await request(app, '/api/logs?levels=error');

    expect(status).toBe(200);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ level: 'error' });
    expect(body.entries[0].message).toContain('Google API error');
    expect(body.entries[0].message).not.toContain('AIza123456789012345678901234567890');
    expect(body.levels).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('clears the in-memory buffer', async () => {
    appendServerLog('warn', ['temporary issue']);

    const cleared = await request(app, '/api/logs/clear', { method: 'POST' });
    const listed = await request(app, '/api/logs');

    expect(cleared.status).toBe(200);
    expect(cleared.body.ok).toBe(true);
    expect(listed.body.entries).toEqual([]);
  });
});
