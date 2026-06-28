import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { proxyFetch } from '../lib/proxy.js';
import { recordQuotaObservation, inferQuotaPoolKey } from './provider-quota.js';
import { providerLog } from '../lib/server-logs.js';
import type { Platform } from '@freellmapi/shared/types.js';
import type { Scheduler } from '../lib/scheduler.js';

const PROBE_INTERVAL_MS = 30 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

async function fetchWithTimeout(url: string, init: RequestInit, platform: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await proxyFetch(url, { ...init, signal: controller.signal }, platform);
  } finally {
    clearTimeout(timer);
  }
}

function getKeysForPlatform(platform: Platform): KeyRow[] {
  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }
  return db.prepare(
    'SELECT id, platform, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1',
  ).all(platform) as KeyRow[];
}

async function probeOpenRouter(key: KeyRow): Promise<void> {
  const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
  const poolKey = inferQuotaPoolKey('openrouter');

  try {
    const res = await fetchWithTimeout('https://openrouter.ai/api/v1/auth/key', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 'openrouter');

    if (!res.ok) return;

    const body = await res.json() as {
      data?: {
        label?: string;
        usage?: number;
        limit?: number | null;
        is_free_tier?: boolean;
        rate_limit?: { requests?: number; interval?: string } | null;
      };
    };

    const data = body.data;
    if (!data) return;

    const quotaPoolKey = data.is_free_tier ? 'openrouter::free' : poolKey;

    if (data.limit != null) {
      recordQuotaObservation({
        platform: 'openrouter',
        keyId: key.id,
        quotaPoolKey,
        metric: 'credits',
        limit: data.limit,
        remaining: data.limit - (data.usage ?? 0),
        resetStrategy: 'rolling_window',
        source: 'quota_api',
        endpoint: 'auth/key',
        confidence: 1,
        notes: data.is_free_tier ? 'free tier' : 'paid tier',
        rawJson: JSON.stringify(data),
      });
    }

    if (data.rate_limit?.requests != null) {
      recordQuotaObservation({
        platform: 'openrouter',
        keyId: key.id,
        quotaPoolKey,
        metric: 'requests',
        limit: data.rate_limit.requests,
        remaining: null,
        resetStrategy: 'provider_reported',
        source: 'quota_api',
        endpoint: 'auth/key',
        confidence: 1,
        notes: `interval=${data.rate_limit.interval ?? 'unknown'}`,
        rawJson: JSON.stringify(data.rate_limit),
      });
    }

    providerLog(`Quota probe: openrouter key ${key.id} — usage=${data.usage ?? 0}/${data.limit ?? 'unlimited'}`, { level: 'info', provider: 'openrouter', event: 'quota_probe' });
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    providerLog(`Quota probe failed: openrouter key ${key.id}: ${err?.message}`, { level: 'warn', provider: 'openrouter', event: 'quota_probe_error' });
  }
}

async function probeGitHub(key: KeyRow): Promise<void> {
  const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
  const poolKey = inferQuotaPoolKey('github');

  try {
    const userRes = await fetchWithTimeout('https://api.github.com/user', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/vnd.github+json',
      },
    }, 'github');

    if (!userRes.ok) return;

    const userBody = await userRes.json() as { login?: string };
    const username = userBody.login;
    if (!username) return;

    const usageRes = await fetchWithTimeout(
      `https://api.github.com/users/${encodeURIComponent(username)}/settings/billing/ai_credit/usage`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/vnd.github+json',
        },
      },
      'github',
    );

    if (!usageRes.ok) return;

    const usageBody = await usageRes.json() as {
      total_credits_used?: number;
      total_paid_credits_used?: number;
      current_date?: string;
    };

    const totalUsed = usageBody.total_credits_used ?? 0;
    const paidUsed = usageBody.total_paid_credits_used ?? 0;
    const freeUsed = totalUsed - paidUsed;

    recordQuotaObservation({
      platform: 'github',
      keyId: key.id,
      quotaPoolKey: poolKey,
      metric: 'credits',
      limit: null,
      remaining: null,
      resetStrategy: 'fixed_calendar',
      source: 'quota_api',
      endpoint: 'billing/ai_credit/usage',
      confidence: 0.9,
      notes: `user=${username}, total_used=${totalUsed}, paid_used=${paidUsed}, free_used=${freeUsed}, date=${usageBody.current_date ?? 'unknown'}`,
      rawJson: JSON.stringify(usageBody),
      providerAccountId: username,
    });

    providerLog(`Quota probe: github key ${key.id} — user=${username}, total_credits_used=${totalUsed}`, { level: 'info', provider: 'github', event: 'quota_probe' });
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    providerLog(`Quota probe failed: github key ${key.id}: ${err?.message}`, { level: 'warn', provider: 'github', event: 'quota_probe_error' });
  }
}

