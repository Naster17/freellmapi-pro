import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setCooldown, clearPersistedCooldown, isOnCooldown, getProbeableCooldowns } from '../../services/ratelimit.js';
import { setSetting } from '../../db/index.js';
import { setProbeOnCooldown, setStrictChain } from '../../services/router.js';
import { getActiveCooldowns, probeAllActiveCooldowns, runCooldownProbePass, resetCooldownProbeState, startCooldownProbe, stopCooldownProbe } from '../../services/cooldown-probe.js';
import { cooldownDecisionForError } from '../../lib/fallback-loop.js';
import type { RouteResult } from '../../services/router.js';
import type { KeyProbeOutcome } from '../../services/health.js';

const MINUTE = 60_000;

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

// Distinct keyId per bench: the cooldown store is module-global (memory map +
// DB), so shared ids would leak state across tests.
let keySeq = 910_000;

function bench(
  source: 'heuristic' | 'authoritative' | 'credit' | 'tier',
  opts: { durationMs?: number; modelId?: string; keyId?: number } = {},
): number {
  const keyId = opts.keyId ?? ++keySeq;
  setCooldown('probefake', opts.modelId ?? 'model-a', keyId, opts.durationMs ?? 10 * MINUTE, source);
  return keyId;
}

// A probe that always answers the same thing, wrapped in a spy so tests can
// assert exactly which keys were probed and how often.
const probeReturning = (outcome: KeyProbeOutcome) => vi.fn(async (_keyId: number) => outcome);

// jitter() => 0 makes a first-sighted key probeable on the very next pass,
// which keeps the "seed pass then probe pass" choreography deterministic.
const noJitter = () => 0;

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
  resetCooldownProbeState();
  chatCompletion.mockReset();
  streamChatCompletion.mockReset();
});

afterEach(() => {
  stopCooldownProbe();
  delete process.env.COOLDOWN_PROBE_DISABLED;
});

