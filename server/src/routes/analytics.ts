import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, CACHE_READ_PRICE_FACTOR } from '../db/model-pricing.js';
import { normalizeClientIp } from '../lib/request-log.js';
import { cachedRoute } from '../lib/response-cache.js';
import { AGGREGATE_METRIC_SELECT, rebuildDayAggregates } from '../lib/request-aggregate.js';

export const analyticsRouter = Router();

const ANALYTICS_CACHE_TTL_MS = 2_000;

analyticsRouter.use(cachedRoute(ANALYTICS_CACHE_TTL_MS, req => `analytics:${req.originalUrl}`));

const toSqliteDateTime = (timestamp: number) =>
    new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');

const FUSION_REQUEST_TAG = 'fusion';

function getRecentLimit(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw ?? 25);
  if (!Number.isFinite(parsed)) return 25;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

function getRouteMode(row: { request_type?: string | null; requested_model?: string | null; model_id: string; status?: string | null }) {
  const type = row.request_type ?? 'chat';
  if (type === 'embedding') return 'embed';
  if (type === 'image') return 'image';
  if (type === 'audio') return 'audio';
  if (row.requested_model === FUSION_REQUEST_TAG) return 'fusion';
  if (row.requested_model == null) return 'auto';
  if (row.requested_model === row.model_id) return 'pick';
  if (row.status === 'success') return 'auto';
  return 'fallback';
}

function getSinceTimestamp(range: string): string {
  const now = Date.now();

  switch (range) {
    case '12h':
      return toSqliteDateTime(now - 12 * 60 * 60 * 1000);
    case '6h':
      return toSqliteDateTime(now - 6 * 60 * 60 * 1000);
    case '3h':
      return toSqliteDateTime(now - 3 * 60 * 60 * 1000);
    case '1h':
      return toSqliteDateTime(now - 60 * 60 * 1000);
    case '30m':
      return toSqliteDateTime(now - 30 * 60 * 1000);
    case '10m':
      return toSqliteDateTime(now - 10 * 60 * 1000);
    case '24h':
      return toSqliteDateTime(now - 24 * 60 * 60 * 1000);
    case '30d':
      return toSqliteDateTime(now - 30 * 24 * 60 * 60 * 1000);
    case '90d':
      return toSqliteDateTime(now - 90 * 24 * 60 * 60 * 1000);
    case '365d':
      return toSqliteDateTime(now - 365 * 24 * 60 * 60 * 1000);
    case 'all':
      return '1970-01-01 00:00:00';
    case '7d':
    default:
      return toSqliteDateTime(now - 7 * 24 * 60 * 60 * 1000);
  }
}

const SUB_DAY_RANGES = new Set(['12h', '6h', '3h', '1h', '30m', '10m', '24h']);

function readLifetimeSettings() {
  const db = getDb();
  const row = db.prepare(`
    SELECT value FROM settings WHERE key = 'first_request_at'
  `).get() as { value: string } | undefined;
  return row?.value ?? null;
}

type CounterRow = {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  canceledCount: number;
  chatCount: number;
  embeddingCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  successInputTokens: number;
  successOutputTokens: number;
  successCachedTokens: number;
  latencySumMs: number;
  latencyCount: number;
  ttfbSumMs: number;
  ttfbCount: number;
  pinnedCount: number;
  pinHonoredCount: number;
  tpsSum: number;
  tpsCount: number;
};

const COUNTER_COLUMNS: Array<[keyof CounterRow, string]> = [
  ['totalRequests', 'total_requests'],
  ['successCount', 'success_count'],
  ['errorCount', 'error_count'],
  ['canceledCount', 'canceled_count'],
  ['chatCount', 'chat_count'],
  ['embeddingCount', 'embedding_count'],
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['cachedTokens', 'cached_tokens'],
  ['successInputTokens', 'success_input_tokens'],
  ['successOutputTokens', 'success_output_tokens'],
  ['successCachedTokens', 'success_cached_tokens'],
  ['latencySumMs', 'latency_sum_ms'],
  ['latencyCount', 'latency_count'],
  ['ttfbSumMs', 'ttfb_sum_ms'],
  ['ttfbCount', 'ttfb_count'],
  ['pinnedCount', 'pinned_count'],
  ['pinHonoredCount', 'pin_honored_count'],
  ['tpsSum', 'tps_sum'],
  ['tpsCount', 'tps_count'],
];

