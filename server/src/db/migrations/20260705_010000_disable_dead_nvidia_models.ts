import type { Db } from '../types.js';

export function up(db: Db): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'nvidia' AND model_id = 'z-ai/glm-5.1'`).run();
}

export function down(db: Db): void {
  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'nvidia' AND model_id = 'z-ai/glm-5.1'`).run();
}
