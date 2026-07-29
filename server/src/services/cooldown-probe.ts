import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { isTransportError } from '../lib/process-safety-net.js';
import { resolveProvider } from '../providers/index.js';
import type { BaseProvider } from '../providers/base.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { providerLog } from '../lib/server-logs.js';
import { clearPersistedCooldown, setCooldown } from './ratelimit.js';
import type { Scheduler } from '../lib/scheduler.js';
import { getProbeableCooldowns, clearCooldownEarly, type ProbeableCooldown } from './ratelimit.js';
import { probeKeyValidity, type KeyProbeOutcome } from './health.js';


export interface ProbeTarget {
  platform: string;
  modelId: string;
  keyId: number;
}

export interface ProbeOutcome {
  target: ProbeTarget;
  available: boolean;
  reason?: string;
}

export interface ActiveCooldown {
  platform: string;
  modelId: string;
  keyId: number;
  expiresAtMs: number;
  remainingSeconds: number;
  reason: string | null;
}

interface ApiKeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  base_url: string | null;
}

interface DecryptedTarget {
  provider: BaseProvider;
  apiKey: string;
  platform: Platform;
  quotaPoolKey: string;
}

const PROBE_THROTTLE_MS = 5_000;
const probeLastAt = new Map<string, number>();
const probeInflight = new Map<string, Promise<ProbeOutcome | null>>();

function targetKey(t: ProbeTarget): string {
  return `${t.platform}:${t.modelId}:${t.keyId}`;
}

function shouldThrottle(t: ProbeTarget, now = Date.now()): boolean {
  const last = probeLastAt.get(targetKey(t)) ?? 0;
  return now - last < PROBE_THROTTLE_MS;
}

function markProbed(t: ProbeTarget, now = Date.now()): void {
  probeLastAt.set(targetKey(t), now);
}

function loadTargets(targets: ProbeTarget[]): Map<string, DecryptedTarget> {
  const out = new Map<string, DecryptedTarget>();
  if (targets.length === 0) return out;
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return out;
  }
  const rows = db.prepare(`
    SELECT id, platform, encrypted_key, iv, auth_tag, status, enabled, base_url
      FROM api_keys
     WHERE id IN (${targets.map(() => '?').join(',')})
  `).all(...targets.map(t => t.keyId)) as ApiKeyRow[];
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const t of targets) {
    const row = byId.get(t.keyId);
    if (!row) continue;
    if (row.enabled !== 1) continue;
    let apiKey: string;
    try {
      apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    } catch {
      continue;
    }
    const provider = resolveProvider(row.platform as Platform, row.base_url);
    if (!provider) continue;
    out.set(targetKey(t), {
      provider,
      apiKey,
      platform: row.platform as Platform,
      quotaPoolKey: `${row.platform}::${t.modelId}`,
    });
  }
  return out;
}

async function probeKeyModel(
  target: ProbeTarget,
  loaded: DecryptedTarget,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  try {
    const result = await loaded.provider.chatCompletion(
      loaded.apiKey,
      [{ role: 'user', content: 'ping' }],
      target.modelId,
      { max_tokens: 1, temperature: 0, timeoutMs },
      {
        platform: loaded.platform,
        keyId: target.keyId,
        quotaPoolKey: loaded.quotaPoolKey,
        endpoint: 'probe',
        origin: 'probe',
      },
    );
    if (result && Array.isArray(result.choices) && result.choices.length > 0) {
      return { target, available: true };
    }
    return { target, available: false, reason: 'empty_response' };
  } catch (err: any) {
    const status = err?.status as number | undefined;
    let reason = 'transport_error';
    if (status === 429) reason = 'rate_limited';
    else if (status === 402) reason = 'payment_required';
    else if (status === 401 || status === 403) reason = 'forbidden';
    else if (status === 404) reason = 'model_not_found';
    else if (err?.name === 'AbortError') reason = 'probe_timeout';
    else if (isTransportError(err)) reason = 'probe_timeout';
    return { target, available: false, reason };
  }
}

