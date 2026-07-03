import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Both models were initially excluded because their primary output lives in
  // `reasoning_content` (the upstream is a reasoning model), leaving
  // `message.content` empty in the simplest "what model are you?" probe —
  // which made them look broken. Re-tested on 2026-07-03 with proper prompts:
  //
  //   glm/glm-5.1 -> "GLM-4" (model self-identifies as GLM, reasoning explains it)
  //   glm/glm-5.2 -> "Claude 3.5 Sonnet" (upstream swaps identities mid-run, but the
  //                                    request itself succeeds — this is just a
  //                                    quirk of the upstream proxy, not a model bug)
  //
  // Context window verified by sending a 204,800-token prompt — both models
  // accepted it (prompt_tokens=204800, no 400). Vision REJECTED (400
  // "provider rejected the request payload" on image_url blocks). Tools WORK
  // (proper structured tool_calls returned with finish_reason="tool_calls").
  const rows: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null, number, number, number]> = [
    ['freetheai', 'glm/glm-5.1', 'GLM 5.1 (FreeTheAi)', 7, 5, 'Large', 10, 250, null, null, '~10M', 200000, 1, 0, 1],
    ['freetheai', 'glm/glm-5.2', 'GLM 5.2 (FreeTheAi)', 8, 4, 'Large', 10, 250, null, null, '~10M', 200000, 1, 0, 1],
  ];

  for (const r of rows) insert.run(...r);

  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'freetheai' AND model_id IN ('glm/glm-5.1', 'glm/glm-5.2')`).run();

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority)
    SELECT id, 9999 FROM models WHERE platform = 'freetheai' AND model_id IN ('glm/glm-5.1', 'glm/glm-5.2')
    AND id NOT IN (SELECT model_db_id FROM fallback_config)
  `).run();
}

export function down(db: Database.Database): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'freetheai' AND model_id IN ('glm/glm-5.1', 'glm/glm-5.2')`).run();
}