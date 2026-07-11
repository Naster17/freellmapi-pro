import type Database from 'better-sqlite3';

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Both models were initially excluded because of transient upstream failures
  // (per-minute rate limit hits during the first test run). Re-tested on
  // 2026-07-03 from the Discord "Top 10 models by successful request count"
  // leaderboard — they are #3 (194,957 reqs) and #8 (73,329 reqs) respectively,
  // so they are clearly production-ready, just flaky on the first probe.
  //
  // Verified behavior:
  //   opc/deepseek-v4-flash-free -> reasoning model, output in reasoning_content
  //     - Self-id: emits reasoning then short text reply
  //     - Vision: NO (400 "provider rejected the request payload" on image_url)
  //     - Tools: YES (proper structured tool_calls, finish_reason="tool_calls")
  //     - Context: 160K tokens accepted (verified via prompt_tokens=160085)
  //
  //   olm/deepseek-v4-pro -> non-reasoning, content directly populated
  //     - Self-id: "DeepSeek-V3" or "Claude 3.5 Sonnet" (upstream identity quirk,
  //       varies per request)
  //     - Vision: NO (400 "provider rejected the request payload" on image_url)
  //     - Tools: YES (proper structured tool_calls)
  //     - Context: 160K tokens accepted (verified via prompt_tokens=160006)
  //
  // Official spec context windows (DeepSeek docs):
  //   DeepSeek V4 Flash: 128K (we list 131072)
  //   DeepSeek V4 Pro:   1M  (we list 1000000, but upstream caps around 160K
  //                            in practice — using the official number to match
  //                            the DeepSeek API docs)
  const rows: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null, number, number, number]> = [
    ['freetheai', 'opc/deepseek-v4-flash-free', 'DeepSeek V4 Flash Free (FreeTheAi)', 6, 8, 'Large', 10, 250, null, null, '~10M', 131072, 1, 0, 1],
    ['freetheai', 'olm/deepseek-v4-pro',         'DeepSeek V4 Pro (FreeTheAi)',         8, 4, 'Large', 10, 250, null, null, '~10M', 1000000, 1, 0, 1],
  ];

  for (const r of rows) insert.run(...r);

  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'freetheai' AND model_id IN ('opc/deepseek-v4-flash-free', 'olm/deepseek-v4-pro')`).run();

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority)
    SELECT id, 9999 FROM models WHERE platform = 'freetheai' AND model_id IN ('opc/deepseek-v4-flash-free', 'olm/deepseek-v4-pro')
    AND id NOT IN (SELECT model_db_id FROM fallback_config)
  `).run();
}

export function down(db: Database.Database): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'freetheai' AND model_id IN ('opc/deepseek-v4-flash-free', 'olm/deepseek-v4-pro')`).run();
}