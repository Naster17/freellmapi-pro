import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { parseBudget } from '../lib/budget.js';
import {
  getProviderDailyRequestCap,
  getRateLimitStatus,
  isOnCooldown,
  providerDailyRequestCount,
} from '../services/ratelimit.js';
import { getActiveCooldowns, probeAllActiveCooldowns } from '../services/cooldown-probe.js';
import { getQuotaStateForKeys } from '../services/provider-quota.js';

export const usageLimitsRouter = Router();

type LimitCounter = { used: number; limit: number | null; pct: number | null; remaining: number | null };

function combineCounters(counters: { used: number; limit: number | null }[]): LimitCounter {
  const used = counters.reduce((sum, counter) => sum + counter.used, 0);
  const limits = counters.map(counter => counter.limit).filter((limit): limit is number => limit !== null);
  const limit = limits.length > 0 ? limits.reduce((sum, value) => sum + value, 0) : null;
  return {
    used,
    limit,
    pct: limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : null,
    remaining: limit === null ? null : Math.max(0, limit - used),
  };
}

function singleCounter(used: number, limit: number | null): LimitCounter {
  return combineCounters([{ used, limit }]);
}

usageLimitsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const thirtyDaysAgoSql = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  const models = db.prepare(`
    SELECT id, platform, model_id, display_name, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
           monthly_token_budget, enabled, key_id
      FROM models
     WHERE enabled = 1
     ORDER BY platform ASC, display_name ASC
  `).all() as any[];

  const keys = db.prepare(`
    SELECT id, platform, label, status, enabled
      FROM api_keys
     WHERE enabled = 1
     ORDER BY platform ASC, id ASC
  `).all() as any[];

  const usage30d = db.prepare(`
    SELECT platform, model_id,
           COUNT(*) AS requests,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
      FROM requests
     WHERE status = 'success' AND created_at >= ?
     GROUP BY platform, model_id
  `).all(thirtyDaysAgoSql) as { platform: string; model_id: string; requests: number; tokens: number }[];
  const usage30dMap = new Map(usage30d.map(row => [`${row.platform}:${row.model_id}`, row]));

  const keyLastUsed = db.prepare(`
    SELECT platform, model_id, key_id,
           COUNT(*) AS requests,
           MAX(created_at) AS last_used_at
      FROM requests
     WHERE key_id IS NOT NULL
     GROUP BY platform, model_id, key_id
  `).all() as { platform: string; model_id: string; key_id: number; requests: number; last_used_at: string | null }[];
  const keyLastUsedMap = new Map(keyLastUsed.map(row => [`${row.platform}:${row.model_id}:${row.key_id}`, row]));

  const keyRowsByPlatform = new Map<string, any[]>();
  for (const key of keys) {
    const list = keyRowsByPlatform.get(key.platform) ?? [];
    list.push(key);
    keyRowsByPlatform.set(key.platform, list);
  }

  const modelRows = models.map(model => {
    const modelKeys = model.platform === 'custom' && model.key_id != null
      ? keys.filter(key => key.id === model.key_id)
      : (keyRowsByPlatform.get(model.platform) ?? []);
    const keyUsages = modelKeys.map(key => {
      const status = getRateLimitStatus(model.platform, model.model_id, key.id, {
        rpm: model.rpm_limit,
        rpd: model.rpd_limit,
        tpm: model.tpm_limit,
        tpd: model.tpd_limit,
      });
      const providerCap = getProviderDailyRequestCap(model.platform);
      const providerUsed = providerDailyRequestCount(model.platform, key.id, now);
      const lastUsed = keyLastUsedMap.get(`${model.platform}:${model.model_id}:${key.id}`);
      return {
        keyId: key.id,
        label: key.label || `#${key.id}`,
        status: key.status,
        lastUsedAt: lastUsed?.last_used_at ?? null,
        requests: lastUsed?.requests ?? 0,
        onCooldown: isOnCooldown(model.platform, model.model_id, key.id),
        rpm: singleCounter(status.rpm.used, status.rpm.limit),
        rpd: singleCounter(status.rpd.used, status.rpd.limit),
        tpm: singleCounter(status.tpm.used, status.tpm.limit),
        tpd: singleCounter(status.tpd.used, status.tpd.limit),
        providerRpd: singleCounter(providerUsed, providerCap),
        providerReported: [] as Array<{ quotaPoolKey: string; metric: string; limit: number | null; remaining: number | null; resetAt: string | null; source: string; confidence: number; observedAt: string; notes: string | null }>,
        cooldowns: [] as Array<{ modelId: string; expiresAtMs: number; remainingSeconds: number; reason: string | null }>,
      };
    }).sort((a, b) => {
      if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
      if (a.lastUsedAt) return -1;
      if (b.lastUsedAt) return 1;
      return b.requests - a.requests || a.keyId - b.keyId;
    });
    const monthlyBudgetPerKey = parseBudget(model.monthly_token_budget ?? '');
    const monthlyBudget = monthlyBudgetPerKey > 0 ? monthlyBudgetPerKey * modelKeys.length : null;
    const thirtyDayUsage = usage30dMap.get(`${model.platform}:${model.model_id}`);

    return {
      modelDbId: model.id,
      platform: model.platform,
      modelId: model.model_id,
      displayName: model.display_name,
      keyCount: modelKeys.length,
      monthlyTokenBudget: model.monthly_token_budget ?? '',
      rpm: combineCounters(keyUsages.map(row => ({ used: row.rpm.used, limit: row.rpm.limit }))),
      rpd: combineCounters(keyUsages.map(row => ({ used: row.rpd.used, limit: row.rpd.limit }))),
      tpm: combineCounters(keyUsages.map(row => ({ used: row.tpm.used, limit: row.tpm.limit }))),
      tpd: combineCounters(keyUsages.map(row => ({ used: row.tpd.used, limit: row.tpd.limit }))),
      monthly: singleCounter(thirtyDayUsage?.tokens ?? 0, monthlyBudget),
      requests30d: thirtyDayUsage?.requests ?? 0,
      keys: keyUsages,
    };
  }).filter(row => row.keyCount > 0);

  const providerMap = new Map<string, any>();
  for (const row of modelRows) {
    const provider = providerMap.get(row.platform) ?? {
      platform: row.platform,
      keyCount: keyRowsByPlatform.get(row.platform)?.length ?? 0,
      modelCount: 0,
      requests24h: 0,
      tokens24h: 0,
      requests30d: 0,
      tokens30d: 0,
      monthlyLimit: 0,
      monthlyKnown: false,
    };
    provider.modelCount += 1;
    provider.requests24h += row.rpd.used;
    provider.tokens24h += row.tpd.used;
    provider.requests30d += row.requests30d;
    provider.tokens30d += row.monthly.used;
    if (row.monthly.limit !== null) {
      provider.monthlyLimit += row.monthly.limit;
      provider.monthlyKnown = true;
    }
    providerMap.set(row.platform, provider);
  }

  const providers = [...providerMap.values()].map(provider => {
    const platformKeys = keyRowsByPlatform.get(provider.platform) ?? [];
    const providerCap = getProviderDailyRequestCap(provider.platform);
    const providerUsed = platformKeys.reduce((sum, key) => sum + providerDailyRequestCount(provider.platform, key.id, now), 0);
    return {
      platform: provider.platform,
      keyCount: provider.keyCount,
      modelCount: provider.modelCount,
      requests24h: provider.requests24h,
      tokens24h: provider.tokens24h,
      requests30d: provider.requests30d,
      monthly: singleCounter(provider.tokens30d, provider.monthlyKnown ? provider.monthlyLimit : null),
      providerRpd: singleCounter(providerUsed, providerCap === null ? null : providerCap * platformKeys.length),
    };
  }).sort((a, b) => b.tokens24h - a.tokens24h || b.requests24h - a.requests24h);

  const constrainedModels = modelRows
    .filter(row => [row.rpm, row.rpd, row.tpm, row.tpd, row.monthly].some(counter => counter.pct !== null && counter.pct >= 70))
    .sort((a, b) => Math.max(b.rpm.pct ?? 0, b.rpd.pct ?? 0, b.tpm.pct ?? 0, b.tpd.pct ?? 0, b.monthly.pct ?? 0) -
      Math.max(a.rpm.pct ?? 0, a.rpd.pct ?? 0, a.tpm.pct ?? 0, a.tpd.pct ?? 0, a.monthly.pct ?? 0))
    .slice(0, 8);

  const quotaSignals = getQuotaStateForKeys();
  const quotaByKey = new Map<string, typeof quotaSignals>();
  for (const signal of quotaSignals) {
    const mapKey = `${signal.platform}:${signal.keyId}`;
    const list = quotaByKey.get(mapKey) ?? [];
    list.push(signal);
    quotaByKey.set(mapKey, list);
  }

  const activeCooldowns = getActiveCooldowns(now);
  const cooldownsByKey = new Map<string, typeof activeCooldowns>();
  for (const c of activeCooldowns) {
    const mapKey = `${c.platform}:${c.keyId}`;
    const list = cooldownsByKey.get(mapKey) ?? [];
    list.push(c);
    cooldownsByKey.set(mapKey, list);
  }

  for (const model of modelRows) {
    for (const key of model.keys) {
      key.providerReported = (quotaByKey.get(`${model.platform}:${key.keyId}`) ?? [])
        .filter(signal => signal.source !== 'probe' || signal.confidence >= 0.5)
        .map(signal => ({
          quotaPoolKey: signal.quotaPoolKey,
          metric: signal.metric,
          limit: signal.limit,
          remaining: signal.remaining,
          resetAt: signal.resetAt,
          source: signal.source,
          confidence: signal.confidence,
          observedAt: signal.observedAt,
          notes: signal.notes,
        }));
      key.cooldowns = (cooldownsByKey.get(`${model.platform}:${key.keyId}`) ?? [])
        .filter(c => c.modelId === model.modelId)
        .map(c => ({
          modelId: c.modelId,
          expiresAtMs: c.expiresAtMs,
          remainingSeconds: c.remainingSeconds,
          reason: c.reason,
        }));
    }
  }

  const reportingProviders = new Set(quotaSignals.filter(signal => signal.source === 'header' || signal.source === 'quota_api').map(signal => signal.platform));

  res.json({
    generatedAt: new Date(now).toISOString(),
    window: {
      rpm: 'rolling_60s',
      daily: 'rolling_24h',
      monthly: 'last_30d',
      dailyResetAt: new Date(dayAgo + 2 * 24 * 60 * 60 * 1000).toISOString(),
    },
    summary: {
      providerCount: providers.length,
      modelCount: modelRows.length,
      keyCount: keys.length,
      requests24h: providers.reduce((sum, provider) => sum + provider.requests24h, 0),
      tokens24h: providers.reduce((sum, provider) => sum + provider.tokens24h, 0),
      requests30d: providers.reduce((sum, provider) => sum + provider.requests30d, 0),
      tokens30d: providers.reduce((sum, provider) => sum + provider.monthly.used, 0),
      constrainedCount: constrainedModels.length,
      quotaSignalCount: quotaSignals.length,
      quotaReportingProviders: reportingProviders.size,
    },
    providers,
    models: modelRows,
    constrainedModels,
    quotaSignals,
  });
});

usageLimitsRouter.post('/probe-cooldowns', async (_req: Request, res: Response) => {
  try {
    const summary = await probeAllActiveCooldowns(12000);
    res.json({
      generatedAt: new Date().toISOString(),
      probed: summary.probed,
      recovered: summary.recovered.map(r => ({
        platform: r.target.platform,
        modelId: r.target.modelId,
        keyId: r.target.keyId,
      })),
      newlyCooled: summary.newlyCooled.map(r => ({
        platform: r.target.platform,
        modelId: r.target.modelId,
        keyId: r.target.keyId,
        reason: r.reason ?? 'unknown',
      })),
      stillCooled: summary.stillCooled,
      timedOut: summary.timedOut,
    });
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message ?? 'cooldown probe failed', type: 'cooldown_probe_error' } });
  }
});