function raceFirstAvailable(
  probes: Array<{ target: ProbeTarget; promise: Promise<ProbeOutcome> }>,
  deadlineMs: number,
): Promise<ProbeOutcome | null> {
  return new Promise<ProbeOutcome | null>(resolve => {
    if (probes.length === 0) {
      resolve(null);
      return;
    }
    let settled = false;
    let pending = probes.length;
    const overallTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, deadlineMs);

    const finalise = (outcome: ProbeOutcome | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimeout);
      resolve(outcome);
    };

    for (const { promise } of probes) {
      promise
        .then(outcome => {
          if (settled) return;
          if (outcome.available) {
            finalise(outcome);
            return;
          }
          pending -= 1;
          if (pending === 0) finalise(null);
        })
        .catch(() => {
          if (settled) return;
          pending -= 1;
          if (pending === 0) finalise(null);
        });
    }
  });
}

export async function probeCooldownKeys(
  targets: ProbeTarget[],
  deadlineMs = 5000,
): Promise<ProbeOutcome | null> {
  if (targets.length === 0) return null;

  const now = Date.now();
  const live: ProbeTarget[] = [];
  const skipped: ProbeTarget[] = [];
  for (const t of targets) {
    if (shouldThrottle(t, now)) {
      skipped.push(t);
      continue;
    }
    live.push(t);
  }
  if (live.length === 0) return null;

  const loaded = loadTargets(live);
  if (loaded.size === 0) return null;

  const perTargetTimeout = Math.max(500, Math.floor(deadlineMs * 0.9));
  const probes: Array<{ target: ProbeTarget; promise: Promise<ProbeOutcome> }> = [];
  const inflightKeys: string[] = [];

  for (const t of live) {
    const k = targetKey(t);
    const existing = probeInflight.get(k);
    if (existing) {
      probes.push({
        target: t,
        promise: existing.then(o => o ?? { target: t, available: false, reason: 'no_inflight_result' }),
      });
      continue;
    }
    const entry = loaded.get(k);
    if (!entry) {
      probes.push({
        target: t,
        promise: Promise.resolve({ target: t, available: false, reason: 'unavailable' }),
      });
      continue;
    }
    markProbed(t, now);
    recordProbeAttempt(t.platform, t.modelId, t.keyId, now);
    const p = probeKeyModel(t, entry, perTargetTimeout).finally(() => {
      probeInflight.delete(k);
    });
    probeInflight.set(k, p.then(o => (o.available ? o : null)));
    inflightKeys.push(k);
    probes.push({ target: t, promise: p });
  }

  for (const { promise } of probes) {
    promise.then(outcome => {
      if (outcome.available) {
        clearPersistedCooldown(outcome.target.platform, outcome.target.modelId, outcome.target.keyId);
      }
    });
  }

  const winner = await raceFirstAvailable(probes, deadlineMs);
  return winner;
}

export function getActiveCooldowns(now = Date.now()): ActiveCooldown[] {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return [];
  }
  try {
    const rows = db.prepare(`
      SELECT platform, model_id AS modelId, key_id AS keyId, expires_at_ms AS expiresAtMs, reason
        FROM rate_limit_cooldowns
       WHERE expires_at_ms > ?
       ORDER BY expires_at_ms ASC
    `).all(now) as { platform: string; modelId: string; keyId: number; expiresAtMs: number; reason: string | null }[];

    return rows.map(r => ({
      platform: r.platform,
      modelId: r.modelId,
      keyId: r.keyId,
      expiresAtMs: r.expiresAtMs,
      remainingSeconds: Math.max(0, Math.ceil((r.expiresAtMs - now) / 1000)),
      reason: r.reason ?? null,
    }));
  } catch {
    const rows = db.prepare(`
      SELECT platform, model_id AS modelId, key_id AS keyId, expires_at_ms AS expiresAtMs
        FROM rate_limit_cooldowns
       WHERE expires_at_ms > ?
       ORDER BY expires_at_ms ASC
    `).all(now) as { platform: string; modelId: string; keyId: number; expiresAtMs: number }[];

    return rows.map(r => ({
      platform: r.platform,
      modelId: r.modelId,
      keyId: r.keyId,
      expiresAtMs: r.expiresAtMs,
      remainingSeconds: Math.max(0, Math.ceil((r.expiresAtMs - now) / 1000)),
      reason: null,
    }));
  }
}

