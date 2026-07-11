import type Database from 'better-sqlite3';

export function up(db: Db): void {
  db.prepare(`UPDATE models SET monthly_token_budget = '~500M' WHERE platform = 'opencode' AND monthly_token_budget = '~6M'`).run();
}

export function down(db: Database.Database): void {
  db.prepare(`UPDATE models SET monthly_token_budget = '~6M' WHERE platform = 'opencode' AND monthly_token_budget = '~500M'`).run();
}