function marginCounter(row: Record<string, unknown> | undefined): CounterRow {
  const out = {} as CounterRow;
  for (const [key, sql] of COUNTER_COLUMNS) {
    const raw = row?.[sql];
    out[key] = typeof raw === 'number' ? raw : Number(raw ?? 0) || 0;
  }
  return out;
}

function mergeCounters(a: CounterRow, b: CounterRow): CounterRow {
  const out = {} as CounterRow;
  for (const [key] of COUNTER_COLUMNS) out[key] = a[key] + b[key];
  return out;
}

function counterSumSelect(): string {
  return COUNTER_COLUMNS.map(([, sql]) => `SUM(${sql}) as ${sql}`).join(', ');
}

function readAggregateSum(table: string, sinceDay: string): CounterRow {
  return marginCounter(getDb().prepare(`SELECT ${counterSumSelect()} FROM ${table} WHERE day >= ?`).get(sinceDay) as Record<string, unknown>);
}

function readAggregateGrouped(table: string, keyCols: string[], sinceDay: string): Array<Record<string, unknown>> {
  const keys = keyCols.join(', ');
  return getDb().prepare(`SELECT ${keys}, ${counterSumSelect()} FROM ${table} WHERE day >= ? GROUP BY ${keys}`).all(sinceDay) as Array<Record<string, unknown>>;
}

function readBoundaryRow(since: string, nextDay: string): CounterRow {
  return marginCounter(getDb().prepare(`SELECT ${AGGREGATE_METRIC_SELECT} FROM requests WHERE created_at >= ? AND created_at < ?`).get(since, nextDay) as Record<string, unknown>);
}

