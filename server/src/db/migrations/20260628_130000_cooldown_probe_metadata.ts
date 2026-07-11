import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const row = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return row.some(c => c.name === column);
}

export function up(db: Db): void {
  if (!tableExists(db, 'rate_limit_cooldowns')) return;
  if (!columnExists(db, 'rate_limit_cooldowns', 'reason')) {
    db.prepare(`ALTER TABLE rate_limit_cooldowns ADD COLUMN reason TEXT`).run();
  }
  if (!columnExists(db, 'rate_limit_cooldowns', 'last_probe_at_ms')) {
    db.prepare(`ALTER TABLE rate_limit_cooldowns ADD COLUMN last_probe_at_ms INTEGER`).run();
  }
}

export function down(db: Database.Database): void {
  if (!tableExists(db, 'rate_limit_cooldowns')) return;
  try {
    db.prepare(`ALTER TABLE rate_limit_cooldowns DROP COLUMN reason`).run();
  } catch {}
  try {
    db.prepare(`ALTER TABLE rate_limit_cooldowns DROP COLUMN last_probe_at_ms`).run();
  } catch {}
}