async function probePollinations(key: KeyRow): Promise<void> {
  const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
  const poolKey = inferQuotaPoolKey('pollinations');

  try {
    const res = await fetchWithTimeout('https://gen.pollinations.ai/account/balance', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 'pollinations');

    if (!res.ok) return;

    const body = await res.json() as {
      balance?: number;
      tier_balance?: number;
      paid_balance?: number;
    };

    if (typeof body.balance !== 'number') return;

    recordQuotaObservation({
      platform: 'pollinations',
      keyId: key.id,
      quotaPoolKey: poolKey,
      metric: 'credits',
      limit: null,
      remaining: body.balance,
      resetStrategy: 'rolling_window',
      source: 'quota_api',
      endpoint: 'account/balance',
      confidence: 1,
      notes: `pollen_balance=${body.balance}, tier=${body.tier_balance ?? 'n/a'}, paid=${body.paid_balance ?? 'n/a'}`,
      rawJson: JSON.stringify(body),
    });

    providerLog(`Quota probe: pollinations key ${key.id} — pollen_balance=${body.balance}`, { level: 'info', provider: 'pollinations', event: 'quota_probe' });
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    providerLog(`Quota probe failed: pollinations key ${key.id}: ${err?.message}`, { level: 'warn', provider: 'pollinations', event: 'quota_probe_error' });
  }
}

async function probeRouteway(key: KeyRow): Promise<void> {
  const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
  const poolKey = inferQuotaPoolKey('routeway');

  try {
    const res = await fetchWithTimeout('https://api.routeway.ai/v1/account/balance', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 'routeway');

    if (!res.ok) return;

    const body = await res.json() as { balance?: number };

    if (typeof body.balance !== 'number') return;

    recordQuotaObservation({
      platform: 'routeway',
      keyId: key.id,
      quotaPoolKey: poolKey,
      metric: 'credits',
      limit: null,
      remaining: body.balance,
      resetStrategy: 'rolling_window',
      source: 'quota_api',
      endpoint: 'account/balance',
      confidence: 1,
      notes: `usd_balance=${body.balance}`,
      rawJson: JSON.stringify(body),
    });

    providerLog(`Quota probe: routeway key ${key.id} — usd_balance=${body.balance}`, { level: 'info', provider: 'routeway', event: 'quota_probe' });
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    providerLog(`Quota probe failed: routeway key ${key.id}: ${err?.message}`, { level: 'warn', provider: 'routeway', event: 'quota_probe_error' });
  }
}

