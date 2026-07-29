import { getDb } from '../db/index.js';
import { pruneRequestAnalytics } from '../services/request-retention.js';
import { getClientContext } from './client-context.js';
import type { Request } from 'express';
import { noteRequestRowId, type RequestTrace } from './attempt-trace.js';

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

function hourKey(createdAt: string): string {
  return createdAt.slice(0, 13) + ':00:00';
}

function incrementSetting(db: LogTx, key: string, delta: number): void {
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
  servedModel: string | null = null,
) {
  try {
    const db = getDb();
    // Caller identity from the request-scoped context (set by the express
    // middleware); null when logging happens outside an HTTP request.
    const client = getClientContext();
    const tx = db.transaction(() => {
      const insert = db.prepare(`
        INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model, served_model, client_ip, client_user_agent, client_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error, ttfbMs, requestedModel, servedModel, client.ip, client.userAgent, client.agent);

      // Report the row id back to the fallback loop's attempt trace (if one is
      // active): the LAST id noted during a loop run is the terminal row the
      // per-attempt batch is keyed to. No-op outside a fallback-loop run.
      if (insert.lastInsertRowid != null) noteRequestRowId(insert.lastInsertRowid);

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

// Persist a finished attempt trace as one small insert batch keyed to the
// terminal `requests` row of the failover ladder (the success row, a committed
// mid-stream error row, or the last per-attempt failure row). Called once per
// request by the fallback loop AFTER the response is finished, so the write is
// off the client's latency path. Zero-failure single-attempt successes write
// exactly one 'ok' row; a trace with no parent row (e.g. a client abort before
// any attempt was logged) writes nothing — consistent with the `requests`
// table, which records nothing for those either.
export function persistRequestAttempts(trace: RequestTrace): void {
  if (trace.records.length === 0 || trace.lastRequestRowId == null) return;
  try {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO request_attempts (request_id, ordinal, platform, model_id, key_ordinal, outcome, start_offset_ms, duration_ms, error_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const r of trace.records) {
        insert.run(trace.lastRequestRowId, r.ordinal, r.platform, r.modelId, r.keyOrdinal, r.outcome, r.startOffsetMs, r.durationMs, r.errorSummary);
      }
    });
    tx();
  } catch (e) {
    console.error('Failed to persist request attempts:', e);
  }
}
