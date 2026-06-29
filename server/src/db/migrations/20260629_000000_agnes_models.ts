import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run('agnes', 'agnes-2.0-flash', 'Agnes 2.0 Flash', 7, 3, 'Large', 20, null, null, null, '~50-100M', 524288, 1, 1, 1);
  insert.run('agnes', 'agnes-1.5-flash', 'Agnes 1.5 Flash', 9, 3, 'Medium', 20, null, null, null, '~50-100M', 131072, 1, 0, 1);

  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'agnes'`).run();

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority)
    SELECT id, 9999 FROM models WHERE platform = 'agnes' AND model_id IN ('agnes-2.0-flash', 'agnes-1.5-flash')
    AND id NOT IN (SELECT model_db_id FROM fallback_config)
  `).run();

  const insertMedia = db.prepare(`
    INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertMedia.run('agnes', 'agnes-image-2.0-flash', 'Agnes Image 2.0 Flash', 'image', 50, 1, 'Free - 1K/2K up to 20 RPM');
  insertMedia.run('agnes', 'agnes-image-2.1-flash', 'Agnes Image 2.1 Flash', 'image', 49, 1, 'Free - 1K/2K up to 20 RPM');

  db.prepare(`UPDATE media_models SET enabled = 1 WHERE platform = 'agnes'`).run();
}

export function down(db: Database.Database): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'agnes'`).run();
  db.prepare(`UPDATE media_models SET enabled = 0 WHERE platform = 'agnes'`).run();
}
