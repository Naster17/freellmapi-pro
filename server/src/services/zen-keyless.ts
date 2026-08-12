import { getDb, getSetting, setSetting } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';

export const ZEN_KEYLESS_MODE_SETTING = 'zen_keyless_mode';
export const ZEN_KEYLESS_BACKUP_SETTING = 'zen_keyless_backup_keys';
export const ZEN_SENTINEL_LABEL = 'Zen anonymous';
export const ZEN_NO_KEY = 'no-key';

const IP_EXHAUSTION_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_IP_BUDGET = 8;
const EXHAUSTED_IP_CAP = 4096;

const exhaustedIps = new Map<string, number>();
const recentIps: string[] = [];
let currentIp: string | null = null;

export interface ZenKeylessState {
  enabled: boolean;
  sentinelKeyId: number | null;
  zenKeyCount: number;
  disabledZenKeyCount: number;
}

function opencodeKeys(db = getDb()): Array<{ id: number; enabled: number }> {
  return db.prepare('SELECT id, enabled FROM api_keys WHERE platform = ?').all('opencode') as Array<{ id: number; enabled: number }>;
}

export function isZenKeylessMode(): boolean {
  return getSetting(ZEN_KEYLESS_MODE_SETTING) === '1';
}

export function getZenSentinelKeyId(): number | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT id FROM api_keys WHERE platform = ? AND label = ? ORDER BY id LIMIT 1',
  ).get('opencode', ZEN_SENTINEL_LABEL) as { id: number } | undefined;
  return row?.id ?? null;
}

export function isZenSentinelKey(platform: string, keyId: number): boolean {
  if (platform !== 'opencode') return false;
  return getZenSentinelKeyId() === keyId;
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
  const existing = getZenSentinelKeyId();
  if (existing !== null) return existing;
  if (!isZenKeylessMode()) return null;
  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(ZEN_NO_KEY);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run('opencode', ZEN_SENTINEL_LABEL, encrypted, iv, authTag);
  return Number(result.lastInsertRowid);
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
    const backup = opencodeKeys(db)
      .filter(k => k.enabled === 1)
      .map(k => k.id);
    setSetting(ZEN_KEYLESS_BACKUP_SETTING, JSON.stringify(backup));
    db.prepare('UPDATE api_keys SET enabled = 0 WHERE platform = ? AND label != ?').run('opencode', ZEN_SENTINEL_LABEL);
    setSetting(ZEN_KEYLESS_MODE_SETTING, '1');
    ensureZenSentinel();
  } else {
    setSetting(ZEN_KEYLESS_MODE_SETTING, '0');
    const sentinelId = getZenSentinelKeyId();
    if (sentinelId !== null) {
      db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(sentinelId);
    }
    for (const id of parseIdList(getSetting(ZEN_KEYLESS_BACKUP_SETTING))) {
      db.prepare('UPDATE api_keys SET enabled = 1 WHERE id = ? AND platform = ?').run(id, 'opencode');
    }
    setSetting(ZEN_KEYLESS_BACKUP_SETTING, '');
  }
  return getZenKeylessState();
}

function randomPublicIp(): string {
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
    return ip;
  }
  exhaustedIps.clear();
  recentIps.length = 0;
  return randomPublicIp();
}

export function currentZenIp(): string | null {
  if (!isZenKeylessMode()) return null;
  if (currentIp !== null) return currentIp;
  currentIp = freshZenIp();
  return currentIp;
}

export function markZenIpExhausted(): void {
  const ip = currentIp;
  if (ip === null) return;
  exhaustedIps.set(ip, Date.now() + IP_EXHAUSTION_TTL_MS);
  if (exhaustedIps.size > EXHAUSTED_IP_CAP) {
    const now = Date.now();
    for (const [key, value] of exhaustedIps) {
      if (value <= now) exhaustedIps.delete(key);
    }
  }
}

export function rotateZenIp(): string | null {
  if (!isZenKeylessMode()) return null;
  if (currentIp !== null) {
    recentIps.push(currentIp);
    if (recentIps.length > RECENT_IP_BUDGET) recentIps.shift();
  }
  currentIp = freshZenIp();
  return currentIp;
}

export function _resetZenKeylessState(): void {
  exhaustedIps.clear();
  recentIps.length = 0;
  currentIp = null;
}