function nextDayOf(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function windowDays(since: string): { boundaryDay: string; nextDay: string } {
  const boundaryDay = since.slice(0, 10);
  return { boundaryDay, nextDay: nextDayOf(boundaryDay) };
}

function successRateOf(counters: CounterRow): number {
  const decided = counters.successCount + counters.errorCount;
  return decided > 0 ? Math.round((counters.successCount / decided) * 1000) / 10 : 0;
}

function averageLatencyMs(counters: CounterRow): number {
  return counters.latencyCount > 0 ? Math.round(counters.latencySumMs / counters.latencyCount) : 0;
}

function averageTtfbMs(counters: CounterRow): number | null {
  return counters.ttfbCount > 0 ? Math.round(counters.ttfbSumMs / counters.ttfbCount) : null;
}

function averageTokenRate(counters: CounterRow): number | null {
  return counters.tpsCount > 0 ? Math.round((counters.tpsSum / counters.tpsCount) * 10) / 10 : null;
}

type ModelCostInfo = { displayName: string; inputPrice: number; outputPrice: number; cachedPrice: number };

function numericOrFallback(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function readModelCostInfo(): Map<string, ModelCostInfo> {
  const rows = getDb().prepare(`
    SELECT platform, model_id, display_name, paid_input_per_m, paid_output_per_m, paid_cached_per_m
    FROM models
  `).all() as Array<Record<string, unknown>>;
  const map = new Map<string, ModelCostInfo>();
  for (const row of rows) {
    const inputPrice = numericOrFallback(row.paid_input_per_m, FALLBACK_INPUT_PER_M);
    map.set(`${row.platform}\u0000${row.model_id}`, {
      displayName: typeof row.display_name === 'string' ? row.display_name : String(row.model_id),
      inputPrice,
      outputPrice: numericOrFallback(row.paid_output_per_m, FALLBACK_OUTPUT_PER_M),
      cachedPrice: numericOrFallback(row.paid_cached_per_m, inputPrice * CACHE_READ_PRICE_FACTOR),
    });
  }
  return map;
}

function modelCost(counters: CounterRow, info: ModelCostInfo | undefined): number {
  const inputPrice = info?.inputPrice ?? FALLBACK_INPUT_PER_M;
  const outputPrice = info?.outputPrice ?? FALLBACK_OUTPUT_PER_M;
  const cachedPrice = info?.cachedPrice ?? FALLBACK_INPUT_PER_M * CACHE_READ_PRICE_FACTOR;
  return (
    counters.successInputTokens * inputPrice +
    counters.successOutputTokens * outputPrice +
    counters.successCachedTokens * cachedPrice
  ) / 1_000_000;
}

function readModelBuckets(since: string, nextDay: string): Array<{ platform: string; modelId: string; counters: CounterRow }> {
  const merged = new Map<string, CounterRow>();
  const key = (platform: string, modelId: string) => `${platform}\u0000${modelId}`;
  for (const row of readAggregateGrouped('request_daily_model', ['platform', 'model_id'], nextDay)) {
    merged.set(key(row.platform as string, row.model_id as string), marginCounter(row));
  }
  const boundary = getDb().prepare(`
    SELECT platform, model_id, ${AGGREGATE_METRIC_SELECT}
    FROM requests
    WHERE created_at >= ? AND created_at < ?
    GROUP BY platform, model_id
  `).all(since, nextDay) as Array<Record<string, unknown>>;
  for (const row of boundary) {
    const k = key(row.platform as string, row.model_id as string);
    const counters = marginCounter(row);
    const current = merged.get(k);
    merged.set(k, current ? mergeCounters(current, counters) : counters);
  }
  const out: Array<{ platform: string; modelId: string; counters: CounterRow }> = [];
  for (const [k, counters] of merged) {
    const sep = k.indexOf('\u0000');
    out.push({ platform: k.slice(0, sep), modelId: k.slice(sep + 1), counters });
  }
  return out;
}

analyticsRouter.get('/summary', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();
  const { nextDay } = windowDays(since);
  const counters = mergeCounters(readAggregateSum('request_daily_platform', nextDay), readBoundaryRow(since, nextDay));
  const totalRequests = counters.totalRequests;
  const successRate = successRateOf(counters);

  const pctStmt = db.prepare(`
    SELECT latency_ms FROM requests
    WHERE created_at >= ? AND latency_ms IS NOT NULL
    ORDER BY latency_ms ASC
    LIMIT 1 OFFSET ?
  `);
  const rawLatencyCount = (db.prepare(`
    SELECT COUNT(latency_ms) as cnt
    FROM requests
    WHERE created_at >= ? AND latency_ms IS NOT NULL
  `).get(since) as { cnt: number }).cnt;
  const p50Row = rawLatencyCount > 0 ? (pctStmt.get(since, Math.floor((rawLatencyCount - 1) * 0.5)) as { latency_ms: number } | undefined) : undefined;
  const p95Row = rawLatencyCount > 0 ? (pctStmt.get(since, Math.floor((rawLatencyCount - 1) * 0.95)) as { latency_ms: number } | undefined) : undefined;

  const requestTypeCounts = {
    chat: counters.chatCount,
    embedding: counters.embeddingCount,
  };

  const costInfo = readModelCostInfo();
  let estSavings = 0;
  for (const bucket of readModelBuckets(since, nextDay)) {
    estSavings += modelCost(bucket.counters, costInfo.get(`${bucket.platform}\u0000${bucket.modelId}`));
  }

  res.json({
    totalRequests,
    successRate,
    avgLatencyMs: averageLatencyMs(counters),
    p50LatencyMs: p50Row ? Math.round(p50Row.latency_ms) : null,
    p95LatencyMs: p95Row ? Math.round(p95Row.latency_ms) : null,
    avgTtfbMs: averageTtfbMs(counters),
    requestTypeCounts,
    totalInputTokens: counters.inputTokens,
    totalOutputTokens: counters.outputTokens,
    totalCachedTokens: counters.cachedTokens,
    estimatedCostSavings: Math.round(estSavings * 100) / 100,
    pinnedRequests: counters.pinnedCount,
    pinHonoredRequests: counters.pinHonoredCount,
    firstRequestAt: readLifetimeSettings(),
    lifetimeTotalRequests: Number((db.prepare(`SELECT value FROM settings WHERE key='total_requests'`).get() as { value?: string } | undefined)?.value ?? 0) || 0,
  });
});

analyticsRouter.get('/by-model', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const { nextDay } = windowDays(since);
  const costInfo = readModelCostInfo();

  const rows = readModelBuckets(since, nextDay)
    .map(bucket => {
      const info = costInfo.get(`${bucket.platform}\u0000${bucket.modelId}`);
      return {
        platform: bucket.platform,
        modelId: bucket.modelId,
        displayName: info?.displayName ?? bucket.modelId,
        requests: bucket.counters.totalRequests,
        successRate: successRateOf(bucket.counters),
        avgLatencyMs: averageLatencyMs(bucket.counters),
        totalInputTokens: bucket.counters.inputTokens,
        totalOutputTokens: bucket.counters.outputTokens,
        totalCachedTokens: bucket.counters.cachedTokens,
        pinnedRequests: bucket.counters.pinHonoredCount,
        estimatedCost: Math.round(modelCost(bucket.counters, info) * 100) / 100,
      };
    })
    .sort((a, b) => b.requests - a.requests);

  res.json(rows);
});

