import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, setRoutingStrategy, setStrictChain, type RouteResult } from '../../services/router.js';
import { newFallbackState, recordAuthFailure, recordRetryableFailure } from '../../lib/fallback-loop.js';
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
  it('recordRetryableFailure skips cooldown and skipKeys for the sentinel key', async () => {
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
    expect(state.skipKeys.size).toBe(0);
    expect(countCooldowns('opencode', sentinelId)).toBe(0);
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