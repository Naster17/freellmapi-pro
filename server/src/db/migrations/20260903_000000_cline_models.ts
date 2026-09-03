// Migration: add the Cline (usage-billing) platform and its free-promo models
// Created: 2026-09-03
//
// The roster mirrors the live free tier from
// https://api.cline.bot/api/v1/ai/cline/recommended-models ("free" list,
// probed 2026-09-03). Cline rotates free promotions without notice — dead ids
// 404 "model not found" on /chat/completions — so a rotation is handled by
// disabling rows here (or via catalog-sync) rather than by code changes.
//
// DOWN: irreversible-ish — rows are removed; fallback/profile rows are simply
// gone, which is the correct inverse of the INSERT OR IGNORE seed.

import type { Db } from '../types.js';
import { applyModelPricing } from '../model-pricing.js';

/** Seed rows: [model_id, display_name, intelligence_rank, speed_rank, size_label, context_window] */
const CLINE_FREE_MODELS: [string, string, number, number, string, number | null][] = [
  ['z-ai/glm-5.3-flash', 'GLM 5.3 Flash (Cline)', 6, 3, 'Large', 1_310_720],
  ['deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash (Cline)', 7, 4, 'Large', 1_048_576],
  ['cline-free/longcat-2.0', 'LongCat 2.0 (Cline Free)', 8, 6, 'Frontier', null],
  ['poolside/laguna-s-2.1:free', 'Laguna S 2.1 (Cline Free)', 7, 5, 'Large', 262_144],
];

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES ('cline', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'free promo (quota per account)', ?, 1, ?, 1)
  `);

  // glm-5.3-flash and deepseek-v4-flash are natively multimodal per the
  // upstream catalog; the cline-free/ and :free aliases report no vision.
  const visionByModel = new Set(['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4-flash']);

  for (const [modelId, displayName, intel, speed, size, ctx] of CLINE_FREE_MODELS) {
    insert.run(modelId, displayName, intel, speed, size, ctx, visionByModel.has(modelId) ? 1 : 0);
  }

  // Idempotent re-enable: down() only disables rows, so a down→up round trip
  // must restore them (INSERT OR IGNORE alone would leave them disabled).
  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'cline'`).run();

  // Register the new models in the default fallback chain (low priority —
  // free promo quota is the safety net, not the primary route).
  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority)
    SELECT id, 9000 + ROW_NUMBER() OVER (ORDER BY id) FROM models
    WHERE platform = 'cline'
    AND id NOT IN (SELECT model_db_id FROM fallback_config)
  `).run();

  applyModelPricing(db);

  // Profile backfill: every existing profile gets the new models appended at
  // the end of its chain (same pattern as the OpenCode/Modal migrations).
  const profiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC').all() as { id: number }[];
  const missing = db.prepare(`
    SELECT m.id, f.enabled
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
     WHERE m.platform = 'cline' AND pm.id IS NULL
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
  // Keep fallback_config / profile_models rows (their priorities are
  // position-dependent and would not round-trip if deleted and re-seeded);
  // disabling the models is enough to take the platform out of routing.
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'cline'`).run();
}
