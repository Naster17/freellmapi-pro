import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M } from '../db/model-pricing.js';
import { normalizeClientIp } from '../lib/request-log.js';

export const analyticsRouter = Router();

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
    case '24h':
      return toSqliteDateTime(now - 24 * 60 * 60 * 1000);
    case '30d':
      return toSqliteDateTime(now - 30 * 24 * 60 * 60 * 1000);
    case '90d':
      return toSqliteDateTime(now - 90 * 24 * 60 * 60 * 1000);
    case '365d':
      return toSqliteDateTime(now - 365 * 24 * 60 * 60 * 1000);
    case '7d':
    default:
      return toSqliteDateTime(now - 7 * 24 * 60 * 60 * 1000);
  }
}

function readAggregateSince(since: string) {
  const db = getDb();
  const aggregateSince = since.slice(0, 13) + ':00:00';
  const rows = db.prepare(`
    SELECT
      COALESCE(SUM(total_requests), 0) as total_requests,
      COALESCE(SUM(success_count), 0) as success_count,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      MIN(hour) as first_request_at
    FROM request_hourly
    WHERE hour >= ?
  `).get(aggregateSince) as {
    total_requests: number;
    success_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    first_request_at: string | null;
  };
  return rows;
}

function readLifetimeSettings() {
  const db = getDb();
  const row = db.prepare(`
    SELECT value FROM settings WHERE key = 'first_request_at'
  `).get() as { value: string } | undefined;
  return row?.value ?? null;
}

analyticsRouter.get('/summary', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const aggregate = readAggregateSince(since);
  const totalRequests = aggregate.total_requests ?? 0;
  const successRate = totalRequests > 0 ? (aggregate.success_count / totalRequests) * 100 : 0;

  const latencyRow = db.prepare(`
    SELECT AVG(latency_ms) as avg_latency_ms FROM requests WHERE created_at >= ?
  `).get(since) as { avg_latency_ms: number | null } | undefined;

  const savings = db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN r.status = 'success' THEN
        r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
        r.output_tokens * COALESCE(m.paid_output_per_m, ?) / 1000000.0
      ELSE 0 END
    ), 0) as est_savings
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
  `).get(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, since) as { est_savings: number };

  const pinRow = db.prepare(`
    SELECT
      SUM(CASE WHEN requested_model IS NOT NULL THEN 1 ELSE 0 END) as pinned_count,
      SUM(CASE WHEN requested_model = model_id THEN 1 ELSE 0 END) as pin_honored_count
    FROM requests WHERE created_at >= ?
  `).get(since) as { pinned_count: number | null; pin_honored_count: number | null };

  const lifetimeFirst = readLifetimeSettings();

  res.json({
    totalRequests,
    successRate: Math.round(successRate * 10) / 10,
    totalInputTokens: aggregate.total_input_tokens ?? 0,
    totalOutputTokens: aggregate.total_output_tokens ?? 0,
    avgLatencyMs: Math.round(latencyRow?.avg_latency_ms ?? 0),
    estimatedCostSavings: Math.round((savings.est_savings ?? 0) * 100) / 100,
    pinnedRequests: pinRow.pinned_count ?? 0,
    pinHonoredRequests: pinRow.pin_honored_count ?? 0,
    firstRequestAt: lifetimeFirst ?? aggregate.first_request_at ?? null,
    lifetimeTotalRequests: Number((db.prepare(`SELECT value FROM settings WHERE key='total_requests'`).get() as { value?: string } | undefined)?.value ?? 0) || 0,
  });
});

analyticsRouter.get('/by-model', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.platform,
      r.model_id,
      m.display_name,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens,
      SUM(r.cached_tokens) as total_cached_tokens,
      SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pinned_requests,
      SUM(CASE WHEN r.status = 'success' THEN
        r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
        r.output_tokens * COALESCE(m.paid_output_per_m, ?) / 1000000.0
      ELSE 0 END) as est_cost
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
    GROUP BY r.platform, r.model_id
    ORDER BY requests DESC
  `).all(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, since) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
    totalCachedTokens: r.total_cached_tokens ?? 0,
    pinnedRequests: r.pinned_requests ?? 0,
    estimatedCost: Math.round((r.est_cost ?? 0) * 100) / 100,
  })));
});

analyticsRouter.get('/by-platform', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      platform,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(latency_ms) as avg_latency_ms,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens
    FROM requests
    WHERE created_at >= ?
    GROUP BY platform
    ORDER BY requests DESC
  `).all(since) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
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
  const interval = (req.query.interval as string) ?? (range === '24h' ? 'hour' : 'day');
  const since = getSinceTimestamp(range);
  const db = getDb();

  const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';

  const rows = db.prepare(`
    SELECT
      strftime('${dateFormat}', hour) as timestamp,
      SUM(total_requests) as requests,
      SUM(success_count) as success_count,
      SUM(error_count) as failure_count
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
