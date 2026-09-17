import { getDb, getSetting, setSetting } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { setPlatformProxyResolver, setProxyRateLimitReporter, setProxySuccessReporter, setProxyTransportFailureReporter, proxyFetchVia } from '../lib/proxy.js';
import { providerLog } from '../lib/server-logs.js';
import type { Scheduler } from '../lib/scheduler.js';

export const PROXY_TYPES = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'] as const;
export type ProxyType = (typeof PROXY_TYPES)[number];
export type ProxyStatus = 'unknown' | 'healthy' | 'error';
export type ProxySource = 'manual' | 'public';

const DEFAULT_RATE_LIMIT_THRESHOLD = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export const PROXY_RL_THRESHOLD_SETTING = 'proxy_pool_rate_limit_threshold';
export const PROXY_MINER_ENABLED_SETTING = 'proxy_miner_enabled';
export const PROXY_DIRECT_PLATFORMS_SETTING = 'proxy_pool_direct_platforms';
export const PROXY_RL_DISABLE_SETTING = 'proxy_pool_disable_on_rate_limit';
export const DEFAULT_PROXY_RL_DISABLE = 3;

export function getProxyRateLimitDisableCount(): number {
  try {
    const raw = getSetting(PROXY_RL_DISABLE_SETTING);
    if (raw === undefined || raw.trim() === '') return DEFAULT_PROXY_RL_DISABLE;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_PROXY_RL_DISABLE;
    return Math.min(n, 500);
  } catch {
    return DEFAULT_PROXY_RL_DISABLE;
  }
}

export function setProxyRateLimitDisableCount(n: number): void {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) throw new Error('disable-after must be a positive number');
  setSetting(PROXY_RL_DISABLE_SETTING, String(Math.min(v, 500)));
}

export function getProxyRateLimitThreshold(): number {
  try {
    const raw = getSetting(PROXY_RL_THRESHOLD_SETTING);
    if (raw === undefined || raw.trim() === '') return DEFAULT_RATE_LIMIT_THRESHOLD;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_RATE_LIMIT_THRESHOLD;
    return Math.min(n, 500);
  } catch {
    return DEFAULT_RATE_LIMIT_THRESHOLD;
  }
}

export function setProxyRateLimitThreshold(n: number): void {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) throw new Error('threshold must be a positive number');
  setSetting(PROXY_RL_THRESHOLD_SETTING, String(Math.min(v, 500)));
}

export function isPublicProxyMiningEnabled(): boolean {
  try {
    return getSetting(PROXY_MINER_ENABLED_SETTING) === '1';
  } catch {
    return false;
  }
}

export function setPublicProxyMiningEnabled(enabled: boolean): void {
  setSetting(PROXY_MINER_ENABLED_SETTING, enabled ? '1' : '0');
}