export function recordProbeAttempt(platform: string, modelId: string, keyId: number, now = Date.now()): void {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return;
  }
  try {
    db.prepare(`
      UPDATE rate_limit_cooldowns SET last_probe_at_ms = ?
       WHERE platform = ? AND model_id = ? AND key_id = ?
    `).run(now, platform, modelId, keyId);
  } catch {}
}

export interface ProbeAllSummary {
  probed: number;
  recovered: ProbeOutcome[];
  newlyCooled: ProbeOutcome[];
  stillCooled: number;
  timedOut: boolean;
}

export async function probeAllActiveCooldowns(
  deadlineMs = 12000,
): Promise<ProbeAllSummary> {
  const targets = listAllProbeTargets();
  if (targets.length === 0) {
    return { probed: 0, recovered: [], newlyCooled: [], stillCooled: 0, timedOut: false };
  }
  const loaded = loadTargets(targets);
  const probes: Promise<ProbeOutcome>[] = targets.map(t => {
    const entry = loaded.get(targetKey(t));
    if (!entry) {
      return Promise.resolve({ target: t, available: false, reason: 'unavailable' } as ProbeOutcome);
    }
    const perTargetTimeout = Math.max(1000, Math.floor(deadlineMs * 0.9));
    recordProbeAttempt(t.platform, t.modelId, t.keyId);
    return probeKeyModel(t, entry, perTargetTimeout);
  });

  let timedOut = false;
  const settled = await Promise.race([
    Promise.all(probes).then(results => ({ done: true as const, results })),
    new Promise<{ done: false }>(resolve => setTimeout(() => {
      timedOut = true;
      resolve({ done: false });
    }, deadlineMs)),
  ]);

  if (!settled.done) {
    return { probed: targets.length, recovered: [], newlyCooled: [], stillCooled: 0, timedOut: true };
  }

  const recovered: ProbeOutcome[] = [];
  const newlyCooled: ProbeOutcome[] = [];
  let stillCooled = 0;
  for (const r of settled.results) {
    if (r.available) {
      clearPersistedCooldown(r.target.platform, r.target.modelId, r.target.keyId);
      recovered.push(r);
    } else {
      const reason = r.reason ?? 'probe_failed';
      const duration = reasonToCooldownMs(reason);
      if (duration > 0) {
        setCooldown(r.target.platform, r.target.modelId, r.target.keyId, duration, 'heuristic', reason);
        newlyCooled.push(r);
      } else {
        stillCooled += 1;
      }
    }
  }
  return { probed: targets.length, recovered, newlyCooled, stillCooled, timedOut: false };
}

