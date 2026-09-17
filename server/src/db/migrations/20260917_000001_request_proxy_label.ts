import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'proxy_label')) {
    db.prepare('ALTER TABLE requests ADD COLUMN proxy_label TEXT').run();
  }
}

export function down(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (columns.some(col => col.name === 'proxy_label')) {
    db.prepare('ALTER TABLE requests DROP COLUMN proxy_label').run();
  }
}
