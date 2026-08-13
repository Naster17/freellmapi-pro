import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
import { providerLog } from '../lib/server-logs.js';
import { setCooldown, type CooldownSource } from './ratelimit.js';

export const ZEN_KEYLESS_MODE_SETTING = 'zen_keyless_mode';
export const ZEN_KEYLESS_BACKUP_SETTING = 'zen_keyless_backup_keys';
export const ZEN_SENTINEL_LABEL = 'anon';
export const LEGACY_ZEN_SENTINEL_LABEL = 'Zen anonymous';
export const ZEN_NO_KEY = 'no-key';

const IP_EXHAUSTION_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_IP_BUDGET = 8;
const EXHAUSTED_IP_CAP = 4096;

const exhaustedIps = new Map<string, number>();
const recentIps: string[] = [];
let currentIp: string | null = null;

const activeIps = new Set<string>();
export const zenIpStorage = new AsyncLocalStorage<ZenIpLease>();

export interface ZenIpLease {
  readonly ip: string;
  release(): void;
  dispose(): void;
}

export interface ZenKeylessState {
  enabled: boolean;
  sentinelKeyId: number | null;
  zenKeyCount: number;
  disabledZenKeyCount: number;
}

function opencodeKeys(db = getDb()): Array<{ id: number; enabled: number; label: string }> {
  return db.prepare('SELECT id, enabled, label FROM api_keys WHERE platform = ?').all('opencode') as Array<{ id: number; enabled: number; label: string }>;
}

export function isZenKeylessMode(): boolean {
  return getSetting(ZEN_KEYLESS_MODE_SETTING) === '1';
}

export function isSentinelKeyLabel(label: string): boolean {
  return label === ZEN_SENTINEL_LABEL
    || label === LEGACY_ZEN_SENTINEL_LABEL
    || /^anon \d+$/.test(label);
}

function sentinelRows(db = getDb()): Array<{ id: number; label: string }> {
  return opencodeKeys(db)
    .filter(k => isSentinelKeyLabel(k.label))
    .map(k => ({ id: k.id, label: k.label }))
    .sort((a, b) => a.id - b.id);
}

function createAnonKey(db: ReturnType<typeof getDb>, label: string): number {
  const { encrypted, iv, authTag } = encrypt(ZEN_NO_KEY);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run('opencode', label, encrypted, iv, authTag);
  return Number(result.lastInsertRowid);
}

function normalizeSentinelLabels(db: ReturnType<typeof getDb>): void {
  const rows = sentinelRows(db);
  rows.forEach((row, i) => {
    const want = `anon ${i + 1}`;
    if (row.label !== want) {
      db.prepare('UPDATE api_keys SET label = ? WHERE id = ?').run(want, row.id);
    }
  });
}

export function ensureZenPool(db = getDb()): void {
  if (sentinelRows(db).length === 0) {
    createAnonKey(db, 'anon 1');
    return;
  }
  normalizeSentinelLabels(db);
}

