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

  it('throws a 429 with the unavailable model and cooldown list when strict is on and preferred model is fully cooled', async () => {
    const db = getDb();
    const opencodeKey = encrypt('test-opencode-key');
    const result = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('opencode', 'test', opencodeKey.encrypted, opencodeKey.iv, opencodeKey.authTag, 'healthy', 1);
    const keyId = Number(result.lastInsertRowid);

    const mimo = db.prepare("SELECT id, model_id FROM models WHERE platform = 'opencode' AND model_id = 'mimo-v2.5-free'").get() as { id: number; model_id: string } | undefined;
    expect(mimo).toBeDefined();
    setCooldown('opencode', mimo!.model_id, keyId, 10 * 60_000, 'rate_limited');

    db.prepare("UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?").run(mimo!.id);
    db.prepare(`
      UPDATE fallback_config SET priority = model_db_id * 1000 WHERE model_db_id != ?
    `).run(mimo!.id);
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
    expect(caught.cooldown[0].platform).toBe('opencode');
    expect(caught.cooldown[0].modelId).toBe(mimo!.model_id);
    expect(caught.cooldown[0].reason).toBe('rate_limited');
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
