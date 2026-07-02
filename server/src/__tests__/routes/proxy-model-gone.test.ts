import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy, setStrictChain } = await import('../../services/router.js');
const { _clearInMemoryRateLimitStateForTest } = await import('../../services/ratelimit.js');

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json, raw, headers: res.headers };
}

function makeEolError(): Error {
  const err = new Error("The model 'z-ai/glm-5.1' has reached its end of life on 2026-07-02T00:00:00Z and is no longer available.") as Error & { status: number };
  err.status = 410;
  return err;
}

describe('Proxy 410 Gone: model no longer available (NVIDIA EOL case)', () => {
  let app: Express;
  let key: string;
  let nvidiaModelId: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    const db = getDb();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-nvidia-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('nvidia', 'eol-test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
    const row = db.prepare("SELECT model_id FROM models WHERE platform = 'nvidia' AND enabled = 1 ORDER BY intelligence_rank ASC LIMIT 1").get() as { model_id: string };
    nvidiaModelId = row.model_id;
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    _clearInMemoryRateLimitStateForTest();
    setStrictChain(false);
  });

  it('returns 410 with type=model_gone when a pinned model is end-of-life, instead of "All models rate-limited"', async () => {
    chatCompletion.mockRejectedValue(makeEolError());

    const { status, body } = await post(app, '/v1/chat/completions', {
      model: nvidiaModelId,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(410);
    expect(body.error.type).toBe('model_gone');
    expect(body.error.code).toBe('model_no_longer_available');
    expect(body.error.message).toMatch(/is no longer available/);
    expect(body.error.message).toMatch(/end of life/);
    expect(body.error.model).toBeDefined();
    expect(body.error.model.platform).toBe('nvidia');
    expect(body.error.model.id).toBe(nvidiaModelId);
    expect(body.error.model.display_name).toBeDefined();
  });

  it('does NOT return the misleading "All models rate-limited" 429 for an EOL model', async () => {
    chatCompletion.mockRejectedValue(makeEolError());

    const { status, body } = await post(app, '/v1/chat/completions', {
      model: nvidiaModelId,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).not.toBe(429);
    expect(body.error.type).not.toBe('rate_limit_error');
    expect(body.error.message).not.toMatch(/All models rate-limited/);
  });

  it('persists the EOL model on a long cooldown (model_eol reason) so it is skipped on subsequent requests', async () => {
    chatCompletion.mockRejectedValue(makeEolError());

    await post(app, '/v1/chat/completions', {
      model: nvidiaModelId,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    const db = getDb();
    const cooldown = db.prepare(`
      SELECT reason, expires_at_ms FROM rate_limit_cooldowns
       WHERE platform = 'nvidia' AND model_id = ?
    `).get(nvidiaModelId) as { reason: string; expires_at_ms: number } | undefined;

    expect(cooldown).toBeDefined();
    expect(cooldown!.reason).toBe('model_eol');
    const remaining = cooldown!.expires_at_ms - Date.now();
    expect(remaining).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it('also handles legacy /v1/completions endpoint with the same 410 model_gone response', async () => {
    chatCompletion.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    chatCompletion.mockRejectedValueOnce(makeEolError());
    chatCompletion.mockReset();
    chatCompletion.mockRejectedValue(makeEolError());

    const { status, body } = await post(app, '/v1/completions', {
      model: nvidiaModelId,
      prompt: 'hi',
    }, key);

    expect(status).toBe(410);
    expect(body.error.type).toBe('model_gone');
    expect(body.error.code).toBe('model_no_longer_available');
  });

  it('still tries the next chain entry when the failed model is not pinned — the gone error does not block failover', async () => {
    const db = getDb();
    const otherRow = db.prepare("SELECT model_id FROM models WHERE platform != 'nvidia' AND enabled = 1 ORDER BY intelligence_rank ASC LIMIT 1").get() as { model_id: string };
    if (!otherRow) return;

    let calls = 0;
    chatCompletion.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw makeEolError();
      return {
        choices: [{ message: { role: 'assistant', content: 'recovered' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    });

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('recovered');
  });
});