export function getProxyDirectPlatforms(): string[] {
  try {
    const raw = getSetting(PROXY_DIRECT_PLATFORMS_SETTING);
    if (raw === undefined || raw.trim() === '') return [];
    return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

export function setProxyDirectPlatforms(platforms: string[]): void {
  for (const p of platforms) {
    if (!/^[a-z0-9_-]{1,64}$/.test(p)) throw new Error(`invalid platform slug: ${p}`);
  }
  setSetting(PROXY_DIRECT_PLATFORMS_SETTING, platforms.map(p => p.toLowerCase()).join(','));
  for (const platform of platforms.map(p => p.toLowerCase())) {
    if (assignments.has(platform)) {
      pushHistory(platform, assignments.get(platform)!.proxyId, Date.now());
      assignments.delete(platform);
      pushActivity({
        ts: Date.now(),
        kind: 'released',
        platform,
        proxyId: 0,
        proxyLabel: 'direct',
        latencyMs: null,
      });
    }
  }
}

export function isDirectPlatform(platform: string): boolean {
  return getProxyDirectPlatforms().includes(platform.toLowerCase());
}

export function releasePublicAssignments(): void {
  for (const [platform, assignment] of [...assignments]) {
    const row = getProxy(assignment.proxyId);
    if (row && (row.source ?? 'manual') === 'public') {
      pushHistory(platform, assignment.proxyId, Date.now());
      assignments.delete(platform);
      pushActivity({
        ts: Date.now(),
        kind: 'released',
        platform,
        proxyId: assignment.proxyId,
        proxyLabel: labelOf(assignment.proxyId),
        latencyMs: null,
      });
    }
  }
}
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CHECK_CONCURRENCY = 8;
const PROBE_URLS = [
  'https://www.google.com/generate_204',
  'https://www.gstatic.com/generate_204',
  'https://connectivitycheck.gstatic.com/generate_204',
  'https://api.ipify.org/',
];
const PROBE_TIMEOUT_MS = 10_000;
const ACTIVITY_LIMIT = 100;
const STATUS_RANK: Record<ProxyStatus, number> = { healthy: 0, unknown: 1, error: 2 };
const QUALITY_EMA_ALPHA = 0.35;

export function proxyQualityScore(row: Pick<ProxyRow, 'success_count' | 'failure_count'>): number {
  const wins = Math.max(0, row.success_count ?? 0);
  const losses = Math.max(0, row.failure_count ?? 0);
  return (wins + 1) / (wins + losses + 2);
}

export function proxyDisplayLatencyMs(row: Pick<ProxyRow, 'latency_ms' | 'latency_ema_ms'>): number | null {
  return row.latency_ema_ms ?? row.latency_ms ?? null;
}

function rankProxy(a: ProxyRow, b: ProxyRow): number {
  const rankA = STATUS_RANK[a.status];
  const rankB = STATUS_RANK[b.status];
  if (rankA !== rankB) return rankA - rankB;
  const qa = proxyQualityScore(a);
  const qb = proxyQualityScore(b);
  if (qa !== qb) return qb - qa;
  const latA = proxyDisplayLatencyMs(a) ?? Infinity;
  const latB = proxyDisplayLatencyMs(b) ?? Infinity;
  if (latA !== latB) return latA - latB;
  return a.id - b.id;
}

export function recordProxyOutcome(id: number, ok: boolean, latencyMs?: number | null): void {
  try {
    if (ok) {
      if (latencyMs !== undefined && latencyMs !== null && Number.isFinite(latencyMs)) {
        getDb().prepare(`
          UPDATE proxies
             SET success_count = success_count + 1,
                 latency_ema_ms = CASE
                   WHEN latency_ema_ms IS NULL THEN ?
                   ELSE (? * ? + latency_ema_ms * (1 - ?))
                 END,
                 updated_at = datetime('now')
           WHERE id = ?
        `).run(latencyMs, latencyMs, QUALITY_EMA_ALPHA, QUALITY_EMA_ALPHA, id);
      } else {
        getDb().prepare(`
          UPDATE proxies SET success_count = success_count + 1, updated_at = datetime('now') WHERE id = ?
        `).run(id);
      }
    } else {
      getDb().prepare(`
        UPDATE proxies SET failure_count = failure_count + 1, updated_at = datetime('now') WHERE id = ?
      `).run(id);
    }
  } catch (err: any) {
    console.warn(`[ProxyPool] outcome bookkeeping failed: ${err?.message ?? err}`);
  }
}

export interface ProxyRow {
  id: number;
  label: string;
  type: ProxyType;
  host: string;
  port: number;
  username: string | null;
  encrypted_password: string | null;
  iv: string | null;
  auth_tag: string | null;
  enabled: number;
  source: ProxySource;
  status: ProxyStatus;
  latency_ms: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  success_count: number;
  failure_count: number;
  latency_ema_ms: number | null;
}

export interface ProxyInput {
  type: ProxyType;
  address: string;
  label?: string;
  source?: ProxySource;
}

export interface ProxyUpdate {
  label?: string;
  enabled?: boolean;
  type?: ProxyType;
  address?: string;
}

export interface ParsedAddress {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseProxyAddress(raw: string): ParsedAddress {
  let rest = raw.trim();
  const scheme = rest.match(/^[a-z0-9+]+:\/\//i);
  if (scheme) rest = rest.slice(scheme[0].length);

  let username: string | undefined;
  let password: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = rest.slice(0, at);
    const sep = userinfo.indexOf(':');
    if (sep >= 0) {
      username = decodeURIComponent(userinfo.slice(0, sep));
      password = decodeURIComponent(userinfo.slice(sep + 1));
    } else {
      username = decodeURIComponent(userinfo);
    }
    rest = rest.slice(at + 1);
  }

  let host: string;
  let port: number;
  rest = rest.replace(/\/+$/, '');
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) throw new Error('invalid IPv6 proxy address');
    host = rest.slice(1, close);
    const after = rest.slice(close + 1);
    if (!/^:\d+$/.test(after)) throw new Error('proxy address is missing a port');
    port = Number(after.slice(1));
  } else {
    const sep = rest.lastIndexOf(':');
    if (sep <= 0 || sep === rest.length - 1) throw new Error('proxy address must be host:port');
    host = rest.slice(0, sep);
    port = Number(rest.slice(sep + 1));
  }

  if (!host) throw new Error('proxy address is missing a host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('proxy port must be between 1 and 65535');
  return { host, port, username, password };
}

export function buildProxyUrl(row: Pick<ProxyRow, 'type' | 'host' | 'port' | 'username' | 'encrypted_password' | 'iv' | 'auth_tag'>): string {
  let credentials = '';
  if (row.username) {
    const password = row.encrypted_password ? decrypt(row.encrypted_password, row.iv ?? '', row.auth_tag ?? '') : '';
    credentials = password ? `${encodeURIComponent(row.username)}:${encodeURIComponent(password)}@` : `${encodeURIComponent(row.username)}@`;
  }
  const hostPort = row.host.includes(':') ? `[${row.host}]:${row.port}` : `${row.host}:${row.port}`;
  return `${row.type}://${credentials}${hostPort}`;
}

export function listProxies(): ProxyRow[] {
  return getDb().prepare('SELECT * FROM proxies ORDER BY id').all() as ProxyRow[];
}

export function getProxy(id: number): ProxyRow | undefined {
  return getDb().prepare('SELECT * FROM proxies WHERE id = ?').get(id) as ProxyRow | undefined;
}

export function createProxy(input: ProxyInput): ProxyRow {
  const parsed = parseProxyAddress(input.address);
  const password = parsed.password;
  const encrypted = password ? encrypt(password) : null;
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO proxies (label, type, host, port, username, encrypted_password, iv, auth_tag, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    (input.label ?? '').trim(),
    input.type,
    parsed.host,
    parsed.port,
    parsed.username ?? null,
    encrypted?.encrypted ?? null,
    encrypted?.iv ?? null,
    encrypted?.authTag ?? null,
    input.source === 'public' ? 'public' : 'manual',
  );
  const row = getProxy(Number(info.lastInsertRowid));
  if (!row) throw new Error('failed to load created proxy');
  return row;
}

export function updateProxy(id: number, input: ProxyUpdate): ProxyRow {
  const row = getProxy(id);
  if (!row) throw new Error('proxy not found');

  const next: Record<string, unknown> = {};
  if (input.label !== undefined) next.label = input.label.trim();
  if (input.enabled !== undefined) next.enabled = input.enabled ? 1 : 0;

  let type = row.type;
  let host = row.host;
  let port = row.port;
  let username = row.username;
  let encrypted = row.encrypted_password ? { encrypted: row.encrypted_password, iv: row.iv ?? '', authTag: row.auth_tag ?? '' } : null;

  if (input.type !== undefined) type = input.type;
  if (input.address !== undefined) {
    const parsed = parseProxyAddress(input.address);
    host = parsed.host;
    port = parsed.port;
    username = parsed.username ?? null;
    encrypted = parsed.password ? encrypt(parsed.password) : null;
  }

  next.type = type;
  next.host = host;
  next.port = port;
  next.username = username;
  next.encrypted_password = encrypted?.encrypted ?? null;
  next.iv = encrypted?.iv ?? null;
  next.auth_tag = encrypted?.authTag ?? null;

  const cols = Object.keys(next).map(c => `${c} = ?`).join(', ');
  const values = Object.values(next);
  getDb().prepare(`UPDATE proxies SET ${cols}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);

  if (input.enabled === false) dropAssignmentsFor(id, 'released');

  const updated = getProxy(id);
  if (!updated) throw new Error('failed to load updated proxy');
  return updated;
}

export function deleteProxy(id: number): void {
  dropAssignmentsFor(id, 'released');
  getDb().prepare('DELETE FROM proxies WHERE id = ?').run(id);
}

export function deleteInactiveProxies(): number {
  const rows = getDb().prepare(`
    SELECT id FROM proxies WHERE status != 'healthy'
  `).all() as { id: number }[];
  let removed = 0;
  for (const row of rows) {
    try {
      deleteProxy(row.id);
      removed++;
    } catch {
      continue;
    }
  }
  return removed;
}

export function deleteAllProxies(): number {
  const rows = getDb().prepare('SELECT id FROM proxies').all() as { id: number }[];
  let removed = 0;
  for (const row of rows) {
    try {
      deleteProxy(row.id);
      removed++;
    } catch {
      continue;
    }
  }
  return removed;
}

export function deleteDisabledProxies(): number {
  const rows = getDb().prepare('SELECT id FROM proxies WHERE enabled = 0').all() as { id: number }[];
  let removed = 0;
  for (const row of rows) {
    try {
      deleteProxy(row.id);
      removed++;
    } catch {
      continue;
    }
  }
  return removed;
}

const assignments = new Map<string, { proxyId: number; sinceMs: number }>();
const escalatedAt = new Map<string, number>();
const rlHits = new Map<string, number[]>();
const history = new Map<string, { proxyId: number; sinceMs: number; untilMs: number | null }[]>();

export type ActivityKind = 'assigned' | 'rotated' | 'released' | 'proxy_down';
export interface ActivityEvent {
  ts: number;
  kind: ActivityKind;
  platform: string;
  proxyId: number;
  proxyLabel: string;
  latencyMs: number | null;
}

let activity: ActivityEvent[] = [];

export function resetProxyPoolStateForTests(): void {
  assignments.clear();
  escalatedAt.clear();
  rlHits.clear();
  history.clear();
  activity = [];
  checkAllInFlight = null;
  initialized = false;
  setPlatformProxyResolver(null);
  setProxyTransportFailureReporter(null);
  setProxySuccessReporter(null);
  setProxyRateLimitReporter(null);
}

function pushActivity(event: ActivityEvent): void {
  activity.push(event);
  if (activity.length > ACTIVITY_LIMIT) activity = activity.slice(-ACTIVITY_LIMIT);
}

function pushHistory(platform: string, prev: ActivityEvent['proxyId'] | null, untilMs: number): void {
  const list = history.get(platform) ?? [];
  if (prev !== null) {
    const last = list[list.length - 1];
    const active = last && last.proxyId === prev && last.untilMs === null ? last : null;
    const record = active ?? { proxyId: prev, sinceMs: list.length ? (list[list.length - 1]?.untilMs ?? 0) : 0, untilMs: null };
    record.untilMs = untilMs;
    if (!active) list.push(record);
  }
  if (list.length > HISTORY_CAP) list.splice(0, list.length - HISTORY_CAP);
  history.set(platform, list);
}

function candidateProxies(): ProxyRow[] {
  return listProxies()
    .filter(p => p.enabled === 1)
    .sort(rankProxy)
    .filter(p => p.status !== 'error');
}

function refreshSortedSnapshot(): ProxyRow[] {
  const list = candidateProxies();
  return list.length > 0 ? list : [];
}

function rotateProxyFor(platform: string, silent = false): void {
  const sorted = refreshSortedSnapshot();
  if (sorted.length === 0) return;
  const now = Date.now();
  const current = assignments.get(platform);
  let next: ProxyRow;

  if (!current) {
    next = sorted[0];
  } else {
    const idx = sorted.findIndex(p => p.id === current.proxyId);
    if (idx === -1) {
      next = sorted[0];
    } else {
      next = sorted[(idx + 1) % sorted.length]!;
    }
  }

  if (current && current.proxyId === next.id) return;

  if (current) pushHistory(platform, current.proxyId, now);
  assignments.set(platform, { proxyId: next.id, sinceMs: now });
  if (silent) return;
  pushActivity({
    ts: now,
    kind: current ? 'rotated' : 'assigned',
    platform,
    proxyId: next.id,
    proxyLabel: next.label || `${next.type}://${next.host}:${next.port}`,
    latencyMs: next.latency_ms,
  });
}

export function hasUsableProxies(): boolean {
  return candidateProxies().length > 0;
}

const ROTATE_PER_REQUEST_PLATFORMS = new Set(['opencode']);
const HISTORY_CAP = 100;
const ESCALATION_TTL_MS = 15 * 60 * 1000;

export function isRotatePerRequestPlatform(platform: string): boolean {
  return ROTATE_PER_REQUEST_PLATFORMS.has(platform.toLowerCase());
}

export function noteProxyRateLimit(platform: string): void {
  if (!platform || isDirectPlatform(platform)) return;
  try {
    const now = Date.now();
    const hits = (rlHits.get(platform) ?? []).filter(t => t > now - RATE_LIMIT_WINDOW_MS);
    hits.push(now);
    rlHits.set(platform, hits);
    if (hits.length < getProxyRateLimitThreshold()) return;
    rlHits.set(platform, []);
    escalatedAt.set(platform, now);
    rotateProxyFor(platform);
  } catch (err: any) {
    console.warn(`[ProxyPool] rate-limit escalation failed for ${platform}: ${err?.message ?? err}`);
  }
}

function dropAssignmentsFor(proxyId: number, kind: ActivityKind): void {
  if (kind !== 'rotated') {
    for (const [platform, assignment] of assignments) {
      if (assignment.proxyId !== proxyId) continue;
      assignments.delete(platform);
      pushHistory(platform, proxyId, Date.now());
      pushActivity({
        ts: Date.now(),
        kind,
        platform,
        proxyId,
        proxyLabel: labelOf(proxyId),
        latencyMs: null,
      });
    }
  }
}

function labelOf(proxyId: number): string {
  const row = getProxy(proxyId);
  return row ? (row.label || `${row.type}://${row.host}:${row.port}`) : `proxy #${proxyId}`;
}

function resolveProxyForPlatform(platform?: string): string | undefined {
  if (!platform || isDirectPlatform(platform)) {
    if (platform) assignments.delete(platform);
    return undefined;
  }
  if (!assignments.has(platform)) return undefined;
  const escalated = escalatedAt.get(platform);
  if (escalated !== undefined && Date.now() - escalated > ESCALATION_TTL_MS) {
    assignments.delete(platform);
    escalatedAt.delete(platform);
    rlHits.delete(platform);
    return undefined;
  }
  if (ROTATE_PER_REQUEST_PLATFORMS.has(platform)) rotateProxyFor(platform, true);
  const assignment = assignments.get(platform);
  if (!assignment) return undefined;
  const row = getProxy(assignment.proxyId);
  if (!row || row.enabled === 0) {
    assignments.delete(platform);
    return undefined;
  }
  return buildProxyUrl(row);
}

export function getProxyForPlatform(platform: string): ProxyRow | undefined {
  if (!platform || isDirectPlatform(platform)) return undefined;
  const assignment = assignments.get(platform);
  if (!assignment) return undefined;
  const row = getProxy(assignment.proxyId);
  if (!row || row.enabled === 0) return undefined;
  return row;
}

export function getPlatformAssignmentCount(): number {
  return assignments.size;
}

export interface ProxyProbeResult {
  id: number;
  status: ProxyStatus;
  latencyMs: number | null;
  lastError: string | null;
}

function describeProbeError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err);
  const lower = raw.toLowerCase();
  if (/(unable to verify the first certificate|self[- ]signed|certificate.*(expired|untrusted)|unable to get local issuer)/.test(lower)) {
    return 'TLS certificate cannot be verified — the proxy may be intercepting HTTPS with a self-signed certificate';
  }
  if (lower.includes('econnrefused')) {
    return 'Connection refused — the proxy is not accepting connections';
  }
  if (lower.includes('econnreset')) {
    return 'Connection reset by the proxy';
  }
  if (lower.includes('etimedout') || lower.includes('timeout')) {
    return 'Timed out — the proxy did not respond in time';
  }
  if (lower.includes('enotfound') || lower.includes('eai_again')) {
    return 'DNS lookup failed — the proxy hostname could not be resolved';
  }
  if (lower.includes('socket hang up') || lower.includes('other side closed')) {
    return 'Connection closed by the proxy before a response arrived';
  }
  if (/dispatcher could not be built/.test(lower)) {
    return 'Proxy agent could not be created for the given address';
  }
  return raw.slice(0, 200);
}

