import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { isTransportError } from '../lib/process-safety-net.js';
import { resolveProvider } from '../providers/index.js';
import type { BaseProvider } from '../providers/base.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { providerLog } from '../lib/server-logs.js';
import { clearPersistedCooldown, setCooldown } from './ratelimit.js';

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
        setCooldown(r.target.platform, r.target.modelId, r.target.keyId, duration, reason);
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