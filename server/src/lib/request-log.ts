import { getDb } from '../db/index.js';
import { pruneRequestAnalytics } from '../services/request-retention.js';
import type { Request } from 'express';

export function normalizeClientIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let ip = value.split(',')[0]?.trim() ?? '';
  if (!ip) return null;

  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  }
  ip = ip.replace(/^::ffff:/i, '');
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return '127.0.0.1';
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) return ip.replace(/:\d+$/, '');
  return ip;
}

export function getClientIp(req: Request): string | null {
  return normalizeClientIp(req.ip ?? req.socket.remoteAddress ?? null);
}

type LogTx = ReturnType<typeof getDb>;

// SQLite stores created_at as 'YYYY-MM-DD HH:MM:SS' (UTC). Truncate to hour
// for the aggregate upsert. Duplicated from the migration helper so this
// module has no import dependency on db/migrations/.
function hourKey(createdAt: string): string {
  return createdAt.slice(0, 13) + ':00:00';
}

function incrementSetting(db: LogTx, key: string, delta: number): void {
  // Read-then-write inside the same transaction; safe because better-sqlite3
  // is synchronous and serialized at the connection level. ON CONFLICT keeps
  // the first ever insert without a prior SELECT.
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)
  `).run(key, String(delta), delta);
}

function setSettingIfMissing(db: LogTx, key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(key, value);
}

// Append a row to the request analytics table. Shared by the chat proxy, the
// responses path, and the fusion panel so every served (or failed) sub-request
// is logged identically. Lives in a neutral lib module to avoid an import cycle
// between the fusion service and the proxy route that both call it.
//
// In addition to the raw row, we update two durable aggregates so analytics
// totals survive the raw-row prune (REQUEST_ANALYTICS_MAX_ROWS):
//   - request_hourly: per-hour bucket counts and tokens (max window = 30d).
//   - settings: lifetime totals (total_requests, total_input_tokens, total_output_tokens)
//     plus first_request_at (set on the first ever logged request).
// All upserts run in the same transaction so the aggregates never disagree
// with the raw row count.
export function logRequest(
  platform: string,
  modelId: string,
  keyId: number,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  ttfbMs: number | null = null,
  // The model id the client pinned; null for auto-routed requests. Lets
  // analytics split pinned vs auto traffic and detect failover overrides
  // (requested_model set but != model_id).
  requestedModel: string | null = null,
  clientIp: string | null = null,
  // Prompt tokens served from the upstream's prefix cache (cache-read hits).
  // Populated from the provider's usage frame (stream_options.include_usage)
  // after normalizeUsage() maps non-standard aliases (DeepSeek
  // prompt_cache_hit_tokens, Anthropic cache_read_input_tokens) into the
  // OpenAI-standard prompt_tokens_details.cached_tokens. 0 when the provider
  // does not support or report prompt caching. Stored for analytics so a
  // "cached" rate can be computed per model/provider.
  cachedTokens: number = 0,
) {
  try {
    const db = getDb();
    const tx = db.transaction(() => {
      const insert = db.prepare(`
        INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model, client_ip, cached_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error, ttfbMs, requestedModel, normalizeClientIp(clientIp), cachedTokens);

      const createdAt = db.prepare(`SELECT created_at FROM requests WHERE id = ?`).get(insert.lastInsertRowid) as { created_at: string } | undefined;
      const hour = hourKey(createdAt?.created_at ?? new Date().toISOString().slice(0, 19).replace('T', ' '));
      const isSuccess = status === 'success' ? 1 : 0;
      const isError = status === 'error' ? 1 : 0;

      db.prepare(`
        INSERT INTO request_hourly (hour, total_requests, success_count, error_count, input_tokens, output_tokens)
        VALUES (?, 1, ?, ?, ?, ?)
        ON CONFLICT(hour) DO UPDATE SET
          total_requests = total_requests + 1,
          success_count  = success_count + ?,
          error_count    = error_count + ?,
          input_tokens   = input_tokens + ?,
          output_tokens  = output_tokens + ?
      `).run(hour, isSuccess, isError, inputTokens, outputTokens, isSuccess, isError, inputTokens, outputTokens);

      incrementSetting(db, 'total_requests', 1);
      incrementSetting(db, 'total_input_tokens', inputTokens);
      incrementSetting(db, 'total_output_tokens', outputTokens);
      if (createdAt?.created_at) {
        setSettingIfMissing(db, 'first_request_at', createdAt.created_at);
      }
    });
    tx();
    pruneRequestAnalytics({ db });
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