async function probeBazaarLink(key: KeyRow): Promise<void> {
  const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
  const poolKey = inferQuotaPoolKey('bazaarlink');

  try {
    const res = await fetchWithTimeout('https://bazaarlink.ai/api/v1/key', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 'bazaarlink');

    if (!res.ok) return;

    const body = await res.json() as {
      status?: string;
      credits?: number;
      points_balance?: number;
    };

    if (body.status && typeof body.credits === 'number') {
      recordQuotaObservation({
        platform: 'bazaarlink',
        keyId: key.id,
        quotaPoolKey: poolKey,
        metric: 'credits',
        limit: null,
        remaining: body.credits,
        resetStrategy: 'rolling_window',
        source: 'quota_api',
        endpoint: 'key',
        confidence: 1,
        notes: `status=${body.status}, credits=${body.credits}, points=${body.points_balance ?? 'n/a'}`,
        rawJson: JSON.stringify(body),
      });

      providerLog(`Quota probe: bazaarlink key ${key.id} — status=${body.status}, credits=${body.credits}`, { level: 'info', provider: 'bazaarlink', event: 'quota_probe' });
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    providerLog(`Quota probe failed: bazaarlink key ${key.id}: ${err?.message}`, { level: 'warn', provider: 'bazaarlink', event: 'quota_probe_error' });
  }
}

async function probeAINative(key: KeyRow): Promise<void> {
  const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
  const poolKey = inferQuotaPoolKey('ainative');

  try {
    const res = await fetchWithTimeout('https://api.ainative.studio/api/v1/credits/balance', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 'ainative');

    if (!res.ok) return;

    const body = await res.json() as {
      total_credits?: number;
      used_credits?: number;
      remaining_credits?: number;
      plan?: string;
      period_start?: string;
      period_end?: string;
      usage_percentage?: number;
    };

    if (typeof body.remaining_credits !== 'number') return;

    recordQuotaObservation({
      platform: 'ainative',
      keyId: key.id,
      quotaPoolKey: poolKey,
      metric: 'credits',
      limit: body.total_credits ?? null,
      remaining: body.remaining_credits,
      resetStrategy: 'fixed_calendar',
      source: 'quota_api',
      endpoint: 'credits/balance',
      confidence: 1,
      notes: `plan=${body.plan ?? 'unknown'}, used=${body.used_credits ?? 0}/${body.total_credits ?? '?'}, pct=${body.usage_percentage ?? 0}%, period=${body.period_start ?? '?'}..${body.period_end ?? '?'}`,
      rawJson: JSON.stringify(body),
    });

    providerLog(`Quota probe: ainative key ${key.id} — remaining=${body.remaining_credits}/${body.total_credits ?? '?'} (${body.plan ?? '?'})`, { level: 'info', provider: 'ainative', event: 'quota_probe' });
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    providerLog(`Quota probe failed: ainative key ${key.id}: ${err?.message}`, { level: 'warn', provider: 'ainative', event: 'quota_probe_error' });
  }
}

async function probeAIHorde(key: KeyRow): Promise<void> {
  let apiKey = '0000000000';
  if (key.encrypted_key) {
    try {
      apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
    } catch {
      apiKey = '0000000000';
    }
  }
  const poolKey = inferQuotaPoolKey('aihorde');

  try {
    const res = await fetchWithTimeout('https://aihorde.net/api/v2/find_user', {
      method: 'GET',
      headers: { 'apikey': apiKey },
    }, 'aihorde');

    if (!res.ok) return;

    const body = await res.json() as {
      username?: string;
      kudos?: number;
      concurrency?: number;
      trusted?: boolean;
    };

    if (typeof body.kudos !== 'number') return;

    recordQuotaObservation({
      platform: 'aihorde',
      keyId: key.id,
      quotaPoolKey: poolKey,
      metric: 'credits',
      limit: null,
      remaining: body.kudos,
      resetStrategy: 'rolling_window',
      source: 'quota_api',
      endpoint: 'find_user',
      confidence: 0.8,
      notes: `username=${body.username ?? 'anonymous'}, kudos=${body.kudos}, concurrency=${body.concurrency ?? 0}, trusted=${body.trusted ?? false}`,
      rawJson: JSON.stringify(body),
      providerAccountId: body.username ?? null,
    });

    providerLog(`Quota probe: aihorde key ${key.id} — user=${body.username ?? 'anonymous'}, kudos=${body.kudos}`, { level: 'info', provider: 'aihorde', event: 'quota_probe' });
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    providerLog(`Quota probe failed: aihorde key ${key.id}: ${err?.message}`, { level: 'warn', provider: 'aihorde', event: 'quota_probe_error' });
  }
}

const PROBE_BY_PLATFORM: Record<string, (key: KeyRow) => Promise<void>> = {
  openrouter: probeOpenRouter,
  github: probeGitHub,
  pollinations: probePollinations,
  routeway: probeRouteway,
  bazaarlink: probeBazaarLink,
  ainative: probeAINative,
  aihorde: probeAIHorde,
};

async function probeAllKeys(): Promise<void> {
  for (const platform of Object.keys(PROBE_BY_PLATFORM)) {
    const keys = getKeysForPlatform(platform as Platform);
    if (keys.length === 0) continue;

    for (const key of keys) {
      await PROBE_BY_PLATFORM[platform]!(key);
    }
  }
}

let cancelProbe: (() => void) | null = null;

export function startQuotaProbe(scheduler: Scheduler): void {
  if (cancelProbe) return;
  console.log(`[QuotaProbe] Starting quota probe (every ${PROBE_INTERVAL_MS / 1000}s)`);
  probeAllKeys().catch(err => console.error('[QuotaProbe] Initial probe failed:', err));
  cancelProbe = scheduler.every(PROBE_INTERVAL_MS, () =>
    probeAllKeys().catch(err => console.error('[QuotaProbe] Probe failed:', err)),
  );
}

export function stopQuotaProbe(): void {
  if (cancelProbe) {
    cancelProbe();
    cancelProbe = null;
  }
}

export { probeAllKeys };
