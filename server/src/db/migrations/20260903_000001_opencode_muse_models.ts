// Migration: add OpenCode Zen free roster — Meta Muse Spark Contributor models
// Created: 2026-09-03
//
// Muse Spark 1.2/1.3 Contributor Free are Meta's multimodal reasoning models
// (1M context, text+image+file+audio+video in) served FREE on the OpenCode Zen
// anonymous/IP-rotated tier (opencode.ai/zen/v1). Confirmed 2026-09-03 on the
// public /v1/models list and the official pricing table ("Free Free Free").
// Contributor tier = heavily discounted token pricing in exchange for
// permission to train future Meta models on your prompts/completions.
//
// DOWN: reversible — rows are disabled, matching the roster-rotate pattern.

import type { Db } from '../types.js';
import { applyModelPricing } from '../model-pricing.js';

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES ('opencode', ?, ?, ?, ?, ?, 20, 200, null, null, '~500M', ?, 1, ?, 1)
  `);

  insert.run('muse-spark-1.3-contributor-free', 'Muse Spark 1.3 Contributor Free (OpenCode Zen)', 7, 4, 'Frontier', 1000000, 1);
  insert.run('muse-spark-1.2-contributor-free', 'Muse Spark 1.2 Contributor Free (OpenCode Zen)', 6, 4, 'Large', 1000000, 1);

  db.prepare(`
    UPDATE models SET enabled = 1
     WHERE platform = 'opencode' AND model_id IN ('muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free')
  `).run();

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority)
    SELECT id, 9999 FROM models WHERE platform = 'opencode'
    AND model_id IN ('muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free')
    AND id NOT IN (SELECT model_db_id FROM fallback_config)
  `).run();

  applyModelPricing(db);

  const profiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC').all() as { id: number }[];
  const missing = db.prepare(`
    SELECT m.id, f.enabled
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
     WHERE m.platform = 'opencode'
       AND m.model_id IN ('muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free')
       AND pm.id IS NULL
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
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE platform = 'opencode' AND model_id IN ('muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free')
  `).run();
}