export function createZenSentinelKey(db = getDb()): number {
  ensureZenPool(db);
  const maxOrdinal = sentinelRows(db).reduce((max, row) => {
    const m = /^anon (\d+)$/.exec(row.label);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return createAnonKey(db, `anon ${maxOrdinal + 1}`);
}

export function getZenSentinelKeyId(): number | null {
  const rows = sentinelRows();
  return rows.length ? rows[0].id : null;
}

export function isZenSentinelKey(platform: string, keyId: number): boolean {
  if (platform !== 'opencode') return false;
  const row = getDb().prepare('SELECT label FROM api_keys WHERE id = ?').get(keyId) as { label: string } | undefined;
  return !!row && isSentinelKeyLabel(row.label);
}

export function isZenAnonymousKey(platform: string, keyId: number): boolean {
  if (!isZenKeylessMode()) return false;
  return isZenSentinelKey(platform, keyId);
}

export function getZenKeylessState(): ZenKeylessState {
  const keys = opencodeKeys();
  return {
    enabled: isZenKeylessMode(),
    sentinelKeyId: getZenSentinelKeyId(),
    zenKeyCount: keys.length,
    disabledZenKeyCount: keys.filter(k => k.enabled === 0).length,
  };
}

export function ensureZenSentinel(): number | null {
  if (!isZenKeylessMode()) return null;
  ensureZenPool();
  const id = getZenSentinelKeyId();
  if (id !== null) {
    getDb().prepare('UPDATE api_keys SET enabled = 1 WHERE id = ?').run(id);
  }
  return id;
}

function parseIdList(raw: string | undefined): number[] {
  if (!raw || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

export function setZenKeylessMode(enabled: boolean): ZenKeylessState {
  const db = getDb();
  if (enabled) {
    const allOpen = opencodeKeys(db);
    const backup = allOpen
      .filter(k => k.enabled === 1 && !isSentinelKeyLabel(k.label))
      .map(k => k.id);
    setSetting(ZEN_KEYLESS_BACKUP_SETTING, JSON.stringify(backup));
    setSetting(ZEN_KEYLESS_MODE_SETTING, '1');
    ensureZenPool(db);
    for (const k of allOpen) {
      if (!isSentinelKeyLabel(k.label)) {
        db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(k.id);
      }
    }
  } else {
    setSetting(ZEN_KEYLESS_MODE_SETTING, '0');
    for (const k of sentinelRows(db)) {
      db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(k.id);
    }
    for (const id of parseIdList(getSetting(ZEN_KEYLESS_BACKUP_SETTING))) {
      db.prepare('UPDATE api_keys SET enabled = 1 WHERE id = ? AND platform = ?').run(id, 'opencode');
    }
    setSetting(ZEN_KEYLESS_BACKUP_SETTING, '');
  }
  return getZenKeylessState();
}

export function randomPublicIp(): string {
  const a = Math.floor(Math.random() * 223) + 1;
  const b = Math.floor(Math.random() * 256);
  const c = Math.floor(Math.random() * 256);
  const d = Math.floor(Math.random() * 256);
  if (a === 10) return randomPublicIp();
  if (a === 127) return randomPublicIp();
  if (a === 169 && b === 254) return randomPublicIp();
  if (a === 172 && b >= 16 && b <= 31) return randomPublicIp();
  if (a === 192 && b === 168) return randomPublicIp();
  if (a === 100 && b >= 64 && b <= 127) return randomPublicIp();
  if (a === 198 && (b === 18 || b === 19)) return randomPublicIp();
  return `${a}.${b}.${c}.${d}`;
}

function freshZenIp(): string {
  for (let i = 0; i < 32; i++) {
    const ip = randomPublicIp();
    if (exhaustedIps.has(ip)) continue;
    if (recentIps.includes(ip)) continue;
    if (activeIps.has(ip)) continue;
    return ip;
  }
  exhaustedIps.clear();
  recentIps.length = 0;
  let ip = randomPublicIp();
  while (activeIps.has(ip)) ip = randomPublicIp();
  return ip;
}

export function acquireZenIpLease(): ZenIpLease | null {
  if (!isZenKeylessMode()) return null;
  const ip = freshZenIp();
  activeIps.add(ip);
  let released = false;
  return {
    ip,
    release: () => {
      if (released) return;
      released = true;
      activeIps.delete(ip);
    },
    dispose: () => {
      if (released) return;
      released = true;
      activeIps.delete(ip);
      markZenIpExhausted(ip);
      recentIps.push(ip);
      if (recentIps.length > RECENT_IP_BUDGET) recentIps.shift();
    },
  };
}

export function currentZenIp(): string | null {
  if (!isZenKeylessMode()) return null;
  const lease = zenIpStorage.getStore();
  if (lease !== undefined) return lease.ip;
  if (currentIp !== null) return currentIp;
  currentIp = freshZenIp();
  return currentIp;
}

export function markZenIpExhausted(ip?: string): void {
  const target = ip ?? currentIp;
  if (target === null) return;
  if (!exhaustedIps.has(target)) {
    providerLog(
      `Zen anonymous IP ${target} exhausted by upstream; rotating (not reused for 24h)`,
      { level: 'warn', provider: 'opencode', event: 'zen_ip_exhausted' },
    );
  }
  exhaustedIps.set(target, Date.now() + IP_EXHAUSTION_TTL_MS);
  if (exhaustedIps.size > EXHAUSTED_IP_CAP) {
    const now = Date.now();
    for (const [key, value] of exhaustedIps) {
      if (value <= now) exhaustedIps.delete(key);
    }
  }
}

export function isZenIpExhausted(ip: string): boolean {
  return exhaustedIps.has(ip);
}

export function rotateZenIp(): string | null {
  if (!isZenKeylessMode()) return null;
  if (currentIp !== null) {
    recentIps.push(currentIp);
    if (recentIps.length > RECENT_IP_BUDGET) recentIps.shift();
  }
  const previous = currentIp;
  currentIp = freshZenIp();
  providerLog(
    `Zen anonymous IP rotated ${previous ?? '(none)'} → ${currentIp}`,
    { level: 'info', provider: 'opencode', event: 'zen_ip_rotate' },
  );
  return currentIp;
}

export function _resetZenKeylessState(): void {
  exhaustedIps.clear();
  recentIps.length = 0;
  currentIp = null;
  activeIps.clear();
}

// zen's anonymous tier drains ONE shared per-model budget per real egress IP
// per UTC day (ipRateLimiter.ts upstream reads the socket IP — every spoofable
// IP header was tested and ignored), so a FreeUsageLimitError benched at the
// KEY would only send the next attempt to a sibling key on the same IP, which
// shares that budget and 429s in turn. Bench every enabled zen key for ONE
// model: the limit is per-model (an exhausted deepseek does NOT bench hy3),
// and shared across keys, so both anon and named pools gate together. The
// bench is 'heuristic' (not 'authoritative') because its expiry is OUR guess
// (next UTC midnight), not a provider-stated Retry-After — the real egress IP
// can change (router reboot) or the upstream can lift the throttle any time,
// and the cooldown-probe job plus the in-request probe must be free to clear
// it the moment zen serves again instead of stranding the pool until midnight.
const BENCH_MODEL_CAP = 100;

export function benchZenModelPool(
  modelId: string,
  durationMs: number,
  source: CooldownSource = 'heuristic',
  reason = 'zen_daily_limit',
): number {
  const db = getDb();
  const rows = db.prepare("SELECT id FROM api_keys WHERE platform = 'opencode' AND enabled = 1")
    .all() as { id: number }[];
  if (rows.length === 0) return 0;

  let benched = 0;
  for (const k of rows) {
    setCooldown('opencode', modelId, k.id, durationMs, source, reason);
    benched++;
  }
  providerLog(
    `Zen free-tier daily limit hit for ${modelId} — benched ${rows.length} key(s) for ~${Math.round(durationMs / 1000)}s`,
    { level: 'warn', provider: 'opencode', event: 'zen_daily_limit_benched' },
  );
  return benched;
}