export async function checkProxy(id: number): Promise<ProxyProbeResult> {
  const row = getProxy(id);
  if (!row) throw new Error('proxy not found');
  return probeRow(row);
}

async function probeRow(row: ProxyRow): Promise<ProxyProbeResult> {
  const url = buildProxyUrl(row);
  const startedAt = Date.now();
  let status: ProxyStatus;
  let lastError: string | null;
  let latencyMs: number | null = null;

  try {
    const res = await probeProxy(url);
    latencyMs = Date.now() - startedAt;
    const ok = res.status >= 200 && res.status < 400;
    status = ok ? 'healthy' : 'error';
    lastError = ok ? null : `probe target answered HTTP ${res.status}`;
  } catch (err: any) {
    status = 'error';
    lastError = describeProbeError(err);
  }

  getDb().prepare(`
    UPDATE proxies
       SET status = ?, latency_ms = ?, last_checked_at = datetime('now'), last_error = ?
     WHERE id = ?
  `).run(status, latencyMs, lastError, row.id);
  recordProxyOutcome(row.id, status === 'healthy', latencyMs);

  if (status === 'error') handleProxiesDown([row], row.id);

  return { id: row.id, status, latencyMs, lastError };
}

async function probeProxy(url: string): Promise<Response> {
  let lastError: unknown = null;
  let lastHttpStatus: number | null = null;
  for (const probeUrl of PROBE_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await proxyFetchVia(probeUrl, { method: 'GET', signal: controller.signal }, url, PROBE_TIMEOUT_MS);
      if (res.status >= 200 && res.status < 400) return res;
      if (res.status >= 400) {
        lastHttpStatus = res.status;
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if ((err as Error)?.name === 'AbortError') continue;
      const signalAborted = (err as any)?.code === 'UND_ERR_ABORTED';
      if (signalAborted) continue;
      return Promise.reject(err);
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError !== null) return Promise.reject(lastError as Error);
  if (lastHttpStatus !== null) return Promise.reject(new Error(`probe target answered HTTP ${lastHttpStatus}`));
  throw new Error('all probe targets failed');
}

function handleProxiesDown(rows: ProxyRow[], deadId: number): void {
  const now = Date.now();
  for (const [platform, assignment] of assignments) {
    if (assignment.proxyId !== deadId) continue;
    const sorted = candidateProxies().filter(p => p.id !== deadId && p.status === 'healthy');
    if (sorted.length > 0) {
      const next = sorted[0];
      pushHistory(platform, deadId, now);
      assignments.set(platform, { proxyId: next.id, sinceMs: now });
      pushActivity({ ts: now, kind: 'rotated', platform, proxyId: next.id, proxyLabel: next.label || `${next.type}://${next.host}:${next.port}`, latencyMs: proxyDisplayLatencyMs(next) });
    } else {
      assignments.delete(platform);
      pushHistory(platform, deadId, now);
      pushActivity({ ts: now, kind: 'proxy_down', platform, proxyId: deadId, proxyLabel: labelOf(deadId), latencyMs: null });
    }
  }
}

let checkAllInFlight: Promise<ProxyProbeResult[]> | null = null;

export function isCheckAllInFlight(): boolean {
  return checkAllInFlight !== null;
}

export function checkAllProxies(opts: { force?: boolean } = {}): Promise<ProxyProbeResult[]> {
  if (checkAllInFlight) return checkAllInFlight;
  checkAllInFlight = (async () => {
    const rows = listProxies();
    const results: ProxyProbeResult[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, rows.length) }, async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++]!;
        results.push(await probeRow(row));
      }
    });
    await Promise.all(workers);
    return results;
  })().finally(() => {
    checkAllInFlight = null;
  });
  return checkAllInFlight;
}

