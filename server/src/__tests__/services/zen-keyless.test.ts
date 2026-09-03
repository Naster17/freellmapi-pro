import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb, getSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getServerLogs } from '../../lib/server-logs.js';
import {
  ZEN_KEYLESS_MODE_SETTING,
  ZEN_KEYLESS_BACKUP_SETTING,
  ZEN_SENTINEL_LABEL,
  LEGACY_ZEN_SENTINEL_LABEL,
  acquireZenIpLease,
  clearZenAnonKeys,
  createZenSentinelKey,
  currentZenIp,
  ensureZenPool,
  ensureZenSentinel,
  getZenKeylessState,
  getZenSentinelKeyId,
  isZenAnonymousKey,
  isZenIpExhausted,
  isZenKeylessMode,
  markZenIpExhausted,
  rotateZenIp,
  setZenKeylessMode,
  zenIpStorage,
  _resetZenKeylessState,
} from '../../services/zen-keyless.js';
import { setCooldown } from '../../services/ratelimit.js';

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
      anonKeyCount: 0,
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
    expect(sentinel.label).toBe('anon 1');
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
    expect(row.label).toBe('anon 1');
    expect(row.enabled).toBe(1);
    expect(getZenSentinelKeyId()).toBe(recreated);
  });

  it('migrates a legacy Zen anonymous sentinel into the anon pool', () => {
    const legacyId = insertKey('opencode', LEGACY_ZEN_SENTINEL_LABEL);
    ensureZenPool();
    expect(getZenSentinelKeyId()).toBe(legacyId);
    const row = getDb().prepare('SELECT label FROM api_keys WHERE id = ?').get(legacyId) as { label: string };
    expect(row.label).toBe('anon 1');
  });

  it('does not duplicate the sentinel when a legacy row exists', () => {
    insertKey('opencode', LEGACY_ZEN_SENTINEL_LABEL);
    setZenKeylessMode(true);
    const rows = getDb().prepare(
      "SELECT COUNT(*) AS c FROM api_keys WHERE platform = 'opencode' AND label = ?",
    ).get('anon 1') as { c: number };
    expect(rows.c).toBe(1);
    expect(getZenKeylessState().sentinelKeyId).not.toBeNull();
  });

  it('re-enables a sentinel that was disabled by a previous shutdown', () => {
    setZenKeylessMode(true);
    const sentinelId = getZenSentinelKeyId()!;
    getDb().prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(sentinelId);
    ensureZenSentinel();
    const row = getDb().prepare('SELECT enabled FROM api_keys WHERE id = ?').get(sentinelId) as { enabled: number };
    expect(row.enabled).toBe(1);
  });
});

