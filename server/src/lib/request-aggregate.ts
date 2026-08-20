import type { Db } from '../db/types.js';

export type RequestAggregateFields = {
  createdAt: string;
  platform: string;
  modelId: string;
  keyId: number | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
  ttfbMs: number | null;
  requestedModel: string | null;
  clientAgent: string | null;
  requestType: string;
};

export const AGGREGATE_CLIENT_UNKNOWN = 'unknown';

export function dayKey(createdAt: string): string {
  return createdAt.slice(0, 10);
}

const METRIC_COLUMNS =
  'total_requests INTEGER NOT NULL DEFAULT 0,' +
  'success_count INTEGER NOT NULL DEFAULT 0,' +
  'error_count INTEGER NOT NULL DEFAULT 0,' +
  'canceled_count INTEGER NOT NULL DEFAULT 0,' +
  'chat_count INTEGER NOT NULL DEFAULT 0,' +
  'embedding_count INTEGER NOT NULL DEFAULT 0,' +
  'input_tokens INTEGER NOT NULL DEFAULT 0,' +
  'output_tokens INTEGER NOT NULL DEFAULT 0,' +
  'cached_tokens INTEGER NOT NULL DEFAULT 0,' +
  'success_input_tokens INTEGER NOT NULL DEFAULT 0,' +
  'success_output_tokens INTEGER NOT NULL DEFAULT 0,' +
  'success_cached_tokens INTEGER NOT NULL DEFAULT 0,' +
  'latency_sum_ms REAL NOT NULL DEFAULT 0,' +
  'latency_count INTEGER NOT NULL DEFAULT 0,' +
  'ttfb_sum_ms REAL NOT NULL DEFAULT 0,' +
  'ttfb_count INTEGER NOT NULL DEFAULT 0,' +
  'pinned_count INTEGER NOT NULL DEFAULT 0,' +
  'pin_honored_count INTEGER NOT NULL DEFAULT 0,' +
  'tps_sum REAL NOT NULL DEFAULT 0,' +
  'tps_count INTEGER NOT NULL DEFAULT 0';

export const AGGREGATE_METRIC_SELECT =
  'COUNT(*) as total_requests,' +
  'SUM(CASE WHEN status = \'success\' THEN 1 ELSE 0 END) as success_count,' +
  'SUM(CASE WHEN status = \'error\' THEN 1 ELSE 0 END) as error_count,' +
  'SUM(CASE WHEN status = \'canceled\' THEN 1 ELSE 0 END) as canceled_count,' +
  'SUM(CASE WHEN request_type = \'chat\' THEN 1 ELSE 0 END) as chat_count,' +
  'SUM(CASE WHEN request_type = \'embedding\' THEN 1 ELSE 0 END) as embedding_count,' +
  'COALESCE(SUM(input_tokens), 0) as input_tokens,' +
  'COALESCE(SUM(output_tokens), 0) as output_tokens,' +
  'COALESCE(SUM(cached_tokens), 0) as cached_tokens,' +
  'COALESCE(SUM(CASE WHEN status = \'success\' THEN input_tokens ELSE 0 END), 0) as success_input_tokens,' +
  'COALESCE(SUM(CASE WHEN status = \'success\' THEN output_tokens ELSE 0 END), 0) as success_output_tokens,' +
  'COALESCE(SUM(CASE WHEN status = \'success\' THEN cached_tokens ELSE 0 END), 0) as success_cached_tokens,' +
  'COALESCE(SUM(latency_ms), 0) as latency_sum_ms,' +
  'COUNT(latency_ms) as latency_count,' +
  'COALESCE(SUM(ttfb_ms), 0) as ttfb_sum_ms,' +
  'COUNT(ttfb_ms) as ttfb_count,' +
  'SUM(CASE WHEN requested_model IS NOT NULL THEN 1 ELSE 0 END) as pinned_count,' +
  'SUM(CASE WHEN requested_model = model_id THEN 1 ELSE 0 END) as pin_honored_count,' +
  'COALESCE(SUM(CASE WHEN output_tokens > 0 AND latency_ms > 0 THEN CAST(output_tokens AS REAL) * 1000.0 / latency_ms ELSE 0 END), 0) as tps_sum,' +
  'SUM(CASE WHEN output_tokens > 0 AND latency_ms > 0 THEN 1 ELSE 0 END) as tps_count';

