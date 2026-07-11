import type Database from 'better-sqlite3';

export function up(db: Db): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'nvidia' AND model_id = 'z-ai/glm-5.1'`).run();
}

export function down(db: Database.Database): void {
  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'nvidia' AND model_id = 'z-ai/glm-5.1'`).run();
}
