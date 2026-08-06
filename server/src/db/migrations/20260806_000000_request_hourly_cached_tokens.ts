// Migration: track cached (prompt-cache-hit) tokens in the hourly aggregate
// Created: 2026-08-06
//
// DOWN: reversible
//
// The Requests-by-model breakdown already summed requests.cached_tokens, but
// the watermark was never written by logRequest, so it stayed 0 in every
// surface (by-model, recent-calls, and now the summary Cached-tokens stat).
// This adds the column to request_hourly (mirroring input/output_tokens so the
// summary reads one source) and backfills from raw requests rows.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'request_hourly', 'cached_tokens')) {
    db.prepare('ALTER TABLE request_hourly ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0').run();
  }

  db.prepare(`
    UPDATE request_hourly
    SET cached_tokens = (
      SELECT COALESCE(SUM(cached_tokens), 0)
      FROM requests
      WHERE substr(created_at, 1, 13) || ':00:00' = request_hourly.hour
    )
  `).run();

  const total = db.prepare(`
    SELECT COALESCE(SUM(cached_tokens), 0) AS total
    FROM requests
  `).get() as { total: number };
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run('total_cached_tokens', String(total.total));
}

export function down(db: Db): void {
  if (hasColumn(db, 'request_hourly', 'cached_tokens')) {
    db.prepare('ALTER TABLE request_hourly DROP COLUMN cached_tokens').run();
  }
  db.prepare(`DELETE FROM settings WHERE key = 'total_cached_tokens'`).run();
}