analyticsRouter.get('/by-platform', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();
  const { nextDay } = windowDays(since);

  const merged = new Map<string, CounterRow>();
  for (const row of readAggregateGrouped('request_daily_platform', ['platform'], nextDay)) {
    merged.set(row.platform as string, marginCounter(row));
  }
  const boundary = db.prepare(`
    SELECT platform, ${AGGREGATE_METRIC_SELECT}
    FROM requests
    WHERE created_at >= ? AND created_at < ?
    GROUP BY platform
  `).all(since, nextDay) as Array<Record<string, unknown>>;
  for (const row of boundary) {
    const platform = row.platform as string;
    const counters = marginCounter(row);
    const current = merged.get(platform);
    merged.set(platform, current ? mergeCounters(current, counters) : counters);
  }

  const rawCounts = new Map<string, number>();
  for (const row of db.prepare(`
    SELECT platform, COUNT(latency_ms) as latency_count
    FROM requests
    WHERE created_at >= ? AND latency_ms IS NOT NULL
    GROUP BY platform
  `).all(since) as Array<Record<string, unknown>>) {
    rawCounts.set(row.platform as string, Number(row.latency_count) || 0);
  }

  const p95Stmt = db.prepare(`
    SELECT latency_ms FROM requests
    WHERE created_at >= ? AND platform = ? AND latency_ms IS NOT NULL
    ORDER BY latency_ms ASC
    LIMIT 1 OFFSET ?
  `);

  const rows = Array.from(merged, ([platform, counters]) => {
    const rawLatencyCount = rawCounts.get(platform) ?? 0;
    const p95Row = rawLatencyCount > 0
      ? (p95Stmt.get(since, platform, Math.floor((rawLatencyCount - 1) * 0.95)) as { latency_ms: number } | undefined)
      : undefined;
    return {
      platform,
      requests: counters.totalRequests,
      successRate: successRateOf(counters),
      avgLatencyMs: averageLatencyMs(counters),
      p95LatencyMs: p95Row ? Math.round(p95Row.latency_ms) : null,
      avgTtfbMs: averageTtfbMs(counters),
      errorCount: counters.errorCount,
      avgTokensPerSecond: averageTokenRate(counters),
      totalInputTokens: counters.inputTokens,
      totalOutputTokens: counters.outputTokens,
    };
  }).sort((a, b) => b.requests - a.requests);

  res.json(rows);
});

