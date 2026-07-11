import type { Db } from '../types.js';

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Each row was confirmed live (HTTP 200 + non-empty content) against
  // g4f.space on 2026-07-02. Rank values follow the same 1-10 ordinal scale
  // used by every other platform. Rate limits verified from API headers:
  //   x-ratelimit-limit-requests: 10 (per model per minute)
  //   x-ratelimit-limit-tokens: 100000 (per model per minute)
  //   Global: 1 req/sec across all models (429 on violation)
  //   x-user-tier: new
  // Context windows are from official model cards/docs — g4f proxies the real models.
  const rows: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null, number, number, number]> = [
    ['g4f', 'gpt-5.5',                'GPT-5.5 (g4f)',                8, 4, 'Large',  10, null, 100000, null, '~10M',    400000, 1, 1, 1],
    ['g4f', 'gpt-5.4',                'GPT-5.4 (g4f)',                7, 4, 'Large',  10, null, 100000, null, '~10M',   1050000, 1, 1, 1],
    ['g4f', 'openai/gpt-5',           'GPT-5 (g4f)',                  9, 3, 'Large',  10, null, 100000, null, '~10M',    400000, 1, 1, 1],
    ['g4f', 'gpt-4o-mini',            'GPT-4o mini (g4f)',            6, 5, 'Medium', 10, null, 100000, null, '~10M',    128000, 1, 1, 1],
    ['g4f', 'gpt-oss-120b',           'GPT-OSS 120B (g4f)',           8, 4, 'Large',  10, null, 100000, null, '~10M',    131072, 1, 0, 1],
    ['g4f', 'deepseek-v4-pro',        'DeepSeek V4 Pro (g4f)',        8, 5, 'Large',  10, null, 100000, null, '~10M',   1000000, 1, 0, 1],
    ['g4f', 'kimi-k2.7-code',         'Kimi K2.7 Coder (g4f)',        7, 5, 'Large',  10, null, 100000, null, '~10M',    262144, 1, 1, 1],
    ['g4f', 'kimi-k2.6',              'Kimi K2.6 (g4f)',              6, 4, 'Large',  10, null, 100000, null, '~10M',    262144, 1, 1, 1],
    ['g4f', 'glm-5.1',                'GLM 5.1 (g4f)',                7, 5, 'Large',  10, null, 100000, null, '~10M',    200000, 1, 0, 1],
    ['g4f', 'zai-org/GLM-5.1',        'GLM 5.1 Modelscope (g4f)',     7, 4, 'Large',  10, null, 100000, null, '~10M',    200000, 1, 0, 1],
    ['g4f', 'qwen-coder',             'Qwen Coder (g4f)',             6, 6, 'Medium', 10, null, 100000, null, '~10M',    262144, 1, 0, 1],
    ['g4f', 'qwen3.7-max',            'Qwen 3.7 Max (g4f)',           8, 4, 'Large',  10, null, 100000, null, '~10M',   1000000, 1, 0, 1],
    ['g4f', 'qwen3.6-plus',           'Qwen 3.6 Plus (g4f)',          7, 4, 'Large',  10, null, 100000, null, '~10M',   1000000, 1, 0, 1],
    ['g4f', 'minimaxai/minimax-m3',   'minimax m3 (g4f)',             6, 5, 'Large',  10, null, 100000, null, '~10M',   1000000, 1, 1, 1],
    ['g4f', 'gemini-3.1-flash-lite',  'Gemini 3.1 Flash Lite (g4f)',  6, 8, 'Medium', 10, null, 100000, null, '~10M',   1048576, 1, 1, 1],
    ['g4f', 'zai-org/GLM-5.2',        'GLM 5.2 Modelscope (g4f)',     8, 4, 'Large',  10, null, 100000, null, '~10M',   1000000, 1, 0, 1],
    ['g4f', 'claude-opus-4-6-thinking','Claude Opus 4.6 Thinking (g4f)', 9, 2, 'Large', 10, null, 100000, null, '~10M',  1000000, 1, 1, 1],
    ['g4f', 'claude-sonnet-4-6',      'Claude Sonnet 4.6 (g4f)',      8, 3, 'Large',  10, null, 100000, null, '~10M',   1000000, 1, 1, 1],
  ];

  for (const r of rows) insert.run(...r);

  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'g4f'`).run();

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority)
    SELECT id, 9999 FROM models WHERE platform = 'g4f'
    AND id NOT IN (SELECT model_db_id FROM fallback_config)
  `).run();
}

export function down(db: Db): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'g4f'`).run();
}
