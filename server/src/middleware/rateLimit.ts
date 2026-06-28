import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index.js';

// Per-IP fixed-window rate limiter for the public /v1 proxy (#35, item #6).
//
// The /v1 surface authenticates with the unified API key but has no password
// login like the dashboard does, so without this an attacker who can reach the
// server could brute-force the key or flood upstream providers. This caps how
// many requests a single client IP can make per minute and returns a standard
// OpenAI-shaped 429 once the cap is exceeded.
//
// FreeLLMAPI is a single-user tool, so the default ceiling is generous. Tune it
// with PROXY_RATE_LIMIT_RPM (requests per minute per IP); set it to 0 to turn
// rate limiting off entirely.

const WINDOW_MS = 60_000;
const DEFAULT_RPM = 120;
// Bound the IP map so a flood of distinct (e.g. spoofed) source addresses can't
// grow it without limit; expired entries are pruned opportunistically.
const MAX_TRACKED_IPS = 10_000;

interface WindowState {
  count: number;
  resetAt: number;
}

function parseLimit(): number {
  const raw = process.env.PROXY_RATE_LIMIT_RPM;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RPM;
  return Math.floor(n);
}

export function createProxyRateLimiter(rpmLimit?: number) {
  const limit = rpmLimit !== undefined ? Math.floor(Math.max(0, rpmLimit)) : parseLimit();
  const windows = new Map<string, WindowState>();
  let persistedUnavailable = false;

  function usePersistentWindow(ip: string, now: number): WindowState | null {
    if (persistedUnavailable) return null;
    try {
      const db = getDb();
      const row = db.prepare('SELECT count, reset_at_ms FROM proxy_rate_limit_windows WHERE ip = ?').get(ip) as { count: number; reset_at_ms: number } | undefined;
      const next = !row || now >= row.reset_at_ms
        ? { count: 1, resetAt: now + WINDOW_MS }
        : { count: row.count + 1, resetAt: row.reset_at_ms };

      db.prepare(`
        INSERT INTO proxy_rate_limit_windows (ip, count, reset_at_ms, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(ip) DO UPDATE SET
          count = excluded.count,
          reset_at_ms = excluded.reset_at_ms,
          updated_at = excluded.updated_at
      `).run(ip, next.count, next.resetAt);

      if (Math.random() < 0.01) {
        db.prepare('DELETE FROM proxy_rate_limit_windows WHERE reset_at_ms < ?').run(now - WINDOW_MS);
      }

      return next;
    } catch {
      persistedUnavailable = true;
      return null;
    }
  }

  return function proxyRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (limit === 0) {
      next();
      return;
    }

    const now = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    let state = usePersistentWindow(ip, now);
    if (!state) {
      state = windows.get(ip) ?? null;
      if (!state || now >= state.resetAt) {
        state = { count: 0, resetAt: now + WINDOW_MS };
        windows.set(ip, state);
      }
      state.count += 1;
    }

    if (windows.size > MAX_TRACKED_IPS) {
      for (const [key, value] of windows) {
        if (now >= value.resetAt) windows.delete(key);
      }
    }

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - state.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

    if (state.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          message: `Rate limit exceeded: more than ${limit} requests per minute. Retry in ${retryAfter}s.`,
          type: 'rate_limit_error',
        },
      });
      return;
    }

    next();
  };
}