describe('cooldown-probe service (legacy probeAllActiveCooldowns)', () => {
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

      setCooldown('groq', 'llama-3.3-70b', keyId, 5 * 60_000, 'heuristic', 'rate_limited');

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

      setCooldown('groq', 'old-model', keyId, 100, 'heuristic', 'rate_limited');
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

      setCooldown('groq', 'm1', keyA, 5 * 60_000, 'heuristic', 'rate_limited');
      setCooldown('groq', 'm2', keyA, 5 * 60_000, 'heuristic', 'rate_limited');
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

    it('only probes (key, model) pairs that have an active cooldown; uncooled pairs are not touched', async () => {
      const db = getDb();
      const { encrypted, iv, authTag } = encrypt('test-key');
      const a = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES ('groq', 'a', ?, ?, ?, 'healthy', 1)
      `).run(encrypted, iv, authTag);
      const keyA = Number(a.lastInsertRowid);
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES ('groq', 'cooled', 'Cooled', 1, 1, 1), ('groq', 'idle', 'Idle', 2, 2, 1)
      `).run();
      db.prepare(`
        INSERT INTO fallback_config (model_db_id, priority, enabled)
        SELECT id, 1, 1 FROM models WHERE platform = 'groq'
      `).run();

      setCooldown('groq', 'cooled', keyA, 5 * 60_000, 'heuristic', 'rate_limited');
      chatCompletion.mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });

      const summary = await probeAllActiveCooldowns(2000);
      expect(summary.probed).toBe(1);
      expect(summary.recovered.map(r => r.target.modelId)).toEqual(['cooled']);
      expect(chatCompletion).toHaveBeenCalledTimes(1);
      expect(chatCompletion.mock.calls[0][2]).toBe('cooled');
    });

    it('does not probe a (key, model) pair whose cooldown has already expired', async () => {
      const db = getDb();
      const { encrypted, iv, authTag } = encrypt('test-key');
      const a = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES ('groq', 'a', ?, ?, ?, 'healthy', 1)
      `).run(encrypted, iv, authTag);
      const keyA = Number(a.lastInsertRowid);
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES ('groq', 'expired', 'Expired', 1, 1, 1)
      `).run();
      db.prepare(`
        INSERT INTO fallback_config (model_db_id, priority, enabled)
        SELECT id, 1, 1 FROM models WHERE platform = 'groq'
      `).run();

      setCooldown('groq', 'expired', keyA, 50, 'heuristic', 'rate_limited');
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 5000);
      const summary = await probeAllActiveCooldowns(2000);
      vi.useRealTimers();
      expect(summary.probed).toBe(0);
      expect(chatCompletion).not.toHaveBeenCalled();
    });

    it('skips a cooldown row pointing at a key that was later disabled', async () => {
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

      setCooldown('groq', 'm1', keyA, 5 * 60_000, 'heuristic', 'rate_limited');
      db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyA);

      const summary = await probeAllActiveCooldowns(2000);
      expect(summary.probed).toBe(0);
      expect(chatCompletion).not.toHaveBeenCalled();
    });

    it('skips a cooldown row pointing at a model that was later disabled', async () => {
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

      setCooldown('groq', 'm1', keyA, 5 * 60_000, 'heuristic', 'rate_limited');
      db.prepare('UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?').run('groq', 'm1');

      const summary = await probeAllActiveCooldowns(2000);
      expect(summary.probed).toBe(0);
      expect(chatCompletion).not.toHaveBeenCalled();
    });

    it('classifies a transport-level error (ECONNRESET) as probe_timeout, no fresh cooldown is written', async () => {
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

      const originalExpiry = Date.now() + 5 * 60_000;
      setCooldown('groq', 'm1', keyA, 5 * 60_000, 'heuristic', 'rate_limited');
      chatCompletion.mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));

      const summary = await probeAllActiveCooldowns(2000);
      expect(summary.probed).toBe(1);
      expect(summary.recovered).toEqual([]);
      expect(summary.newlyCooled).toEqual([]);
      expect(summary.stillCooled).toBe(1);

      const active = getActiveCooldowns();
      expect(active).toHaveLength(1);
      expect(active[0].reason).toBe('rate_limited');
      expect(active[0].expiresAtMs).toBeGreaterThanOrEqual(originalExpiry - 1000);
    });

    it('classifies an undici "fetch failed" (cause: UND_ERR_SOCKET) as probe_timeout', async () => {
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

      setCooldown('groq', 'm1', keyA, 5 * 60_000, 'heuristic', 'rate_limited');
      chatCompletion.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      }));

      const summary = await probeAllActiveCooldowns(2000);
      expect(summary.probed).toBe(1);
      expect(summary.newlyCooled).toEqual([]);
      expect(summary.stillCooled).toBe(1);
      expect(getActiveCooldowns()[0].reason).toBe('rate_limited');
    });

    it('classifies a transport error without a code (e.g. "socket hang up") as probe_timeout', async () => {
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

      setCooldown('groq', 'm1', keyA, 5 * 60_000, 'heuristic', 'rate_limited');
      chatCompletion.mockRejectedValueOnce(new Error('socket hang up'));

      const summary = await probeAllActiveCooldowns(2000);
      expect(summary.probed).toBe(1);
      expect(summary.newlyCooled).toEqual([]);
      expect(summary.stillCooled).toBe(1);
    });

    it('does NOT classify a genuine programming error (e.g. ERR_ASSERTION) as probe_timeout', async () => {
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

      setCooldown('groq', 'm1', keyA, 5 * 60_000, 'heuristic', 'rate_limited');
      chatCompletion.mockRejectedValueOnce(Object.assign(new Error('assert failed'), { code: 'ERR_ASSERTION' }));

      const summary = await probeAllActiveCooldowns(2000);
      expect(summary.probed).toBe(1);
      expect(summary.newlyCooled).toEqual([
        { target: { platform: 'groq', modelId: 'm1', keyId: keyA }, available: false, reason: 'transport_error' },
      ]);
      expect(summary.stillCooled).toBe(0);
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

      setCooldown('groq', 'm1', keyA, 5 * 60_000, 'heuristic', 'rate_limited');
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

describe('probe eligibility', () => {
  it('only heuristic cooldowns are visible to the prober', () => {
    const heuristic = bench('heuristic');
    bench('authoritative');
    bench('credit');
    bench('tier');

    const rows = getProbeableCooldowns();
    expect(rows).toHaveLength(1);
    expect(rows[0].keyId).toBe(heuristic);
  });

  it('never probes authoritative, credit, or tier cooldowns', async () => {
    const heuristic = bench('heuristic');
    const authoritative = bench('authoritative');
    const credit = bench('credit');
    const tier = bench('tier');
    const probe = probeReturning('valid');
    const now = Date.now() + 6 * MINUTE; // past the half-bench ripeness gate

    await runCooldownProbePass({ now, probe, jitter: noJitter }); // seed pass
    const result = await runCooldownProbePass({ now, probe, jitter: noJitter });

    expect(result.probedKeyIds).toEqual([heuristic]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(heuristic);
    // The provider-stated benches stay exactly where they were.
    expect(isOnCooldown('probefake', 'model-a', authoritative)).toBe(true);
    expect(isOnCooldown('probefake', 'model-a', credit)).toBe(true);
    expect(isOnCooldown('probefake', 'model-a', tier)).toBe(true);
  });

  it('does not probe before half the bench has elapsed', async () => {
    bench('heuristic', { durationMs: 10 * MINUTE });
    const probe = probeReturning('valid');
    const early = Date.now() + 2 * MINUTE; // 20% served — not ripe

    await runCooldownProbePass({ now: early, probe, jitter: noJitter });
    await runCooldownProbePass({ now: early, probe, jitter: noJitter });
    expect(probe).not.toHaveBeenCalled();

    const ripe = Date.now() + 6 * MINUTE; // 60% served — ripe
    await runCooldownProbePass({ now: ripe, probe, jitter: noJitter }); // seed
    const result = await runCooldownProbePass({ now: ripe, probe, jitter: noJitter });
    expect(result.probedKeyIds).toHaveLength(1);
  });

  it('skips cooldowns that are about to expire on their own', async () => {
    bench('heuristic', { durationMs: 10 * MINUTE });
    const probe = probeReturning('valid');
    // 9.5 minutes in: past half-bench, but the remaining 30s is less than a
    // scan interval — the probe would cost more than the idle time it saves.
    const now = Date.now() + 9 * MINUTE + 30_000;

    await runCooldownProbePass({ now, probe, jitter: noJitter });
    await runCooldownProbePass({ now, probe, jitter: noJitter });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('successful probe', () => {
  it('clears every heuristic cooldown on the key early, with one probe', async () => {
    const keyId = ++keySeq;
    bench('heuristic', { keyId, modelId: 'model-a' });
    bench('heuristic', { keyId, modelId: 'model-b' });
    expect(isOnCooldown('probefake', 'model-a', keyId)).toBe(true);
    expect(isOnCooldown('probefake', 'model-b', keyId)).toBe(true);

    const probe = probeReturning('valid');
    const now = Date.now() + 6 * MINUTE;
    await runCooldownProbePass({ now, probe, jitter: noJitter }); // seed
    const result = await runCooldownProbePass({ now, probe, jitter: noJitter });

    // One validate call is the same evidence for both benched models.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.clearedCooldowns).toBe(2);
    expect(isOnCooldown('probefake', 'model-a', keyId)).toBe(false);
    expect(isOnCooldown('probefake', 'model-b', keyId)).toBe(false);
    expect(getProbeableCooldowns(now)).toHaveLength(0);
  });
});

describe('failed probe', () => {
  function expiryOf(keyId: number): number {
    const row = getDb().prepare(
      "SELECT expires_at_ms FROM rate_limit_cooldowns WHERE key_id = ?",
    ).get(keyId) as { expires_at_ms: number };
    return row.expires_at_ms;
  }

  it('leaves the cooldown exactly as it was — never extends it', async () => {
    const keyId = bench('heuristic', { durationMs: 30 * MINUTE });
    const expiryBefore = expiryOf(keyId);
    const probe = probeReturning('invalid');
    const now = Date.now() + 16 * MINUTE;

    await runCooldownProbePass({ now, probe, jitter: noJitter }); // seed
    const result = await runCooldownProbePass({ now, probe, jitter: noJitter });

    expect(result.probedKeyIds).toEqual([keyId]);
    expect(result.clearedCooldowns).toBe(0);
    expect(isOnCooldown('probefake', 'model-a', keyId)).toBe(true);
    expect(expiryOf(keyId)).toBe(expiryBefore);
  });

  it('backs off with increasing intervals between probes', async () => {
    const keyId = bench('heuristic', { durationMs: 60 * MINUTE });
    const probe = probeReturning('invalid');
    const t0 = Date.now() + 31 * MINUTE;

    await runCooldownProbePass({ now: t0, probe, jitter: noJitter }); // seed
    await runCooldownProbePass({ now: t0, probe, jitter: noJitter }); // probe #1 fails
    expect(probe).toHaveBeenCalledTimes(1);

    // Within the first 2-minute backoff: no probe.
    await runCooldownProbePass({ now: t0 + 1 * MINUTE, probe, jitter: noJitter });
    expect(probe).toHaveBeenCalledTimes(1);

    // Backoff served: probe #2 fails, backoff doubles to 4 minutes.
    await runCooldownProbePass({ now: t0 + 2 * MINUTE, probe, jitter: noJitter });
    expect(probe).toHaveBeenCalledTimes(2);

    // 3 minutes after probe #2 — still inside the 4-minute backoff.
    await runCooldownProbePass({ now: t0 + 5 * MINUTE, probe, jitter: noJitter });
    expect(probe).toHaveBeenCalledTimes(2);

    // 4 minutes after probe #2: due again.
    await runCooldownProbePass({ now: t0 + 6 * MINUTE, probe, jitter: noJitter });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(isOnCooldown('probefake', 'model-a', keyId)).toBe(true);
  });

  it('treats an inconclusive transport error like a failure', async () => {
    const keyId = bench('heuristic');
    const probe = probeReturning('error');
    const now = Date.now() + 6 * MINUTE;

    await runCooldownProbePass({ now, probe, jitter: noJitter }); // seed
    const result = await runCooldownProbePass({ now, probe, jitter: noJitter });

    expect(result.clearedCooldowns).toBe(0);
    expect(isOnCooldown('probefake', 'model-a', keyId)).toBe(true);
  });
});

describe('stagger and probe budget', () => {
  it('a first-sighted key gets a jittered schedule instead of an instant probe', async () => {
    bench('heuristic', { durationMs: 60 * MINUTE });
    const probe = probeReturning('valid');
    const maxJitter = () => 0.999; // ~45s stagger
    const t0 = Date.now() + 31 * MINUTE;

    await runCooldownProbePass({ now: t0, probe, jitter: maxJitter }); // seed only
    expect(probe).not.toHaveBeenCalled();

    // Still inside the stagger window.
    await runCooldownProbePass({ now: t0 + 30_000, probe, jitter: maxJitter });
    expect(probe).not.toHaveBeenCalled();

    // Stagger served.
    await runCooldownProbePass({ now: t0 + 46_000, probe, jitter: maxJitter });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('caps how many keys one pass may probe', async () => {
    for (let i = 0; i < 5; i++) bench('heuristic');
    const probe = probeReturning('valid');
    const now = Date.now() + 6 * MINUTE;

    await runCooldownProbePass({ now, probe, jitter: noJitter, maxProbes: 2 }); // seed
    const first = await runCooldownProbePass({ now, probe, jitter: noJitter, maxProbes: 2 });
    expect(first.probedKeyIds).toHaveLength(2);

    // The rest are picked up by later passes, not all at once.
    const second = await runCooldownProbePass({ now, probe, jitter: noJitter, maxProbes: 2 });
    expect(second.probedKeyIds).toHaveLength(2);
    expect(probe).toHaveBeenCalledTimes(4);
  });
});

describe('cooldown provenance (cooldownDecisionForError)', () => {
  function fakeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
    const n = ++keySeq;
    return {
      provider: {} as any, modelId: 'fake-model', modelDbId: 910_000 + n, apiKey: 'k',
      keyId: n, platform: 'probefake', displayName: 'Fake Model',
      rpdLimit: null, tpdLimit: null,
      ...overrides,
    };
  }

  it('tags 402 out-of-credits as credit (never probed)', () => {
    const decision = cooldownDecisionForError(fakeRoute(), new Error('402 Payment Required'));
    expect(decision.source).toBe('credit');
  });

  it('tags 403 model-not-on-tier as tier (never probed)', () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 });
    expect(cooldownDecisionForError(fakeRoute(), err).source).toBe('tier');
  });

  it('tags a daily-quota bench as authoritative — the expiry is a reset time, not a guess', () => {
    const err = new Error('You have used up your daily free allocation');
    const decision = cooldownDecisionForError(fakeRoute(), err);
    expect(decision.source).toBe('authoritative');
    expect(decision.durationMs).toBeGreaterThan(0);
  });

  it('tags a plain transient 429 as heuristic (probe-eligible)', () => {
    const decision = cooldownDecisionForError(fakeRoute(), new Error('429 Too Many Requests'));
    expect(decision.source).toBe('heuristic');
    expect(decision.durationMs).toBe(90_000);
  });

  it('a Retry-After that determined the expiry is authoritative; a shorter one is not', () => {
    // Retry-After beyond our 90s transient bench: the provider's word set the
    // expiry, so probing early could never be justified.
    const longRetry = Object.assign(new Error('429 Too Many Requests'), { retryAfterMs: 10 * MINUTE });
    const long = cooldownDecisionForError(fakeRoute(), longRetry);
    expect(long).toEqual({ durationMs: 10 * MINUTE, source: 'authoritative' });

    // Retry-After SHORTER than our bench: everything past the provider's own
    // retry time is our pessimism, so early recovery stays on the table.
    const shortRetry = Object.assign(new Error('429 Too Many Requests'), { retryAfterMs: 1_000 });
    const short = cooldownDecisionForError(fakeRoute(), shortRetry);
    expect(short).toEqual({ durationMs: 90_000, source: 'heuristic' });
  });
});

describe('startCooldownProbe / stopCooldownProbe', () => {
  function makeScheduler() {
    const every: { ms: number; fn: () => void | Promise<void> }[] = [];
    const cancels: ReturnType<typeof vi.fn>[] = [];
    return {
      scheduler: {
        every(ms: number, fn: () => void | Promise<void>) {
          const cancel = vi.fn();
          every.push({ ms, fn });
          cancels.push(cancel);
          return cancel;
        },
        after(_ms: number, _fn: () => void | Promise<void>) {
          return vi.fn();
        },
      },
      every,
      cancels,
    };
  }

  it('registers one every-minute scan job', () => {
    const { scheduler, every } = makeScheduler();
    startCooldownProbe(scheduler);
    expect(every).toHaveLength(1);
    expect(every[0].ms).toBe(60_000);
  });

  it('is idempotent — double-start registers only one job', () => {
    const { scheduler, every } = makeScheduler();
    startCooldownProbe(scheduler);
    startCooldownProbe(scheduler);
    expect(every).toHaveLength(1);
  });

  it('the kill switch registers nothing', () => {
    process.env.COOLDOWN_PROBE_DISABLED = '1';
    const { scheduler, every } = makeScheduler();
    startCooldownProbe(scheduler);
    expect(every).toHaveLength(0);
  });

  it('stop invokes the cancel handle', () => {
    const { scheduler, cancels } = makeScheduler();
    startCooldownProbe(scheduler);
    stopCooldownProbe();
    expect(cancels[0]).toHaveBeenCalledOnce();
  });

  it('the registered job runs a pass without throwing', async () => {
    const { scheduler, every } = makeScheduler();
    startCooldownProbe(scheduler);
    await expect(every[0].fn()).resolves.toBeUndefined();
  });
});