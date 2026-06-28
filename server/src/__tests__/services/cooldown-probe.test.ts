import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setCooldown, clearPersistedCooldown, isOnCooldown } from '../../services/ratelimit.js';
import { setSetting } from '../../db/index.js';
import { setProbeOnCooldown, setStrictChain } from '../../services/router.js';
import { getActiveCooldowns, probeAllActiveCooldowns } from '../../services/cooldown-probe.js';

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

describe('cooldown-probe service', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM api_keys').run();
    setSetting('router_probe_on_cooldown', '1');
    setSetting('router_strict_chain', '1');
  });

  describe('getActiveCooldowns', () => {
    it('returns an empty array when no cooldowns are set', () => {
      expect(getActiveCooldowns()).toEqual([]);
    });

    it('lists active (unexpired) cooldowns with remaining seconds', () => {
      const { encrypted, iv, authTag } = encrypt('test-key');
      const result = getDb().prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('groq', 'k1', encrypted, iv, authTag, 'healthy', 1);
      const keyId = Number(result.lastInsertRowid);

      setCooldown('groq', 'llama-3.3-70b', keyId, 5 * 60_000, 'rate_limited');

      const cooldowns = getActiveCooldowns();
      expect(cooldowns).toHaveLength(1);
      expect(cooldowns[0]).toMatchObject({
        platform: 'groq',
        modelId: 'llama-3.3-70b',
        keyId,
        reason: 'rate_limited',
      });
      expect(cooldowns[0].remainingSeconds).toBeGreaterThan(0);
      expect(cooldowns[0].remainingSeconds).toBeLessThanOrEqual(300);
    });

    it('omits expired cooldowns', () => {
      const { encrypted, iv, authTag } = encrypt('test-key');
      const result = getDb().prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('groq', 'k1', encrypted, iv, authTag, 'healthy', 1);
      const keyId = Number(result.lastInsertRowid);

      setCooldown('groq', 'old-model', keyId, 100, 'rate_limited');
      setTimeout(() => {}, 200);
      const future = Date.now() + 1000;
      vi.setSystemTime(future);
      expect(getActiveCooldowns()).toEqual([]);
      vi.useRealTimers();
    });

    it('returns null reason when no reason is annotated', () => {
      const { encrypted, iv, authTag } = encrypt('test-key');
      const result = getDb().prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('groq', 'k1', encrypted, iv, authTag, 'healthy', 1);
      const keyId = Number(result.lastInsertRowid);

      setCooldown('groq', 'm', keyId, 60_000);
      const cooldowns = getActiveCooldowns();
      expect(cooldowns).toHaveLength(1);
      expect(cooldowns[0].reason).toBeNull();
    });
  });

  describe('clearPersistedCooldown', () => {
    it('removes a row from rate_limit_cooldowns and the in-memory cooldown map', () => {
      const { encrypted, iv, authTag } = encrypt('test-key');
      const result = getDb().prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('groq', 'k1', encrypted, iv, authTag, 'healthy', 1);
      const keyId = Number(result.lastInsertRowid);

      setCooldown('groq', 'm', keyId, 60_000);
      expect(getActiveCooldowns()).toHaveLength(1);
      expect(isOnCooldown('groq', 'm', keyId)).toBe(true);
      clearPersistedCooldown('groq', 'm', keyId);
      expect(getActiveCooldowns()).toHaveLength(0);
      expect(isOnCooldown('groq', 'm', keyId)).toBe(false);
    });
  });

  describe('setProbeOnCooldown / setStrictChain', () => {
    it('toggles probe_on_cooldown', () => {
      setProbeOnCooldown(false);
      expect(getDb().prepare("SELECT value FROM settings WHERE key = 'router_probe_on_cooldown'").get()).toEqual({ value: '0' });
      setProbeOnCooldown(true);
      expect(getDb().prepare("SELECT value FROM settings WHERE key = 'router_probe_on_cooldown'").get()).toEqual({ value: '1' });
    });

    it('toggles strict_chain', () => {
      setStrictChain(true);
      expect(getDb().prepare("SELECT value FROM settings WHERE key = 'router_strict_chain'").get()).toEqual({ value: '1' });
      setStrictChain(false);
      expect(getDb().prepare("SELECT value FROM settings WHERE key = 'router_strict_chain'").get()).toEqual({ value: '0' });
    });
  });

  describe('probeAllActiveCooldowns', () => {
    beforeEach(() => {
      chatCompletion.mockReset();
      streamChatCompletion.mockReset();
      const db = getDb();
      db.prepare("DELETE FROM rate_limit_cooldowns").run();
      db.prepare("DELETE FROM profile_models").run();
      db.prepare("DELETE FROM fallback_config").run();
      db.prepare("DELETE FROM models WHERE platform = 'groq'").run();
    });

    it('returns an empty summary when there are no enabled keys', async () => {
      const summary = await probeAllActiveCooldowns(1000);
      expect(summary).toEqual({ probed: 0, recovered: [], newlyCooled: [], stillCooled: 0, timedOut: false });
      expect(chatCompletion).not.toHaveBeenCalled();
    });

    it('sweeps every (key, model) pair and clears cooldowns whose probe succeeds', async () => {
      const db = getDb();
      const { encrypted, iv, authTag } = encrypt('test-key');
      const a = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES ('groq', 'a', ?, ?, ?, 'healthy', 1)
      `).run(encrypted, iv, authTag);
      const keyA = Number(a.lastInsertRowid);
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES ('groq', 'm1', 'M1', 1, 1, 1), ('groq', 'm2', 'M2', 2, 2, 1)
      `).run();
      db.prepare(`
        INSERT INTO fallback_config (model_db_id, priority, enabled)
        SELECT id, 1, 1 FROM models WHERE platform = 'groq'
      `).run();

      setCooldown('groq', 'm1', keyA, 5 * 60_000, 'rate_limited');
      setCooldown('groq', 'm2', keyA, 5 * 60_000, 'rate_limited');
      chatCompletion.mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });

      const summary = await probeAllActiveCooldowns(2000);
      expect(summary.probed).toBe(2);
      expect(summary.recovered.map(r => r.target.modelId).sort()).toEqual(['m1', 'm2']);
      expect(summary.newlyCooled).toEqual([]);
      expect(summary.stillCooled).toBe(0);
      expect(summary.timedOut).toBe(false);

      const remaining = getActiveCooldowns();
      expect(remaining).toEqual([]);
    });

    it('sets a fresh cooldown for a pair whose probe returns 429', async () => {
      const db = getDb();
      const { encrypted, iv, authTag } = encrypt('test-key');
      const a = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES ('groq', 'a', ?, ?, ?, 'healthy', 1)
      `).run(encrypted, iv, authTag);
      const keyA = Number(a.lastInsertRowid);
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES ('groq', 'm1', 'M1', 1, 1, 1)
      `).run();
      db.prepare(`
        INSERT INTO fallback_config (model_db_id, priority, enabled)
        SELECT id, 1, 1 FROM models WHERE platform = 'groq'
      `).run();

      chatCompletion.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));

      const summary = await probeAllActiveCooldowns(2000);
      expect(summary.probed).toBe(1);
      expect(summary.recovered).toEqual([]);
      expect(summary.newlyCooled).toEqual([
        { target: { platform: 'groq', modelId: 'm1', keyId: keyA }, available: false, reason: 'rate_limited' },
      ]);
      expect(summary.stillCooled).toBe(0);
      expect(summary.timedOut).toBe(false);

      const active = getActiveCooldowns();
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ platform: 'groq', modelId: 'm1', keyId: keyA, reason: 'rate_limited' });
    });
  });
});
