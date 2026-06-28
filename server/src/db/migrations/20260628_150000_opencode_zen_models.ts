import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  db.prepare(`UPDATE models SET enabled = 1, context_window = 200000 WHERE platform = 'opencode' AND model_id = 'minimax-m3-free'`).run();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run('opencode', 'north-mini-code-free', 'North Mini Code Free (OpenCode Zen)', 6, 4, 'Medium', 20, 200, null, null, '~500M', 128000, 1, 0, 1);
  insert.run('opencode', 'qwen3.6-plus-free', 'Qwen3.6 Plus Free (OpenCode Zen)', 5, 4, 'Frontier', 20, 200, null, null, '~500M', 131072, 1, 0, 1);

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority)
    SELECT id, 9999 FROM models WHERE platform = 'opencode' AND model_id IN ('north-mini-code-free', 'qwen3.6-plus-free')
    AND id NOT IN (SELECT model_db_id FROM fallback_config)
  `).run();
}

export function down(db: Database.Database): void {
  db.prepare(`UPDATE models SET enabled = 0, context_window = 131072 WHERE platform = 'opencode' AND model_id = 'minimax-m3-free'`).run();
  db.prepare(`DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'opencode' AND model_id IN ('north-mini-code-free', 'qwen3.6-plus-free'))`).run();
  db.prepare(`DELETE FROM models WHERE platform = 'opencode' AND model_id IN ('north-mini-code-free', 'qwen3.6-plus-free')`).run();
}
