import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb, getSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  ZEN_KEYLESS_MODE_SETTING,
  ZEN_KEYLESS_BACKUP_SETTING,
  ZEN_SENTINEL_LABEL,
  currentZenIp,
  ensureZenSentinel,
  getZenKeylessState,
  getZenSentinelKeyId,
  isZenAnonymousKey,
  isZenKeylessMode,
  markZenIpExhausted,
  rotateZenIp,
  setZenKeylessMode,
  _resetZenKeylessState,
} from '../../services/zen-keyless.js';

function insertKey(platform: string, label: string, enabled = 1): number {
  const { encrypted, iv, authTag } = encrypt('dummy-key');
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', ?)
  `).run(platform, label, encrypted, iv, authTag, enabled);
  return Number(result.lastInsertRowid);
}

function enabledOf(id: number): number {
  const row = getDb().prepare('SELECT enabled FROM api_keys WHERE id = ?').get(id) as { enabled: number };
  return row.enabled;
}

function opencodeRows(): Array<{ id: number; label: string; enabled: number }> {
  return getDb().prepare('SELECT id, label, enabled FROM api_keys WHERE platform = ? ORDER BY id').all('opencode') as Array<{ id: number; label: string; enabled: number }>;
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  getDb().prepare('DELETE FROM api_keys').run();
  getDb().prepare('DELETE FROM settings').run();
  _resetZenKeylessState();
});

describe('zen keyless mode defaults', () => {
  it('is off with no sentinel', () => {
    expect(isZenKeylessMode()).toBe(false);
    expect(getZenSentinelKeyId()).toBeNull();
    expect(getZenKeylessState()).toEqual({
      enabled: false,
      sentinelKeyId: null,
      zenKeyCount: 0,
      disabledZenKeyCount: 0,
    });
  });

  it('isZenAnonymousKey is false when off', () => {
    const id = insertKey('opencode', 'a');
    expect(isZenAnonymousKey('opencode', id)).toBe(false);
  });

  it('ensureZenSentinel creates nothing when off', () => {
    expect(ensureZenSentinel()).toBeNull();
    expect(opencodeRows()).toHaveLength(0);
  });
});

describe('setZenKeylessMode(true)', () => {
  it('creates a sentinel and disables every real zen key', () => {
    const k1 = insertKey('opencode', 'a');
    const k2 = insertKey('opencode', 'b');
    insertKey('opencode', 'c', 0);

    const state = setZenKeylessMode(true);

    expect(state.enabled).toBe(true);
    expect(state.sentinelKeyId).not.toBeNull();
    expect(state.zenKeyCount).toBe(4);
    expect(state.disabledZenKeyCount).toBe(3);

    const sentinelId = getZenSentinelKeyId()!;
    const sentinel = opencodeRows().find(r => r.id === sentinelId)!;
    expect(sentinel.label).toBe(ZEN_SENTINEL_LABEL);
    expect(sentinel.enabled).toBe(1);
    expect(enabledOf(k1)).toBe(0);
    expect(enabledOf(k2)).toBe(0);
    expect(getSetting(ZEN_KEYLESS_BACKUP_SETTING)).toBe(JSON.stringify([k1, k2]));
    expect(getSetting(ZEN_KEYLESS_MODE_SETTING)).toBe('1');
  });

  it('is idempotent across repeated calls', () => {
    const k1 = insertKey('opencode', 'a');
    const first = setZenKeylessMode(true);
    const second = setZenKeylessMode(true);
    expect(second.sentinelKeyId).toBe(first.sentinelKeyId);
    expect(second.zenKeyCount).toBe(first.zenKeyCount);
    expect(enabledOf(k1)).toBe(0);
  });

  it('backs up only the keys that were enabled at enable time', () => {
    const k1 = insertKey('opencode', 'a');
    setZenKeylessMode(true);
    const late = insertKey('opencode', 'late');
    expect(getSetting(ZEN_KEYLESS_BACKUP_SETTING)).toBe(JSON.stringify([k1]));
    expect(enabledOf(late)).toBe(1);
  });
});

describe('setZenKeylessMode(false)', () => {
  it('disables the sentinel and restores the backed-up keys', () => {
    const k1 = insertKey('opencode', 'a');
    const k2 = insertKey('opencode', 'b');
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;

    const state = setZenKeylessMode(false);

    expect(state.enabled).toBe(false);
    expect(state.sentinelKeyId).toBe(sentinelId);
    expect(enabledOf(sentinelId)).toBe(0);
    expect(enabledOf(k1)).toBe(1);
    expect(enabledOf(k2)).toBe(1);
    expect(getSetting(ZEN_KEYLESS_BACKUP_SETTING)).toBe('');
  });

  it('leaves keys that were disabled before the first enable untouched', () => {
    const c = insertKey('opencode', 'c', 0);
    setZenKeylessMode(true);
    setZenKeylessMode(false);
    expect(enabledOf(c)).toBe(0);
  });

  it('keeps keys added while enabled enabled', () => {
    insertKey('opencode', 'a');
    setZenKeylessMode(true);
    const late = insertKey('opencode', 'late');
    setZenKeylessMode(false);
    expect(enabledOf(late)).toBe(1);
  });

  it('does not resurrect a key that was never in the backup', () => {
    insertKey('opencode', 'a');
    setZenKeylessMode(true);
    const late = insertKey('opencode', 'late');
    getDb().prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(late);
    setZenKeylessMode(false);
    expect(enabledOf(late)).toBe(0);
  });
});

describe('ensureZenSentinel', () => {
  it('returns the existing sentinel id', () => {
    setZenKeylessMode(true);
    const id = ensureZenSentinel();
    expect(ensureZenSentinel()).toBe(id);
  });

  it('recreates a deleted sentinel while enabled', () => {
    setZenKeylessMode(true);
    const original = getZenSentinelKeyId()!;
    getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(original);

    const recreated = ensureZenSentinel();
    expect(recreated).not.toBeNull();
    expect(recreated).not.toBe(original);
    const row = getDb().prepare('SELECT label, enabled FROM api_keys WHERE id = ?').get(recreated!) as { label: string; enabled: number };
    expect(row.label).toBe(ZEN_SENTINEL_LABEL);
    expect(row.enabled).toBe(1);
    expect(getZenSentinelKeyId()).toBe(recreated);
  });
});

describe('isZenAnonymousKey', () => {
  it('matches the sentinel id on the opencode platform while enabled', () => {
    const k1 = insertKey('opencode', 'a');
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;
    expect(isZenAnonymousKey('opencode', sentinelId)).toBe(true);
    expect(isZenAnonymousKey('opencode', k1)).toBe(false);
  });

  it('never matches other platforms', () => {
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;
    expect(isZenAnonymousKey('groq', sentinelId)).toBe(false);
  });
});

describe('zen ip rotation', () => {
  const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

  it('returns null when keyless mode is off', () => {
    expect(currentZenIp()).toBeNull();
    expect(rotateZenIp()).toBeNull();
  });

  it('generates a sticky public ip while enabled', () => {
    setZenKeylessMode(true);
    const ip = currentZenIp();
    expect(ip).toMatch(IP_RE);
    expect(currentZenIp()).toBe(ip);
  });

  it('rotates to a fresh ip after exhaustion', () => {
    setZenKeylessMode(true);
    const before = currentZenIp()!;
    markZenIpExhausted();
    const after = rotateZenIp()!;
    expect(after).toMatch(IP_RE);
    expect(after).not.toBe(before);
    expect(currentZenIp()).toBe(after);
  });

  it('does not immediately reuse a recently rotated ip', () => {
    setZenKeylessMode(true);
    const first = currentZenIp()!;
    markZenIpExhausted();
    const second = rotateZenIp()!;
    markZenIpExhausted();
    const third = rotateZenIp()!;
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('resets to a fresh ip pool', () => {
    setZenKeylessMode(true);
    const before = currentZenIp()!;
    _resetZenKeylessState();
    const after = currentZenIp()!;
    expect(after).toMatch(IP_RE);
    expect(after).not.toBe(before);
  });
});