analyticsRouter.get('/by-client', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();
  const { nextDay } = windowDays(since);

  const aggRows = db.prepare(`
    SELECT client_agent, ${counterSumSelect()}, MAX(max_created_at) as max_created_at
    FROM request_daily_client
    WHERE day >= ?
    GROUP BY client_agent
  `).all(nextDay) as Array<Record<string, unknown>>;
  const boundary = db.prepare(`
    SELECT COALESCE(client_agent, 'unknown') AS client_agent, ${AGGREGATE_METRIC_SELECT}, MAX(created_at) as max_created_at
    FROM requests
    WHERE created_at >= ? AND created_at < ?
    GROUP BY COALESCE(client_agent, 'unknown')
  `).all(since, nextDay) as Array<Record<string, unknown>>;

  const merged = new Map<string, CounterRow & { lastSeenAt: string | null }>();
  for (const row of aggRows) {
    const agent = row.client_agent as string;
    merged.set(agent, { ...marginCounter(row), lastSeenAt: (row.max_created_at as string | null) ?? null });
  }
  for (const row of boundary) {
    const agent = row.client_agent as string;
    const counters = marginCounter(row);
    const seen = row.max_created_at as string | null;
    const current = merged.get(agent);
    if (current) {
      const later = seen && current.lastSeenAt ? (seen > current.lastSeenAt ? seen : current.lastSeenAt) : (seen ?? current.lastSeenAt);
      merged.set(agent, { ...mergeCounters(current, counters), lastSeenAt: later });
    } else {
      merged.set(agent, { ...counters, lastSeenAt: seen ?? null });
    }
  }

  const rows = Array.from(merged, ([agent, value]) => ({
    clientAgent: agent,
    requests: value.totalRequests,
    successRate: successRateOf(value),
    avgLatencyMs: averageLatencyMs(value),
    totalInputTokens: value.inputTokens,
    totalOutputTokens: value.outputTokens,
    lastSeenAt: value.lastSeenAt ? `${value.lastSeenAt.slice(0, 10)}T${value.lastSeenAt.slice(11)}Z` : null,
  })).sort((a, b) => b.requests - a.requests);

res.json(rows);
});

analyticsRouter.get('/by-key', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();
  const { nextDay } = windowDays(since);

  const merged = new Map<number, CounterRow>();
  for (const row of readAggregateGrouped('request_daily_key', ['key_id'], nextDay)) {
    merged.set(Number(row.key_id), marginCounter(row));
  }
  const boundary = db.prepare(`
    SELECT key_id, ${AGGREGATE_METRIC_SELECT}
    FROM requests
    WHERE key_id IS NOT NULL AND created_at >= ? AND created_at < ?
    GROUP BY key_id
  `).all(since, nextDay) as Array<Record<string, unknown>>;
  for (const row of boundary) {
    const keyId = Number(row.key_id);
    const counters = marginCounter(row);
    const current = merged.get(keyId);
    merged.set(keyId, current ? mergeCounters(current, counters) : counters);
  }

  const keyRows = db.prepare('SELECT id, label, platform FROM api_keys').all() as Array<{ id: number; label: string | null; platform: string | null }>;
  const keyInfo = new Map<number, { label: string | null; platform: string | null }>();
  for (const key of keyRows) keyInfo.set(key.id, { label: key.label, platform: key.platform });

  const rows = Array.from(merged, ([keyId, counters]) => ({
    keyId,
    label: keyInfo.get(keyId)?.label ?? null,
    platform: keyInfo.get(keyId)?.platform ?? null,
    requests: counters.totalRequests,
    successRate: successRateOf(counters),
    avgLatencyMs: averageLatencyMs(counters),
    totalInputTokens: counters.inputTokens,
    totalOutputTokens: counters.outputTokens,
  }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 50);

  res.json(rows);
});

