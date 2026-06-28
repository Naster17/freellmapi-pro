import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, setRoutingStrategy, setStrictChain, setProbeOnCooldown } from '../../services/router.js';
import { setCooldown, _clearInMemoryRateLimitStateForTest } from '../../services/ratelimit.js';

describe('Router strict chain mode', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    setRoutingStrategy('priority');
    setStrictChain(false);
    setProbeOnCooldown(false);
    db.prepare('DELETE FROM api_keys').run();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    _clearInMemoryRateLimitStateForTest();
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws unavailable-model 429 when strict is on, no explicit pin, and the first model is fully cooled', async () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    const result = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);
    const keyId = Number(result.lastInsertRowid);

    const groqModel = db.prepare("SELECT id, model_id FROM models WHERE platform = 'groq' ORDER BY intelligence_rank ASC LIMIT 1").get() as { id: number; model_id: string } | undefined;
    expect(groqModel).toBeDefined();
    setCooldown('groq', groqModel!.model_id, keyId, 10 * 60_000, 'rate_limited');

    db.prepare("UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?").run(groqModel!.id);
    setRoutingStrategy('priority');
    setStrictChain(true);

    let caught: any;
    try {
      await routeRequest(100);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(429);
    expect(caught.message).toMatch(/rate-limited/);
    expect(caught.cooldown).toBeDefined();
    expect(caught.cooldown.length).toBeGreaterThan(0);
    expect(caught.cooldown[0].platform).toBe('groq');
  });

  it('falls over silently when strict is off even if first model is cooled', async () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    setStrictChain(false);
    const result = await routeRequest(100);
    expect(result.platform).toBe('groq');
  });
});

describe('Router explicit model pin — universal chain fallover on cooldown', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    setRoutingStrategy('priority');
    setStrictChain(false);
    setProbeOnCooldown(false);
    db.prepare('DELETE FROM api_keys').run();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    _clearInMemoryRateLimitStateForTest();
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips the pinned opencode model when all its keys are in cooldown and routes to a different model', async () => {
    const db = getDb();
    const opencodeKey = encrypt('test-opencode-key');
    const opencodeRes = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('opencode', 'test', opencodeKey.encrypted, opencodeKey.iv, opencodeKey.authTag, 'healthy', 1);
    const opencodeKeyId = Number(opencodeRes.lastInsertRowid);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const mimo = db.prepare("SELECT id, model_id FROM models WHERE platform = 'opencode' AND model_id = 'mimo-v2.5-free'").get() as { id: number; model_id: string } | undefined;
    expect(mimo).toBeDefined();

    for (const opencodeModel of db.prepare("SELECT model_id FROM models WHERE platform = 'opencode'").all() as { model_id: string }[]) {
      setCooldown('opencode', opencodeModel.model_id, opencodeKeyId, 10 * 60_000, 'rate_limited');
    }

    db.prepare("UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?").run(mimo!.id);

    const result = await routeRequest(100, undefined, mimo!.id, false, false, undefined, undefined, undefined, true);
    expect(result).toBeDefined();
    expect(result.platform).toBe('groq');
    expect(result.modelId).not.toBe('mimo-v2.5-free');
  });

  it('skips the pinned groq model when all its keys are in cooldown and routes to a different model', async () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    const groqRes = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);
    const groqKeyId = Number(groqRes.lastInsertRowid);

    const opencodeKey = encrypt('test-opencode-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('opencode', 'test', opencodeKey.encrypted, opencodeKey.iv, opencodeKey.authTag, 'healthy', 1);

    const groqModel = db.prepare("SELECT id, model_id FROM models WHERE platform = 'groq' ORDER BY intelligence_rank ASC LIMIT 1").get() as { id: number; model_id: string } | undefined;
    expect(groqModel).toBeDefined();
    setCooldown('groq', groqModel!.model_id, groqKeyId, 10 * 60_000, 'rate_limited');

    db.prepare("UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?").run(groqModel!.id);

    const result = await routeRequest(100, undefined, groqModel!.id, false, false, undefined, undefined, undefined, true);
    expect(result).toBeDefined();
    expect(result.platform).toBe('opencode');
    expect(result.modelId).not.toBe(groqModel!.model_id);
  });

  it('tries all opencode keys for the pinned model before falling over to the next model in chain', async () => {
    const db = getDb();
    const db2 = getDb();
    for (let i = 0; i < 3; i++) {
      const r = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('opencode', `oc-${i}`, encrypt(`oc-key-${i}`).encrypted, encrypt(`oc-key-${i}`).iv, encrypt(`oc-key-${i}`).authTag, 'healthy', 1);
      const keyId = Number(r.lastInsertRowid);
      setCooldown('opencode', 'mimo-v2.5-free', keyId, 10 * 60_000, 'rate_limited');
    }
    const groqKey = encrypt('test-groq-key');
    db2.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const mimo = db.prepare("SELECT id, model_id FROM models WHERE platform = 'opencode' AND model_id = 'mimo-v2.5-free'").get() as { id: number; model_id: string } | undefined;
    expect(mimo).toBeDefined();
    db.prepare("UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?").run(mimo!.id);

    const result = await routeRequest(100, undefined, mimo!.id, false, false, undefined, undefined, undefined, true);
    expect(result).toBeDefined();
    expect(result.platform).toBe('groq');
  });

  it('throws All models exhausted with unavailableModels list when the entire chain is cooled for the explicit pin', async () => {
    const db = getDb();
    const opencodeKey = encrypt('test-opencode-key');
    const opencodeRes = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('opencode', 'test', opencodeKey.encrypted, opencodeKey.iv, opencodeKey.authTag, 'healthy', 1);
    const opencodeKeyId = Number(opencodeRes.lastInsertRowid);

    const allOpencode = db.prepare("SELECT id, model_id FROM models WHERE platform = 'opencode'").all() as { id: number; model_id: string }[];
    for (const m of allOpencode) {
      setCooldown('opencode', m.model_id, opencodeKeyId, 10 * 60_000, 'rate_limited');
    }

    const mimo = allOpencode.find(m => m.model_id === 'mimo-v2.5-free')!;
    db.prepare("UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?").run(mimo.id);

    let caught: any;
    try {
      await routeRequest(100, undefined, mimo.id, false, false, undefined, undefined, undefined, true);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(429);
    expect(caught.message).toMatch(/All models exhausted/);
    expect(caught.unavailableModels).toBeDefined();
    expect(caught.unavailableModels.length).toBeGreaterThan(0);
    expect(caught.cooldown).toBeDefined();
    expect(caught.cooldown.length).toBeGreaterThan(0);
  });

  it('still throws unavailable-model 429 for the explicit pin if strict chain is on (legacy behavior preserved)', async () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    const groqRes = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);
    const groqKeyId = Number(groqRes.lastInsertRowid);

    const groqModel = db.prepare("SELECT id, model_id FROM models WHERE platform = 'groq' ORDER BY intelligence_rank ASC LIMIT 1").get() as { id: number; model_id: string } | undefined;
    expect(groqModel).toBeDefined();
    setCooldown('groq', groqModel!.model_id, groqKeyId, 10 * 60_000, 'rate_limited');

    db.prepare("UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?").run(groqModel!.id);
    setRoutingStrategy('priority');
    setStrictChain(true);

    let caught: any;
    try {
      await routeRequest(100, undefined, groqModel!.id, false, false, undefined, undefined, undefined, false);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(429);
    expect(caught.message).toMatch(/rate-limited/);
    expect(caught.cooldown).toBeDefined();
    expect(caught.cooldown.length).toBeGreaterThan(0);
  });
});