export interface ProxyHistoryEntry {
  proxyId: number;
  label: string;
  sinceMs: number;
  untilMs: number | null;
}

export interface ProxyAssignmentView {
  platform: string;
  proxy: ProxyRow | null;
  sinceMs: number;
  history: ProxyHistoryEntry[];
}

export function getProxyActivity(): {
  assignments: ProxyAssignmentView[];
  events: ActivityEvent[];
} {
  const views: ProxyAssignmentView[] = [];
  for (const [platform, assignment] of assignments) {
    const list = history.get(platform) ?? [];
    views.push({
      platform,
      proxy: getProxy(assignment.proxyId) ?? null,
      sinceMs: assignment.sinceMs,
      history: list.map(entry => ({
        proxyId: entry.proxyId,
        label: labelOf(entry.proxyId),
        sinceMs: entry.sinceMs,
        untilMs: entry.untilMs,
      })),
    });
  }
  return {
    assignments: views.sort((a, b) => a.platform.localeCompare(b.platform)),
    events: [...activity].slice(-ACTIVITY_LIMIT).reverse(),
  };
}

export function startProxyChecker(scheduler: Scheduler): () => void {
  console.log(`[ProxyPool] Starting proxy health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);
  return scheduler.every(CHECK_INTERVAL_MS, () => {
    void checkAllProxies().catch(err => {
      console.error('[ProxyPool] Scheduled proxy check failed:', err);
    });
  }, { name: 'proxy-pool-check' });
}

let initialized = false;

const TRANSPORT_FAILURE_RE = /proxy connection timed out|socket closed|fetch failed|econn(refused|reset|aborted)|etimedout|enotfound|other side closed|socket hang up|dispatcher could not be built/i;

function disableProxyRow(row: ProxyRow, reason: string, event: string): void {
  const db = getDb();
  db.prepare("UPDATE proxies SET enabled = 0, last_error = ?, updated_at = datetime('now') WHERE id = ?")
    .run(reason, row.id);
  proxyRlStreaks.delete(row.id);
  dropAssignmentsFor(row.id, 'released');
  providerLog(
    `Proxy ${row.label || `${row.host}:${row.port}`} disabled: ${reason}`,
    { level: 'warn', provider: 'proxy-pool', event },
  );
}

export function disablePoolProxy(id: number, reason: string, event = 'proxy_disabled'): void {
  const row = getProxy(id);
  if (!row || row.enabled !== 1) return;
  disableProxyRow(row, reason, event);
}

function reportTransportFailure(proxyUrl: string, message: string): void {
  if (!TRANSPORT_FAILURE_RE.test(message)) return;
  try {
    const withoutCreds = proxyUrl.replace(/\/\/[^@/]*@/, '//');
    const row = listProxies().find(p => proxyUrlMatches(buildProxyUrl(p), withoutCreds));
    if (!row || row.enabled !== 1) {
      if (row) proxyRlStreaks.delete(row.id);
      return;
    }
    recordProxyOutcome(row.id, false);
    disableProxyRow(row, `Disabled after a live transport failure: ${message.slice(0, 160)}`, 'proxy_transport_disabled');
  } catch (err: any) {
    console.warn(`[ProxyPool] transport-failure bookkeeping failed: ${err?.message ?? err}`);
  }
}

function proxyUrlMatches(a: string, b: string): boolean {
  const strip = (url: string) => url.replace(/\/\/[^@/]*@/, '//').toLowerCase();
  return strip(a) === strip(b);
}

const proxyRlStreaks = new Map<number, number>();

export function getProxyRateLimitStreak(id: number): number {
  return proxyRlStreaks.get(id) ?? 0;
}

function reportProxyRateLimited(proxyUrl: string): void {
  try {
    const withoutCreds = proxyUrl.replace(/\/\/[^@/]*@/, '//');
    const row = listProxies().find(p => proxyUrlMatches(buildProxyUrl(p), withoutCreds));
    if (!row || row.enabled !== 1) {
      if (row) proxyRlStreaks.delete(row.id);
      return;
    }
    recordProxyOutcome(row.id, false);
    const streak = (proxyRlStreaks.get(row.id) ?? 0) + 1;
    proxyRlStreaks.set(row.id, streak);
    const limit = getProxyRateLimitDisableCount();
    if (streak < limit) return;
    disableProxyRow(row, `Disabled after ${streak} consecutive upstream 429s over this proxy`, 'proxy_rate_limit_disabled');
  } catch (err: any) {
    console.warn(`[ProxyPool] rate-limit bookkeeping failed: ${err?.message ?? err}`);
  }
}

function reportLiveSuccess(proxyUrl: string, latencyMs: number): void {
  try {
    const withoutCreds = proxyUrl.replace(/\/\/[^@/]*@/, '//');
    const row = listProxies().find(p => proxyUrlMatches(buildProxyUrl(p), withoutCreds));
    if (!row) return;
    proxyRlStreaks.delete(row.id);
    recordProxyOutcome(row.id, true, latencyMs);
  } catch (err: any) {
    console.warn(`[ProxyPool] live-success bookkeeping failed: ${err?.message ?? err}`);
  }
}

export function initProxyPool(): void {
  if (initialized) return;
  initialized = true;
  for (const row of listProxies()) {
    if (row.enabled !== 1) continue;
    providerLog(`Proxy loaded: ${row.label || `${row.type}://${maskAddress(row)}`} (${row.type})`, { level: 'info', provider: 'proxy-pool', event: 'proxy_loaded' });
  }
  setPlatformProxyResolver(resolveProxyForPlatform);
  setProxyTransportFailureReporter(reportTransportFailure);
  setProxySuccessReporter(reportLiveSuccess);
  setProxyRateLimitReporter(reportProxyRateLimited);
}

function maskAddress(row: ProxyRow): string {
  return `${row.host}:${row.port}`;
}