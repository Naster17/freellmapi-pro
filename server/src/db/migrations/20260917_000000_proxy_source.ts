import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(proxies)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'source')) {
    db.prepare("ALTER TABLE proxies ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'").run();
  }
  db.prepare("UPDATE proxies SET source = 'manual' WHERE source IS NULL OR source = ''").run();
}

export function down(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(proxies)').all() as { name: string }[];
  if (columns.some(col => col.name === 'source')) {
    db.prepare('ALTER TABLE proxies DROP COLUMN source').run();
  }
}
