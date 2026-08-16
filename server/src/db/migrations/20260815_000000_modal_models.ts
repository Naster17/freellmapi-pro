import type { Db } from '../types.js';
import { applyModelPricing } from '../model-pricing.js';

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const rows: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null, number, number, number]> = [
    ['modal', 'Qwen/Qwen3.8-2.4T-A95B', 'Qwen3.8 2.4T A95B (Modal)', 1, 6, 'Frontier', null, null, null, null, '$30 / key / 30d', 1000000, 1, 0, 1],
    ['modal', 'moonshotai/Kimi-K3',      'Kimi K3 (Modal)',          2, 5, 'Frontier', null, null, null, null, '$30 / key / 30d', 1048576, 1, 1, 1],
  ];

  for (const row of rows) insert.run(...row);

  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'modal'`).run();
  applyModelPricing(db);

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority)
    SELECT id, 9999 FROM models WHERE platform = 'modal'
    AND id NOT IN (SELECT model_db_id FROM fallback_config)
  `).run();

  const profiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC').all() as { id: number }[];
  const missing = db.prepare(`
    SELECT m.id, f.enabled
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
     WHERE m.platform = 'modal' AND pm.id IS NULL
     ORDER BY f.priority, m.id
  `);
  const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = ?');
  const insertProfileModel = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');

  for (const profile of profiles) {
    const rows = missing.all(profile.id) as { id: number; enabled: number }[];
    if (rows.length === 0) continue;
    const max = maxPriority.get(profile.id) as { max_priority: number };
    rows.forEach((row, index) => {
      insertProfileModel.run(profile.id, row.id, max.max_priority + index + 1, row.enabled);
    });
  }
}

export function down(db: Db): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'modal'`).run();
}
