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

// Append a row to the request analytics table. Shared by the chat proxy, the
// responses path, and the fusion panel so every served (or failed) sub-request
// is logged identically. Lives in a neutral lib module to avoid an import cycle
// between the fusion service and the proxy route that both call it.
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
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model, client_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error, ttfbMs, requestedModel, normalizeClientIp(clientIp));
    pruneRequestAnalytics({ db });
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
