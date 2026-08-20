import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { applyRequestAggregates } from '../../lib/request-aggregate.js';
import { mintDashboardToken } from '../helpers/auth.js';

async function get(app: Express, path: string, token: string) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  server.close();
  return { status: response.status, body: body as any };
}

describe('GET /api/analytics/by-client', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM request_daily_platform').run();
    getDb().prepare('DELETE FROM request_daily_model').run();
    getDb().prepare('DELETE FROM request_daily_client').run();
    getDb().prepare('DELETE FROM request_daily_key').run();
    const insert = getDb().prepare(`
      INSERT INTO requests
        (platform, model_id, status, input_tokens, output_tokens, latency_ms, client_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    insert.run('groq', 'coder', 'success', 10, 5, 100, 'claude-code');
    insert.run('groq', 'coder', 'error', 8, 0, 300, 'claude-code');
    insert.run('google', 'flash', 'success', 4, 2, 80, 'gemini-cli');
    const rows = getDb().prepare(`
      SELECT platform, model_id, status, input_tokens, output_tokens, latency_ms, client_agent, created_at
      FROM requests ORDER BY id
    `).all() as Array<{ platform: string; model_id: string; status: string; input_tokens: number; output_tokens: number; latency_ms: number; client_agent: string | null; created_at: string }>;
    for (const row of rows) {
      applyRequestAggregates(getDb(), {
        createdAt: row.created_at,
        platform: row.platform,
        modelId: row.model_id,
        keyId: null,
        status: row.status,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cachedTokens: 0,
        latencyMs: row.latency_ms,
        ttfbMs: null,
        requestedModel: null,
        clientAgent: row.client_agent,
        requestType: 'chat',
      });
    }
  });

  it('groups request volume and success by detected agent', async () => {
    const response = await get(app, '/api/analytics/by-client?range=7d', token);
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({
      clientAgent: 'claude-code',
      requests: 2,
      successRate: 50,
      avgLatencyMs: 200,
    });
    expect(response.body[1]).toMatchObject({
      clientAgent: 'gemini-cli',
      requests: 1,
      successRate: 100,
    });
  });
});