export function createRequestDailyTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_daily_platform (
      day TEXT NOT NULL,
      platform TEXT NOT NULL,
      ${METRIC_COLUMNS},
      PRIMARY KEY (day, platform)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS request_daily_model (
      day TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      ${METRIC_COLUMNS},
      PRIMARY KEY (day, platform, model_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS request_daily_client (
      day TEXT NOT NULL,
      client_agent TEXT NOT NULL,
      ${METRIC_COLUMNS},
      max_created_at TEXT,
      PRIMARY KEY (day, client_agent)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS request_daily_key (
      day TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      ${METRIC_COLUMNS},
      PRIMARY KEY (day, key_id)
    ) WITHOUT ROWID;
  `);
}

export function applyRequestAggregates(db: Db, fields: RequestAggregateFields): void {
  const createdAt = fields.createdAt;
  const day = dayKey(createdAt);
  const success = fields.status === 'success' ? 1 : 0;
  const error = fields.status === 'error' ? 1 : 0;
  const canceled = fields.status === 'canceled' ? 1 : 0;
  const chat = fields.requestType === 'chat' ? 1 : 0;
  const embedding = fields.requestType === 'embedding' ? 1 : 0;
  const successInput = success ? fields.inputTokens : 0;
  const successOutput = success ? fields.outputTokens : 0;
  const successCached = success ? fields.cachedTokens : 0;
  const ttfb = fields.ttfbMs != null ? fields.ttfbMs : 0;
  const ttfbCount = fields.ttfbMs != null ? 1 : 0;
  const tpsQualify = fields.outputTokens > 0 && fields.latencyMs > 0 ? 1 : 0;
  const tps = tpsQualify ? (fields.outputTokens * 1000.0) / fields.latencyMs : 0;
  const pinned = fields.requestedModel != null ? 1 : 0;
  const honored = fields.requestedModel != null && fields.requestedModel === fields.modelId ? 1 : 0;
  const clientAgent = fields.clientAgent ?? AGGREGATE_CLIENT_UNKNOWN;

  const platformUpsert = db.prepare(`
    INSERT INTO request_daily_platform (day, platform, total_requests, success_count, error_count, canceled_count, chat_count, embedding_count, input_tokens, output_tokens, cached_tokens, success_input_tokens, success_output_tokens, success_cached_tokens, latency_sum_ms, latency_count, ttfb_sum_ms, ttfb_count, pinned_count, pin_honored_count, tps_sum, tps_count)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, platform) DO UPDATE SET
      total_requests = total_requests + 1,
      success_count = success_count + ?,
      error_count = error_count + ?,
      canceled_count = canceled_count + ?,
      chat_count = chat_count + ?,
      embedding_count = embedding_count + ?,
      input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?,
      cached_tokens = cached_tokens + ?,
      success_input_tokens = success_input_tokens + ?,
      success_output_tokens = success_output_tokens + ?,
      success_cached_tokens = success_cached_tokens + ?,
      latency_sum_ms = latency_sum_ms + ?,
      latency_count = latency_count + 1,
      ttfb_sum_ms = ttfb_sum_ms + ?,
      ttfb_count = ttfb_count + ?,
      pinned_count = pinned_count + ?,
      pin_honored_count = pin_honored_count + ?,
      tps_sum = tps_sum + ?,
      tps_count = tps_count + ?
  `);
  const modelUpsert = db.prepare(`
    INSERT INTO request_daily_model (day, platform, model_id, total_requests, success_count, error_count, canceled_count, chat_count, embedding_count, input_tokens, output_tokens, cached_tokens, success_input_tokens, success_output_tokens, success_cached_tokens, latency_sum_ms, latency_count, ttfb_sum_ms, ttfb_count, pinned_count, pin_honored_count, tps_sum, tps_count)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, platform, model_id) DO UPDATE SET
      total_requests = total_requests + 1,
      success_count = success_count + ?,
      error_count = error_count + ?,
      canceled_count = canceled_count + ?,
      chat_count = chat_count + ?,
      embedding_count = embedding_count + ?,
      input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?,
      cached_tokens = cached_tokens + ?,
      success_input_tokens = success_input_tokens + ?,
      success_output_tokens = success_output_tokens + ?,
      success_cached_tokens = success_cached_tokens + ?,
      latency_sum_ms = latency_sum_ms + ?,
      latency_count = latency_count + 1,
      ttfb_sum_ms = ttfb_sum_ms + ?,
      ttfb_count = ttfb_count + ?,
      pinned_count = pinned_count + ?,
      pin_honored_count = pin_honored_count + ?,
      tps_sum = tps_sum + ?,
      tps_count = tps_count + ?
  `);
  const clientUpsert = db.prepare(`
    INSERT INTO request_daily_client (day, client_agent, total_requests, success_count, error_count, canceled_count, chat_count, embedding_count, input_tokens, output_tokens, cached_tokens, success_input_tokens, success_output_tokens, success_cached_tokens, latency_sum_ms, latency_count, ttfb_sum_ms, ttfb_count, pinned_count, pin_honored_count, tps_sum, tps_count, max_created_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, client_agent) DO UPDATE SET
      total_requests = total_requests + 1,
      success_count = success_count + ?,
      error_count = error_count + ?,
      canceled_count = canceled_count + ?,
      chat_count = chat_count + ?,
      embedding_count = embedding_count + ?,
      input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?,
      cached_tokens = cached_tokens + ?,
      success_input_tokens = success_input_tokens + ?,
      success_output_tokens = success_output_tokens + ?,
      success_cached_tokens = success_cached_tokens + ?,
      latency_sum_ms = latency_sum_ms + ?,
      latency_count = latency_count + 1,
      ttfb_sum_ms = ttfb_sum_ms + ?,
      ttfb_count = ttfb_count + ?,
      pinned_count = pinned_count + ?,
      pin_honored_count = pin_honored_count + ?,
      tps_sum = tps_sum + ?,
      tps_count = tps_count + ?,
      max_created_at = CASE WHEN ? > max_created_at THEN ? ELSE max_created_at END
  `);
  const keyUpsert = db.prepare(`
    INSERT INTO request_daily_key (day, key_id, total_requests, success_count, error_count, canceled_count, chat_count, embedding_count, input_tokens, output_tokens, cached_tokens, success_input_tokens, success_output_tokens, success_cached_tokens, latency_sum_ms, latency_count, ttfb_sum_ms, ttfb_count, pinned_count, pin_honored_count, tps_sum, tps_count)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, key_id) DO UPDATE SET
      total_requests = total_requests + 1,
      success_count = success_count + ?,
      error_count = error_count + ?,
      canceled_count = canceled_count + ?,
      chat_count = chat_count + ?,
      embedding_count = embedding_count + ?,
      input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?,
      cached_tokens = cached_tokens + ?,
      success_input_tokens = success_input_tokens + ?,
      success_output_tokens = success_output_tokens + ?,
      success_cached_tokens = success_cached_tokens + ?,
      latency_sum_ms = latency_sum_ms + ?,
      latency_count = latency_count + 1,
      ttfb_sum_ms = ttfb_sum_ms + ?,
      ttfb_count = ttfb_count + ?,
      pinned_count = pinned_count + ?,
      pin_honored_count = pin_honored_count + ?,
      tps_sum = tps_sum + ?,
      tps_count = tps_count + ?
  `);

  const common = [
    success, error, canceled, chat, embedding,
    fields.inputTokens, fields.outputTokens, fields.cachedTokens,
    successInput, successOutput, successCached,
    fields.latencyMs, ttfb, ttfbCount, pinned, honored, tps, tpsQualify,
  ];
  platformUpsert.run(day, fields.platform, ...common, ...common);
  modelUpsert.run(day, fields.platform, fields.modelId, ...common, ...common);
  clientUpsert.run(day, clientAgent, ...common, createdAt, ...common, createdAt, createdAt);
  if (fields.keyId != null) {
    keyUpsert.run(day, fields.keyId, ...common, ...common);
  }
}

export function rebuildDayAggregates(db: Db, day: string): void {
  db.prepare('DELETE FROM request_daily_platform WHERE day = ?').run(day);
  db.prepare('DELETE FROM request_daily_model WHERE day = ?').run(day);
  db.prepare('DELETE FROM request_daily_client WHERE day = ?').run(day);
  db.prepare('DELETE FROM request_daily_key WHERE day = ?').run(day);

  db.prepare(`
    INSERT INTO request_daily_platform (day, platform, total_requests, success_count, error_count, canceled_count, chat_count, embedding_count, input_tokens, output_tokens, cached_tokens, success_input_tokens, success_output_tokens, success_cached_tokens, latency_sum_ms, latency_count, ttfb_sum_ms, ttfb_count, pinned_count, pin_honored_count, tps_sum, tps_count)
    SELECT ?, platform, ${AGGREGATE_METRIC_SELECT}
    FROM requests
    WHERE substr(created_at, 1, 10) = ?
    GROUP BY platform
  `).run(day, day);

  db.prepare(`
    INSERT INTO request_daily_model (day, platform, model_id, total_requests, success_count, error_count, canceled_count, chat_count, embedding_count, input_tokens, output_tokens, cached_tokens, success_input_tokens, success_output_tokens, success_cached_tokens, latency_sum_ms, latency_count, ttfb_sum_ms, ttfb_count, pinned_count, pin_honored_count, tps_sum, tps_count)
    SELECT ?, platform, model_id, ${AGGREGATE_METRIC_SELECT}
    FROM requests
    WHERE substr(created_at, 1, 10) = ?
    GROUP BY platform, model_id
  `).run(day, day);

  db.prepare(`
    INSERT INTO request_daily_client (day, client_agent, total_requests, success_count, error_count, canceled_count, chat_count, embedding_count, input_tokens, output_tokens, cached_tokens, success_input_tokens, success_output_tokens, success_cached_tokens, latency_sum_ms, latency_count, ttfb_sum_ms, ttfb_count, pinned_count, pin_honored_count, tps_sum, tps_count, max_created_at)
    SELECT ?, COALESCE(client_agent, 'unknown'), ${AGGREGATE_METRIC_SELECT}, MAX(created_at)
    FROM requests
    WHERE substr(created_at, 1, 10) = ?
    GROUP BY COALESCE(client_agent, 'unknown')
  `).run(day, day);

  db.prepare(`
    INSERT INTO request_daily_key (day, key_id, total_requests, success_count, error_count, canceled_count, chat_count, embedding_count, input_tokens, output_tokens, cached_tokens, success_input_tokens, success_output_tokens, success_cached_tokens, latency_sum_ms, latency_count, ttfb_sum_ms, ttfb_count, pinned_count, pin_honored_count, tps_sum, tps_count)
    SELECT ?, key_id, ${AGGREGATE_METRIC_SELECT}
    FROM requests
    WHERE key_id IS NOT NULL AND substr(created_at, 1, 10) = ?
    GROUP BY key_id
  `).run(day, day);
}