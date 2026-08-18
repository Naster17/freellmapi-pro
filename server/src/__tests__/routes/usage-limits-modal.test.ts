import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function getUsage(app: Express) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/usage-limits`, {
    headers: { Authorization: `Bearer ${dashToken}` },
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: body as any };
}

function seedScopedModalKey(label: string, scope: string[] | null): number {
  const { encrypted, iv, authTag } = encrypt('wk-x.ws-y');
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, model_scope_json)
    VALUES ('modal', ?, ?, ?, ?, 'healthy', 1, 'https://x--ep.us.modal.direct/v1', ?)
  `).run(label, encrypted, iv, authTag, scope ? JSON.stringify(scope) : null);
  return Number(result.lastInsertRowid);
}

function seedModalKey(): number {
  const { encrypted, iv, authTag } = encrypt('wk-x.ws-y');
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, model_scope_json)
    VALUES ('modal', 'kimi', ?, ?, ?, 'healthy', 1, 'https://x--ep-kimi.us.modal.direct/v1', ?)
  `).run(encrypted, iv, authTag, JSON.stringify(['moonshotai/Kimi-K3']));
  return Number(result.lastInsertRowid);
}

describe('Modal dollar-metered usage', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('seeds the modal models with paid per-token pricing', () => {
    const kimi = getDb().prepare(
      "SELECT paid_input_per_m, paid_output_per_m, paid_cached_per_m FROM models WHERE platform = 'modal' AND model_id = 'moonshotai/Kimi-K3'",
    ).get() as { paid_input_per_m: number; paid_output_per_m: number; paid_cached_per_m: number };
    expect(kimi).toEqual({ paid_input_per_m: 3.0, paid_output_per_m: 15.0, paid_cached_per_m: 0.3 });
  });

  it('reports dollar spend per key and per model instead of RPM/RPD for modal', async () => {
    const keyId = seedModalKey();
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, cached_tokens, created_at)
      VALUES ('modal', 'moonshotai/Kimi-K3', ?, 'success', 1000000, 100000, 200000, datetime('now'))
    `).run(keyId);

    const { status, body } = await getUsage(app);
    expect(status).toBe(200);

    const kimi = body.models.find((m: any) => m.platform === 'modal' && m.modelId === 'moonshotai/Kimi-K3');
    expect(kimi).toBeTruthy();

    // (1M - 200K) * $3 + 200K * $0.30 + 100K * $15 = $3.96.
    expect(kimi.spend.used).toBe(3.96);
    expect(kimi.spend.limit).toBe(30);

    const key = kimi.keys.find((k: any) => k.keyId === keyId);
    expect(key.spend.used).toBe(3.96);
    expect(key.spend.limit).toBe(30);

    // Modal keys have no RPM/RPD/TPM/TPD ceilings — every counter is uncapped.
    expect(kimi.rpm.limit).toBeNull();
    expect(kimi.rpd.limit).toBeNull();
    expect(kimi.tpm.limit).toBeNull();
    expect(kimi.tpd.limit).toBeNull();
  });

  it('lists each modal key only under the models its endpoint serves', async () => {
    const kimiKey = seedScopedModalKey('kimi', ['moonshotai/Kimi-K3']);
    const qwenKey = seedScopedModalKey('qwen', ['Qwen/Qwen3.8-2.4T-A95B']);
    const sharedKey = seedScopedModalKey('shared', null);

    const { status, body } = await getUsage(app);
    expect(status).toBe(200);

    const kimi = body.models.find((m: any) => m.platform === 'modal' && m.modelId === 'moonshotai/Kimi-K3');
    const qwen = body.models.find((m: any) => m.platform === 'modal' && m.modelId === 'Qwen/Qwen3.8-2.4T-A95B');

    expect(kimi.keys.map((k: any) => k.keyId).sort()).toEqual([kimiKey, sharedKey].sort());
    expect(qwen.keys.map((k: any) => k.keyId).sort()).toEqual([qwenKey, sharedKey].sort());
    expect(kimi.keyCount).toBe(2);
    expect(qwen.keyCount).toBe(2);
  });

  it('returns a null spend counter for non-modal models', async () => {
    const { encrypted, iv, authTag } = encrypt('gsk-test');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'groq-test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);

    const { body } = await getUsage(app);
    const groq = body.models.find((m: any) => m.platform === 'groq');
    expect(groq).toBeTruthy();
    expect(groq.spend).toBeNull();
  });
});
