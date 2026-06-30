import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { checkKeyHealth, checkAllKeys, isCheckAllInFlight, getCheckAllStartedAt } from '../services/health.js';
import { hasProvider } from '../providers/index.js';
import { getQuotaStateForKeys } from '../services/provider-quota.js';
import { getActiveCooldowns } from '../services/cooldown-probe.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  const db = getDb();
  const now = Date.now();

  const platforms = db.prepare(`
    SELECT
      platform,
      COUNT(*) as total_keys,
      SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy_keys,
      SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid_keys,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_keys,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) as unknown_keys,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_keys
    FROM api_keys
    GROUP BY platform
  `).all() as any[];

  const cooldownCounts = db.prepare(`
    SELECT platform, key_id AS keyId, COUNT(*) AS n
      FROM rate_limit_cooldowns
     WHERE expires_at_ms > ?
     GROUP BY platform, key_id
  `).all(now) as Array<{ platform: string; keyId: number; n: number }>;

  const cooldownsByPlatform = new Map<string, number>();
  const cooldownsByKey = new Map<number, number>();
  for (const c of cooldownCounts) {
    cooldownsByPlatform.set(c.platform, (cooldownsByPlatform.get(c.platform) ?? 0) + c.n);
    cooldownsByKey.set(c.keyId, c.n);
  }

  const activeCooldowns = getActiveCooldowns(now);
  type DedupedCooldown = (typeof activeCooldowns)[number] & { modelCount: number };
  const dedupMap = new Map<string, DedupedCooldown>();
  for (const c of activeCooldowns) {
    const dedupKey = `${c.keyId}:${c.reason ?? ''}`;
    const existing = dedupMap.get(dedupKey);
    if (!existing) {
      dedupMap.set(dedupKey, { ...c, modelCount: 1 });
      continue;
    }
    existing.modelCount += 1;
    if (c.expiresAtMs > existing.expiresAtMs) {
      existing.expiresAtMs = c.expiresAtMs;
      existing.remainingSeconds = c.remainingSeconds;
      existing.modelId = c.modelId;
    }
  }
  const dedupedCooldowns = [...dedupMap.values()].sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  const cooldownsListByKey = new Map<number, DedupedCooldown[]>();
  for (const c of dedupedCooldowns) {
    const list = cooldownsListByKey.get(c.keyId) ?? [];
    list.push(c);
    cooldownsListByKey.set(c.keyId, list);
  }

  const keys = db.prepare(`
    SELECT id, platform, label, status, enabled, created_at, last_checked_at
    FROM api_keys
    ORDER BY platform, created_at DESC
  `).all() as any[];

  res.json({
    platforms: platforms.map(p => ({
      platform: p.platform,
      hasProvider: hasProvider(p.platform),
      totalKeys: p.total_keys,
      healthyKeys: p.healthy_keys,
      rateLimitedKeys: cooldownsByPlatform.get(p.platform) ?? 0,
      invalidKeys: p.invalid_keys,
      errorKeys: p.error_keys,
      unknownKeys: p.unknown_keys,
      enabledKeys: p.enabled_keys,
    })),
    keys: keys.map(k => {
      const cooldowns = cooldownsListByKey.get(k.id) ?? [];
      return {
        id: k.id,
        platform: k.platform,
        label: k.label,
        status: k.status,
        enabled: k.enabled === 1,
        createdAt: k.created_at,
        lastCheckedAt: k.last_checked_at,
        activeCooldowns: cooldownsByKey.get(k.id) ?? 0,
        cooldowns: cooldowns.map(c => ({
          modelId: c.modelId,
          expiresAtMs: c.expiresAtMs,
          remainingSeconds: c.remainingSeconds,
          reason: c.reason,
          modelCount: c.modelCount,
        })),
      };
    }),
    quotaStates: getQuotaStateForKeys(),
    checkAllInFlight: isCheckAllInFlight(),
    checkAllStartedAt: isCheckAllInFlight() ? getCheckAllStartedAt() : null,
  });
});

healthRouter.post('/check/:keyId', async (req: Request, res: Response) => {
  const keyId = parseInt(req.params.keyId as string, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const status = await checkKeyHealth(keyId);
  res.json({ keyId, status });
});

healthRouter.post('/check-all', (_req: Request, res: Response) => {
  const wasInFlight = isCheckAllInFlight();
  const startedAt = wasInFlight ? getCheckAllStartedAt() : Date.now();

  void checkAllKeys().catch(err => console.error('[Health] check-all background error:', err));

  res.status(202).json({
    accepted: true,
    alreadyInFlight: wasInFlight,
    startedAt,
  });
});
