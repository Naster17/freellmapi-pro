import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, setRoutingStrategy, setStrictChain, type RouteResult } from '../../services/router.js';
import { newFallbackState, recordAuthFailure, recordRetryableFailure } from '../../lib/fallback-loop.js';
import { canUseKeyConcurrency, getKeyConcurrencyLimit, releaseKeySlot, reserveKeySlot } from '../../services/ratelimit.js';
import {
  getZenSentinelKeyId,
  isZenKeylessMode,
  setZenKeylessMode,
  _resetZenKeylessState,
} from '../../services/zen-keyless.js';

function insertKey(platform: string, label: string, secret: string, enabled = 1, status = 'healthy'): number {
  const { encrypted, iv, authTag } = encrypt(secret);
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(platform, label, encrypted, iv, authTag, status, enabled);
  return Number(result.lastInsertRowid);
}

function countCooldowns(platform: string, keyId: number): number {
  const row = getDb().prepare(
    'SELECT COUNT(*) AS c FROM rate_limit_cooldowns WHERE platform = ? AND key_id = ?',
  ).get(platform, keyId) as { c: number };
  return row.c;
}

function mimoModelId(): number {
  const row = getDb().prepare(
    "SELECT id FROM models WHERE platform = 'opencode' AND model_id = 'mimo-v2.5-free'",
  ).get() as { id: number } | undefined;
  if (!row) throw new Error('opencode mimo-v2.5-free model not seeded');
  return row.id;
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  const db = getDb();
  setRoutingStrategy('priority');
  setStrictChain(false);
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
  db.prepare("DELETE FROM settings WHERE key IN ('active_profile_id', 'zen_keyless_mode', 'zen_keyless_backup_keys')").run();
  _resetZenKeylessState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('zen keyless routing', () => {
  it('routes an explicit opencode model to the anonymous sentinel while enabled', async () => {
    const realKeyId = insertKey('opencode', 'real', 'zen-test-real-key');
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;
    expect(sentinelId).not.toBe(realKeyId);

    const result = await routeRequest(100, undefined, mimoModelId(), false, false, undefined, undefined, undefined, true);
    expect(result.platform).toBe('opencode');
    expect(result.keyId).toBe(sentinelId);
    expect(result.apiKey).toBe('no-key');
    result.release?.();
  });

  it('creates the sentinel lazily when it was deleted while enabled', async () => {
    insertKey('opencode', 'real', 'zen-test-real-key');
    setZenKeylessMode(true);
    const originalSentinelId = getZenSentinelKeyId()!;
    getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(originalSentinelId);

    const result = await routeRequest(100, undefined, mimoModelId(), false, false, undefined, undefined, undefined, true);
    const newSentinelId = getZenSentinelKeyId()!;
    expect(newSentinelId).not.toBe(originalSentinelId);
    expect(result.keyId).toBe(newSentinelId);
    expect(result.apiKey).toBe('no-key');
    result.release?.();
  });

  it('uses the stored zen key when disabled', async () => {
    insertKey('opencode', 'real', 'zen-test-real-key');
    expect(isZenKeylessMode()).toBe(false);

    const result = await routeRequest(100, undefined, mimoModelId(), false, false, undefined, undefined, undefined, true);
    expect(result.platform).toBe('opencode');
    expect(result.apiKey).toBe('zen-test-real-key');
    result.release?.();
  });
});

describe('zen keyless fallback bookkeeping', () => {
  it('recordRetryableFailure benches the sentinel key and skips it for the rest of the request', async () => {
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;
    const sentinelRoute: RouteResult = {
      provider: {} as any,
      platform: 'opencode',
      modelId: 'mimo-v2.5-free',
      modelDbId: 999001,
      keyId: sentinelId,
      apiKey: 'no-key',
      displayName: 'MiMo',
      endpointScope: '',
      rpdLimit: null,
      tpdLimit: null,
    };
    const err = Object.assign(new Error('429 Too Many Requests'), { status: 429 });

    const state = newFallbackState();
    const continueFailingOver = recordRetryableFailure(sentinelRoute, err, state);

    expect(continueFailingOver).toBe(false);
    expect(state.skipKeys.has(`opencode:mimo-v2.5-free:${sentinelId}`)).toBe(true);
    expect(countCooldowns('opencode', sentinelId)).toBe(1);
  });

  it('recordRetryableFailure pool-benches every enabled zen key on a FreeUsageLimitError', async () => {
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;
    const sentinelRoute: RouteResult = {
      provider: {} as any,
      platform: 'opencode',
      modelId: 'mimo-v2.5-free',
      modelDbId: 999010,
      keyId: sentinelId,
      apiKey: 'no-key',
      displayName: 'MiMo',
      endpointScope: '',
      rpdLimit: null,
      tpdLimit: null,
    };
    const err = Object.assign(new Error('429 Too Many Requests'), { status: 429, upstreamCtx: { zenFreeUsageLimit: true } });

    const state = newFallbackState();
    recordRetryableFailure(sentinelRoute, err, state);

    expect(state.skipKeys.has(`opencode:mimo-v2.5-free:${sentinelId}`)).toBe(true);
    expect(countCooldowns('opencode', sentinelId)).toBe(1);
    const row = getDb().prepare(
      'SELECT reason FROM rate_limit_cooldowns WHERE platform = ? AND key_id = ? AND model_id = ?',
    ).get('opencode', sentinelId, 'mimo-v2.5-free') as { reason: string | null };
    expect(row.reason).toBe('zen_daily_limit');
  });

  it('recordRetryableFailure keeps penalty bookkeeping for a real zen key', async () => {
    const realKeyId = insertKey('opencode', 'real', 'zen-test-real-key');
    const realRoute: RouteResult = {
      provider: {} as any,
      platform: 'opencode',
      modelId: 'mimo-v2.5-free',
      modelDbId: 999002,
      keyId: realKeyId,
      apiKey: 'zen-test-real-key',
      displayName: 'MiMo',
      endpointScope: '',
      rpdLimit: null,
      tpdLimit: null,
    };
    const err = Object.assign(new Error('429 Too Many Requests'), { status: 429 });

    const state = newFallbackState();
    recordRetryableFailure(realRoute, err, state);

    expect(state.skipKeys.has(`opencode:mimo-v2.5-free:${realKeyId}`)).toBe(true);
    expect(countCooldowns('opencode', realKeyId)).toBe(1);
  });

  it('recordAuthFailure skips the revalidation path for the sentinel key', async () => {
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;
    const sentinelRoute: RouteResult = {
      provider: {} as any,
      platform: 'opencode',
      modelId: 'mimo-v2.5-free',
      modelDbId: 999003,
      keyId: sentinelId,
      apiKey: 'no-key',
      displayName: 'MiMo',
      endpointScope: '',
      rpdLimit: null,
      tpdLimit: null,
    };

    const state = newFallbackState();
    recordAuthFailure(sentinelRoute, state);

    expect(state.skipKeys.size).toBe(0);
    expect(countCooldowns('opencode', sentinelId)).toBe(0);
  });
});

describe('zen keyless concurrency', () => {
  it('caps each anon key at one stream while enabled', async () => {
    insertKey('opencode', 'real', 'zen-test-real-key');
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;

    expect(getKeyConcurrencyLimit('opencode')).toBe(2);
    expect(canUseKeyConcurrency('opencode', sentinelId)).toBe(true);
    reserveKeySlot('opencode', sentinelId);
    expect(canUseKeyConcurrency('opencode', sentinelId)).toBe(true);
    reserveKeySlot('opencode', sentinelId);
    expect(canUseKeyConcurrency('opencode', sentinelId)).toBe(false);
    releaseKeySlot('opencode', sentinelId);
    releaseKeySlot('opencode', sentinelId);
    expect(canUseKeyConcurrency('opencode', sentinelId)).toBe(true);
  });

  it('routes a concurrent stream to a second anon key instead of the busy one', async () => {
    insertKey('opencode', 'real', 'zen-test-real-key');
    setZenKeylessMode(true);
    const firstId = getZenSentinelKeyId()!;
    reserveKeySlot('opencode', firstId);
    reserveKeySlot('opencode', firstId);

    const result = await routeRequest(100, undefined, mimoModelId(), false, false, undefined, undefined, undefined, true);
    expect(result.platform).toBe('opencode');
    expect(result.keyId).not.toBe(firstId);
    const label = getDb().prepare('SELECT label FROM api_keys WHERE id = ?').get(result.keyId) as { label: string };
    expect(label.label).toBe('anon 2');

    releaseKeySlot('opencode', firstId);
    releaseKeySlot('opencode', firstId);
    result.release?.();
  });

  it('reuses a freed anon key instead of growing the pool forever', async () => {
    insertKey('opencode', 'real', 'zen-test-real-key');
    setZenKeylessMode(true);
    const firstId = getZenSentinelKeyId()!;

    const first = await routeRequest(100, undefined, mimoModelId(), false, false, undefined, undefined, undefined, true);
    first.release?.();
    const second = await routeRequest(100, undefined, mimoModelId(), false, false, undefined, undefined, undefined, true);
    second.release?.();

    expect(second.keyId).toBe(first.keyId);
    expect(first.keyId).toBe(firstId);
    const poolSize = (getDb().prepare(
      "SELECT COUNT(*) AS c FROM api_keys WHERE platform = 'opencode' AND label LIKE 'anon %'",
    ).get() as { c: number }).c;
    expect(poolSize).toBe(1);
  });

  it('keeps the default cap when zen keyless mode is off', async () => {
    insertKey('opencode', 'real', 'zen-test-real-key');
    expect(getKeyConcurrencyLimit('opencode')).toBe(1);
  });

  it('honors an explicit env override while enabled', async () => {
    insertKey('opencode', 'real', 'zen-test-real-key');
    setZenKeylessMode(true);
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_OPENCODE = '3';
    try {
      expect(getKeyConcurrencyLimit('opencode')).toBe(3);
    } finally {
      delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_OPENCODE;
    }
  });
});