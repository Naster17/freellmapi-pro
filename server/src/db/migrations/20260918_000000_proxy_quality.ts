import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(proxies)').all() as { name: string }[];
  const names = new Set(columns.map(col => col.name));
  if (!names.has('success_count')) {
    db.prepare('ALTER TABLE proxies ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!names.has('failure_count')) {
    db.prepare('ALTER TABLE proxies ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!names.has('latency_ema_ms')) {
    db.prepare('ALTER TABLE proxies ADD COLUMN latency_ema_ms REAL').run();
  }
}

export function down(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(proxies)').all() as { name: string }[];
  const names = new Set(columns.map(col => col.name));
  for (const col of ['latency_ema_ms', 'failure_count', 'success_count']) {
    if (names.has(col)) db.prepare(`ALTER TABLE proxies DROP COLUMN ${col}`).run();
  }
}