describe('anon key pool', () => {
  function anonLabels(): string[] {
    return (getDb().prepare(
      "SELECT label FROM api_keys WHERE platform = 'opencode' ORDER BY id",
    ).all() as Array<{ label: string }>).map(r => r.label);
  }

  it('ensureZenPool creates anon 1 from nothing', () => {
    ensureZenPool();
    expect(getZenSentinelKeyId()).not.toBeNull();
    expect(anonLabels()).toEqual(['anon 1']);
  });

  it('grows with createZenSentinelKey and numbers sequentially', () => {
    ensureZenPool();
    createZenSentinelKey();
    createZenSentinelKey();
    expect(anonLabels()).toEqual(['anon 1', 'anon 2', 'anon 3']);
  });

  it('keeps every created key enabled and healthy', () => {
    ensureZenPool();
    createZenSentinelKey();
    const rows = getDb().prepare(
      "SELECT label, enabled, status FROM api_keys WHERE platform = 'opencode' ORDER BY id",
    ).all() as Array<{ label: string; enabled: number; status: string }>;
    for (const row of rows) {
      expect(row.enabled).toBe(1);
      expect(row.status).toBe('healthy');
    }
  });

  it('isZenSentinelKey matches every pool key', () => {
    setZenKeylessMode(true);
    ensureZenPool();
    createZenSentinelKey();
    const ids = getDb().prepare("SELECT id FROM api_keys WHERE platform = 'opencode' ORDER BY id").all() as Array<{ id: number }>;
    for (const { id } of ids) {
      expect(isZenAnonymousKey('opencode', id)).toBe(true);
    }
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

describe('zen rotation logging', () => {
  it('logs an exhaustion entry once per ip', () => {
    setZenKeylessMode(true);
    markZenIpExhausted('1.2.3.4');
    markZenIpExhausted('1.2.3.4');

    const hits = getServerLogs().filter(e => e.event === 'zen_ip_exhausted' && e.message.includes('1.2.3.4'));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.level).toBe('warn');
    expect(hits[0]!.provider).toBe('opencode');
  });

  it('logs the rotation with the previous and next ip', () => {
    setZenKeylessMode(true);
    const before = currentZenIp()!;
    const after = rotateZenIp()!;

    const hits = getServerLogs().filter(e => e.event === 'zen_ip_rotate' && e.message.includes(before) && e.message.includes(after));
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});

describe('zen ip leases', () => {
  const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

  it('returns null when keyless mode is off', () => {
    expect(acquireZenIpLease()).toBeNull();
  });

  it('hands distinct ips to concurrent leases', () => {
    setZenKeylessMode(true);
    const a = acquireZenIpLease()!;
    const b = acquireZenIpLease()!;
    expect(a.ip).toMatch(IP_RE);
    expect(b.ip).toMatch(IP_RE);
    expect(a.ip).not.toBe(b.ip);
    a.release();
    b.release();
  });

  it('frees the ip on release', () => {
    setZenKeylessMode(true);
    const a = acquireZenIpLease()!;
    const b = acquireZenIpLease()!;
    a.release();
    const c = acquireZenIpLease()!;
    expect(c.ip).not.toBe(b.ip);
    c.release();
    b.release();
  });

  it('marks the ip exhausted on dispose so it is not reused', () => {
    setZenKeylessMode(true);
    const a = acquireZenIpLease()!;
    a.dispose();
    expect(isZenIpExhausted(a.ip)).toBe(true);
    const b = acquireZenIpLease()!;
    expect(b.ip).not.toBe(a.ip);
    b.release();
  });

  it('release does not mark the ip exhausted', () => {
    setZenKeylessMode(true);
    const a = acquireZenIpLease()!;
    a.release();
    expect(isZenIpExhausted(a.ip)).toBe(false);
  });

  it('release and dispose are idempotent', () => {
    setZenKeylessMode(true);
    const a = acquireZenIpLease()!;
    const b = acquireZenIpLease()!;
    a.release();
    a.release();
    b.dispose();
    b.dispose();
    expect(isZenIpExhausted(b.ip)).toBe(true);
  });

  it('binds the lease ip to the async context', () => {
    setZenKeylessMode(true);
    const lease = acquireZenIpLease()!;
    const inside = zenIpStorage.run(lease, () => currentZenIp());
    expect(inside).toBe(lease.ip);
    expect(currentZenIp()).not.toBe(lease.ip);
    lease.release();
  });

  it('clears every lease on reset', () => {
    setZenKeylessMode(true);
    const a = acquireZenIpLease()!;
    _resetZenKeylessState();
    const b = acquireZenIpLease()!;
    expect(b.ip).not.toBe(a.ip);
    b.release();
  });
});

describe('clearZenAnonKeys', () => {
  it('removes every anon key and its cooldowns but keeps real keys and all usage stats', () => {
    const real1 = insertKey('opencode', 'zen-a');
    insertKey('opencode', 'zen-b');
    insertKey('groq', 'groq-a');
    setZenKeylessMode(true);
    const anonA = getZenSentinelKeyId()!;
    const anonB = createZenSentinelKey();

    setCooldown('opencode', 'mimo-v2.5-free', anonA, 60_000);
    setCooldown('opencode', 'mimo-v2.5-free', real1, 60_000);
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms)
      VALUES ('opencode', 'mimo-v2.5-free', ?, 'success', 10, 5, 100)
    `).run(anonB);
    getDb().prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES ('opencode', 'mimo-v2.5-free', ?, 'tokens', 15, ?)
    `).run(anonB, Date.now());

    const state = clearZenAnonKeys();

    expect(state.removed).toBe(2);
    expect(state.enabled).toBe(true);
    expect(state.sentinelKeyId).toBeNull();
    expect(state.anonKeyCount).toBe(0);
    expect(state.zenKeyCount).toBe(2);
    expect(state.disabledZenKeyCount).toBe(2);

    expect(opencodeRows().map(r => r.label)).toEqual(['zen-a', 'zen-b']);
    expect(enabledOf(real1)).toBe(0);

    const sentinelCooldowns = getDb().prepare(
      'SELECT COUNT(*) AS c FROM rate_limit_cooldowns WHERE key_id IN (?, ?)',
    ).get(anonA, anonB) as { c: number };
    expect(sentinelCooldowns.c).toBe(0);
    const realCooldowns = getDb().prepare(
      'SELECT COUNT(*) AS c FROM rate_limit_cooldowns WHERE key_id = ?',
    ).get(real1) as { c: number };
    expect(realCooldowns.c).toBe(1);

    const requestRows = getDb().prepare(
      'SELECT COUNT(*) AS c FROM requests WHERE key_id = ?',
    ).get(anonB) as { c: number };
    expect(requestRows.c).toBe(1);
    const usageRows = getDb().prepare(
      'SELECT COUNT(*) AS c FROM rate_limit_usage WHERE key_id = ?',
    ).get(anonB) as { c: number };
    expect(usageRows.c).toBe(1);
  });

  it('lets ensureZenPool lazily recreate a fresh anon key while still enabled', () => {
    setZenKeylessMode(true);
    createZenSentinelKey();

    const state = clearZenAnonKeys();
    expect(state.anonKeyCount).toBe(0);

    ensureZenPool();
    const recreated = getZenSentinelKeyId();
    expect(recreated).not.toBeNull();
    const row = getDb().prepare('SELECT label, enabled FROM api_keys WHERE id = ?').get(recreated!) as { label: string; enabled: number };
    expect(row.label).toBe('anon 1');
    expect(row.enabled).toBe(1);
  });

  it('removes disabled leftover anon keys when the mode is off', () => {
    insertKey('opencode', 'zen-a');
    setZenKeylessMode(true);
    setZenKeylessMode(false);
    expect(getZenKeylessState().anonKeyCount).toBe(1);

    const state = clearZenAnonKeys();

    expect(state.removed).toBe(1);
    expect(getZenKeylessState()).toEqual({
      enabled: false,
      sentinelKeyId: null,
      zenKeyCount: 1,
      disabledZenKeyCount: 0,
      anonKeyCount: 0,
    });
  });
});