analyticsRouter.get('/recent', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const limit = getRecentLimit(req.query.limit);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.id,
      r.platform,
      r.model_id,
      m.display_name,
      r.status,
      r.input_tokens,
      r.output_tokens,
      r.cached_tokens,
      r.latency_ms,
      r.request_type,
      r.requested_model,
      r.client_ip,
      r.error,
      r.created_at
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ?
  `).all(since, limit) as any[];

  res.json(rows.map(r => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    status: r.status,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cachedTokens: r.cached_tokens ?? 0,
    latencyMs: r.latency_ms ?? 0,
    requestType: r.request_type ?? 'chat',
    routeMode: getRouteMode(r),
    clientIp: normalizeClientIp(r.client_ip),
    error: r.error ?? null,
    createdAt: r.created_at,
  })));
});

analyticsRouter.get('/timeline', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const interval = (req.query.interval as string) ?? (SUB_DAY_RANGES.has(range) ? 'hour' : 'day');
  const since = getSinceTimestamp(range);
  const db = getDb();

  const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';

  const rows = db.prepare(`
    SELECT
      strftime('${dateFormat}', hour) as timestamp,
      SUM(total_requests) as requests,
      SUM(success_count) as success_count,
      SUM(error_count) as failure_count,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens
    FROM request_hourly
    WHERE hour >= ?
    GROUP BY strftime('${dateFormat}', hour)
    ORDER BY timestamp ASC
  `).all(since) as any[];

  res.json(rows.map(r => ({
    timestamp: r.timestamp,
    requests: r.requests,
    successCount: r.success_count,
    failureCount: r.failure_count,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
  })));
});

analyticsRouter.get('/error-distribution', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      platform,
      model_id,
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as error_category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY platform, error_category
    ORDER BY count DESC
  `).all(since) as any[];

  const byCategory = db.prepare(`
    SELECT
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY category
    ORDER BY count DESC
  `).all(since) as any[];

  const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY platform
    ORDER BY count DESC
  `).all(since) as any[];

  res.json({
    byCategory,
    byPlatform,
    detailed: rows,
  });
});

analyticsRouter.get('/errors', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, platform, model_id, error, latency_ms, created_at
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(since) as any[];

  res.json(rows.map(r => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    error: r.error,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  })));
});

analyticsRouter.post('/errors/clear', (req: Request, res: Response) => {
  const range = typeof req.body?.range === 'string' ? req.body.range : '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();
  const days = db.prepare(`
    SELECT DISTINCT substr(created_at, 1, 10) AS day
    FROM requests
    WHERE status = 'error' AND created_at >= ?
  `).all(since) as Array<{ day: string }>;
  const result = db.prepare(`DELETE FROM requests WHERE status = 'error' AND created_at >= ?`).run(since);
  for (const { day } of days) {
    rebuildDayAggregates(db, day);
  }
  res.json({ cleared: result.changes });
});

// Recent calls — one row per proxied request, newest first, with the caller's
// IP and User-Agent (all local clients share the unified key, so client_ip is
// the only per-caller discriminator; UA disambiguates tunneled loopback calls).
// Reads the raw `requests` table, so history is bounded by the retention prune.
analyticsRouter.get('/requests', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  // Optional filters. Both are validated (whitelist / shape) and applied as
  // bound parameters; absent filters keep the default behavior identical.
  const status = req.query.status as string | undefined;
  if (status !== undefined && status !== 'success' && status !== 'error' && status !== 'canceled') {
    res.status(400).json({ error: "invalid status filter (expected 'success', 'error' or 'canceled')" });
    return;
  }
  // Platform ids are short slugs ('groq', 'pt-custom_1'); anything else is a
  // client bug, not a filter.
  const platform = req.query.platform as string | undefined;
  if (platform !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(platform)) {
    res.status(400).json({ error: 'invalid platform filter' });
    return;
  }
  const db = getDb();

  const filterSql =
    (status !== undefined ? ' AND r.status = ?' : '') +
    (platform !== undefined ? ' AND r.platform = ?' : '');
  const filterParams = [
    ...(status !== undefined ? [status] : []),
    ...(platform !== undefined ? [platform] : []),
  ];

  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM requests r WHERE r.created_at >= ?${filterSql}`
  ).get(since, ...filterParams) as { c: number }).c;

  const rows = db.prepare(`
    SELECT r.id, r.platform, r.model_id, r.requested_model, r.request_type, r.status,
           r.input_tokens, r.output_tokens, r.cached_tokens, r.latency_ms, r.error,
           r.client_ip, r.client_user_agent, r.client_agent,
           r.key_id, k.label as key_label,
           strftime('%Y-%m-%dT%H:%M:%SZ', r.created_at) as created_at_iso,
           (SELECT COUNT(*) FROM request_attempts a WHERE a.request_id = r.id) as attempt_count
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?${filterSql}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(since, ...filterParams, limit, offset) as any[];

  res.json({
    total,
    rows: rows.map(r => ({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      requestedModel: r.requested_model,
      requestType: r.request_type,
      status: r.status,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cachedTokens: r.cached_tokens,
      latencyMs: r.latency_ms,
      error: r.error,
      keyId: r.key_id ?? null,
      keyLabel: r.key_label ?? null,
      clientIp: r.client_ip,
      clientUserAgent: r.client_user_agent,
      clientAgent: r.client_agent,
      createdAt: r.created_at_iso,
      // Failover-ladder length for this row. Attempts hang off the TERMINAL
      // row of a proxied request; mid-ladder failure rows report 0.
      attemptCount: r.attempt_count,
    })),
  });
});

// Per-request detail: the row plus its durable failover ladder — one entry per
// dispatched attempt (including the successful final one), ordinal-ordered,
// with the failure class and timing of each hop. keyOrdinal is the per-request
// key ordinal (key1, key2…), same anonymization as X-Fallback-Trail — internal
// key ids are never exposed. Attempts are keyed to the ladder's terminal row
// (the success row, or the last failure row when it exhausted), so mid-ladder
// error rows legitimately return an empty attempts array.
analyticsRouter.get('/requests/:id', (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid request id' });
    return;
  }
  const db = getDb();

  const r = db.prepare(`
    SELECT r.id, r.platform, r.model_id, r.requested_model, r.served_model, r.request_type, r.status,
           r.input_tokens, r.output_tokens, r.latency_ms, r.ttfb_ms, r.error,
           r.client_ip, r.client_user_agent, r.client_agent,
           r.key_id, k.label as key_label,
           strftime('%Y-%m-%dT%H:%M:%SZ', r.created_at) as created_at_iso
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.id = ?
  `).get(id) as any;
  if (!r) {
    res.status(404).json({ error: 'request not found' });
    return;
  }

  const attempts = db.prepare(`
    SELECT ordinal, platform, model_id, key_ordinal, outcome, start_offset_ms, duration_ms, error_summary
    FROM request_attempts
    WHERE request_id = ?
    ORDER BY ordinal ASC
  `).all(id) as any[];

  res.json({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    requestedModel: r.requested_model,
    // Upstream-reported model when it genuinely differed from the routed
    // model_id (#534 served-model drift guard); null in the healthy case.
    servedModel: r.served_model,
    requestType: r.request_type,
    status: r.status,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    latencyMs: r.latency_ms,
    ttfbMs: r.ttfb_ms,
    error: r.error,
    keyId: r.key_id ?? null,
    keyLabel: r.key_label ?? null,
    clientIp: r.client_ip,
    clientUserAgent: r.client_user_agent,
    clientAgent: r.client_agent,
    createdAt: r.created_at_iso,
    attempts: attempts.map(a => ({
      ordinal: a.ordinal,
      platform: a.platform,
      modelId: a.model_id,
      keyOrdinal: a.key_ordinal,
      outcome: a.outcome,
      startOffsetMs: a.start_offset_ms,
      durationMs: a.duration_ms,
      // Short, redacted per-hop error text (null for successful hops and for
      // rows written before the error_summary migration).
      errorSummary: a.error_summary ?? null,
    })),
  });
});
