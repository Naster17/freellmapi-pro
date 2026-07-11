import type Database from 'better-sqlite3';

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // GLM-5.2 is the 2026-07-02 successor to GLM-5.1 on NVIDIA NIM (build.nvidia.com/z-ai/glm-5.2).
  // Verified from the NVIDIA model card:
  //   - 753B-param MoE with IndexShare sparse attention
  //   - 1,000,000-token context window (input and output)
  //   - text-only input, no vision support
  //   - tool calling supported, streaming supported
  //   - published under the NVIDIA Open Model Agreement (MIT-licensed weights on HF)
  //   - served via the standard NVIDIA NIM OpenAI-compatible endpoint
  //     (https://integrate.api.nvidia.com/v1), 40 RPM recurring free tier
  //
  // Placed at intelligenceRank 4 (one slot above GLM-5.1 at 5) — 5.2 wins
  // HLE 40.5 vs 31.0, AIME 99.2 vs 95.3, SWE-bench Pro 62.1 vs 58.4 per the
  // NVIDIA benchmark table, so it is unambiguously a tier-up, not a tie.
  const rows: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null, number, number, number]> = [
    ['nvidia', 'z-ai/glm-5.2', 'GLM-5.2 (NV)', 4, 10, 'Frontier', 40, null, null, null, '~3M (credits)', 1000000, 1, 0, 1],
  ];

  for (const r of rows) insert.run(...r);

  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'nvidia' AND model_id = 'z-ai/glm-5.2'`).run();

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority)
    SELECT id, 9999 FROM models WHERE platform = 'nvidia' AND model_id = 'z-ai/glm-5.2'
    AND id NOT IN (SELECT model_db_id FROM fallback_config)
  `).run();
}

export function down(db: Database.Database): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'nvidia' AND model_id = 'z-ai/glm-5.2'`).run();
}