function listAllProbeTargets(): ProbeTarget[] {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return [];
  }
  try {
    const now = Date.now();
    const rows = db.prepare(`
      SELECT c.platform AS platform, c.model_id AS modelId, c.key_id AS keyId
        FROM rate_limit_cooldowns c
        JOIN api_keys k
          ON k.id = c.key_id
         AND k.platform = c.platform
        JOIN models m
          ON m.platform = c.platform
         AND m.model_id = c.model_id
         AND m.enabled = 1
         AND (m.key_id = c.key_id OR m.key_id IS NULL)
       WHERE c.expires_at_ms > ?
         AND k.enabled = 1
    `).all(now) as Array<{ platform: string; modelId: string; keyId: number }>;
    const seen = new Set<string>();
    const out: ProbeTarget[] = [];
    for (const r of rows) {
      const k = `${r.platform}:${r.modelId}:${r.keyId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ platform: r.platform, modelId: r.modelId, keyId: r.keyId });
    }
    return out;
  } catch {
    return [];
  }
}

function reasonToCooldownMs(reason: string): number {
  switch (reason) {
    case 'rate_limited':
      return 2 * 60_000;
    case 'payment_required':
      return 24 * 60 * 60_000;
    case 'forbidden':
      return 30 * 60_000;
    case 'model_not_found':
      return 30 * 60_000;
    case 'probe_timeout':
      return 0;
    case 'empty_response':
      return 60_000;
    case 'transport_error':
      return 30_000;
    default:
      return 60_000;
  }
}

export { setCooldown };





// How often the scanner wakes up to look at the cooldown table. Scanning is one
// cheap indexed SELECT; actual probes are gated far harder below.
const SCAN_INTERVAL_MS = 60 * 1000;

// A cooldown only becomes probe-ripe after this fraction of its bench has been
// served. Probing a seconds-old cooldown would mostly re-confirm the failure
// that caused it; by half-time a transient condition has had a real chance to
// clear, and long escalated benches still recover hours early.
const MIN_ELAPSED_FRACTION = 0.5;

// Not worth probing a cooldown that is about to expire on its own — the probe
// would cost a validate call to save less than a scan interval of idle time.
const MIN_REMAINING_MS = 60 * 1000;

// Failed-probe backoff per key: 2m, 4m, 8m, capped at 15m. Keys that stay bad
// converge to one validate call per 15 minutes — a third of what the 5-minute
// health pass already sends them.
const PROBE_BACKOFF_BASE_MS = 2 * 60 * 1000;
const PROBE_BACKOFF_MAX_MS = 15 * 60 * 1000;

// Stagger window for a key's FIRST probe after it is sighted (covers the
// restart case, where every persisted cooldown is sighted at once).
const FIRST_PROBE_STAGGER_MS = 45 * 1000;

const DEFAULT_MAX_PROBES_PER_PASS = 3;

/** Per-pass probe budget. Tunable for large key fleets; 0 or a bad value falls
 *  back to the default (mirrors HEALTH_CHECK_CONCURRENCY). */
function getMaxProbesPerPass(): number {
  const raw = process.env.COOLDOWN_PROBE_MAX_PER_PASS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_MAX_PROBES_PER_PASS;
}

interface KeyProbeState {
  failures: number;
  nextProbeAtMs: number;
}

// keyId -> probe pacing. In-memory only, like the escalation ladder: a restart
// forgetting the backoff is fine because first-sighting staggering re-spaces
// the probes anyway.
const keyState = new Map<number, KeyProbeState>();

export interface ProbePassOptions {
  now?: number;
  // Test seams: injectable probe + RNG so unit tests need no network or timers.
  probe?: (keyId: number) => Promise<KeyProbeOutcome>;
  jitter?: () => number; // [0, 1), defaults to Math.random
  maxProbes?: number;
}

export interface ProbePassResult {
  probedKeyIds: number[];
  clearedCooldowns: number;
}

/** True when this cooldown has served enough of its bench to be worth probing. */
function isRipe(cooldown: ProbeableCooldown, now: number): boolean {
  if (cooldown.expiresAtMs - now < MIN_REMAINING_MS) return false;
  // Rows persisted before the provenance migration have no start time; treat
  // them as old enough rather than never probing them.
  if (cooldown.setAtMs == null) return true;
  const duration = cooldown.expiresAtMs - cooldown.setAtMs;
  return now - cooldown.setAtMs >= duration * MIN_ELAPSED_FRACTION;
}

/**
 * One probe pass: find ripe heuristic cooldowns, probe up to maxProbes of their
 * keys (respecting per-key backoff), and clear every heuristic cooldown on a
 * key whose probe passed. Exported for tests; production runs it on the
 * scheduler via startCooldownProbe.
 */
export async function runCooldownProbePass(opts: ProbePassOptions = {}): Promise<ProbePassResult> {
  const now = opts.now ?? Date.now();
  const probe = opts.probe ?? probeKeyValidity;
  const jitter = opts.jitter ?? Math.random;
  const maxProbes = opts.maxProbes ?? getMaxProbesPerPass();

  const all = getProbeableCooldowns(now);

  // Drop pacing state for keys with no probeable cooldowns left (expired,
  // cleared, or re-benched as authoritative) so old backoff cannot delay a
  // future, unrelated bench.
  const keysWithCooldowns = new Set(all.map(c => c.keyId));
  for (const keyId of [...keyState.keys()]) {
    if (!keysWithCooldowns.has(keyId)) keyState.delete(keyId);
  }

  const ripeByKey = new Map<number, ProbeableCooldown[]>();
  for (const cooldown of all) {
    if (!isRipe(cooldown, now)) continue;
    const list = ripeByKey.get(cooldown.keyId) ?? [];
    list.push(cooldown);
    ripeByKey.set(cooldown.keyId, list);
  }

  const probedKeyIds: number[] = [];
  let clearedCooldowns = 0;

  for (const [keyId, cooldownsForKey] of ripeByKey) {
    if (probedKeyIds.length >= maxProbes) break;

    let state = keyState.get(keyId);
    if (!state) {
      // First sighting: schedule, don't probe. This is the restart stagger —
      // a boot with dozens of persisted cooldowns spreads its first probes
      // across the jitter window instead of validating everything at once.
      state = { failures: 0, nextProbeAtMs: now + Math.floor(jitter() * FIRST_PROBE_STAGGER_MS) };
      keyState.set(keyId, state);
      continue;
    }
    if (now < state.nextProbeAtMs) continue;

    probedKeyIds.push(keyId);
    const outcome = await probe(keyId);

    if (outcome === 'valid') {
      for (const cooldown of cooldownsForKey) {
        clearCooldownEarly(cooldown.platform, cooldown.modelId, cooldown.keyId);
        clearedCooldowns++;
      }
      keyState.delete(keyId);
      console.log(
        `[CooldownProbe] key ${keyId} validated — cleared ${cooldownsForKey.length} cooldown(s) early ` +
        `(${cooldownsForKey.map(c => `${c.platform}/${c.modelId}`).join(', ')})`,
      );
    } else {
      // Failed or inconclusive: the bench stays EXACTLY as it was — a probe
      // must never extend a cooldown — and this key backs off before the next
      // attempt so probes cannot burn quota against a provider that is down.
      state.failures++;
      const backoff = Math.min(PROBE_BACKOFF_BASE_MS * 2 ** (state.failures - 1), PROBE_BACKOFF_MAX_MS);
      state.nextProbeAtMs = now + backoff;
    }
  }

  return { probedKeyIds, clearedCooldowns };
}

// Overlap guard, same shape as checkAllKeys: a slow provider validate must not
// let the next scheduled pass stack a second set of probes on top.
let passInFlight: Promise<ProbePassResult> | null = null;

function runGuardedPass(): Promise<ProbePassResult> {
  if (passInFlight) return passInFlight;
  passInFlight = runCooldownProbePass().finally(() => {
    passInFlight = null;
  });
  return passInFlight;
}

let cancelProbeJob: (() => void) | null = null;

export function startCooldownProbe(scheduler: Scheduler): void {
  if (cancelProbeJob) return;
  if (process.env.COOLDOWN_PROBE_DISABLED === '1') {
    console.log('[CooldownProbe] disabled via COOLDOWN_PROBE_DISABLED=1');
    return;
  }
  console.log(`[CooldownProbe] starting cooldown-probe recovery (scan every ${SCAN_INTERVAL_MS / 1000}s)`);
  cancelProbeJob = scheduler.every(
    SCAN_INTERVAL_MS,
    async () => {
      await runGuardedPass().catch(err => console.error('[CooldownProbe] pass failed:', err));
    },
    { name: 'cooldown-probe' },
  );
}

export function stopCooldownProbe(): void {
  if (cancelProbeJob) {
    cancelProbeJob();
    cancelProbeJob = null;
  }
}

/** Test seam: drop all per-key probe pacing state. */
export function resetCooldownProbeState(): void {
  keyState.clear();
}

