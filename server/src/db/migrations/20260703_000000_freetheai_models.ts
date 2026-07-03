import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Each row was confirmed live (HTTP 200 + non-empty content) against
  // api.freetheai.xyz on 2026-07-03. Rate limits verified from response headers:
  //   x-ratelimit-limit: 10 (per-minute requests)
  //   x-dailylimit-limit: 250 (daily success cap)
  //   x-concurrency-limit: 2
  // Context windows are from official model cards — FreeTheAi proxies real models.
  // Models that returned empty content or provider-unavailable are excluded.
  const rows: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null, number, number, number]> = [
    // vova/* — premium models (Anthropic, OpenAI, Google, etc.)
    ['freetheai', 'vova/gpt-5.5',                'GPT-5.5 (FreeTheAi)',             8, 4, 'Large',  10, 250, null, null, '~10M',    400000, 1, 1, 1],
    ['freetheai', 'vova/kimi-k2.5',              'Kimi K2.5 (FreeTheAi)',            6, 5, 'Large',  10, 250, null, null, '~10M',    131072, 1, 1, 1],
    ['freetheai', 'vova/mimo-v2.5',              'MiMo v2.5 (FreeTheAi)',            6, 5, 'Medium', 10, 250, null, null, '~10M',    131072, 1, 0, 1],
    ['freetheai', 'vova/mimo-v2.5-pro',          'MiMo v2.5 Pro (FreeTheAi)',        7, 4, 'Large',  10, 250, null, null, '~10M',    131072, 1, 0, 1],
    ['freetheai', 'vova/mimo-v2.5-pro-ultraspeed','MiMo v2.5 Pro UltraSpeed (FreeTheAi)', 7, 8, 'Large', 10, 250, null, null, '~10M', 131072, 1, 0, 1],
    ['freetheai', 'vova/minimax-m2.7',           'MiniMax M2.7 (FreeTheAi)',         6, 3, 'Large',  10, 250, null, null, '~10M',   1000000, 1, 0, 1],
    ['freetheai', 'vova/kimi-k2.7-code',         'Kimi K2.7 Coder (FreeTheAi)',      7, 5, 'Large',  10, 250, null, null, '~10M',    262144, 1, 1, 1],

    // mim/* — MiMo models
    ['freetheai', 'mim/mimo-v2.5',               'MiMo v2.5 (mim)',                  6, 5, 'Medium', 10, 250, null, null, '~10M',    131072, 1, 0, 1],
    ['freetheai', 'mim/mimo-v2.5-pro',           'MiMo v2.5 Pro (mim)',              7, 4, 'Large',  10, 250, null, null, '~10M',    131072, 1, 0, 1],

    // min/* — MiniMax
    ['freetheai', 'min/minimax-m3',              'MiniMax M3 (FreeTheAi)',           7, 4, 'Large',  10, 250, null, null, '~10M',   1000000, 1, 1, 1],

    // glm/* — Zhipu GLM
    ['freetheai', 'glm/glm-4.5',                'GLM 4.5 (FreeTheAi)',              5, 5, 'Medium', 10, 250, null, null, '~10M',    131072, 1, 0, 0],
    ['freetheai', 'glm/glm-4.5-air',            'GLM 4.5 Air (FreeTheAi)',          5, 6, 'Medium', 10, 250, null, null, '~10M',    131072, 1, 0, 0],
    ['freetheai', 'glm/glm-4.6',                'GLM 4.6 (FreeTheAi)',              6, 5, 'Medium', 10, 250, null, null, '~10M',    131072, 1, 0, 0],
    ['freetheai', 'glm/glm-4.7',                'GLM 4.7 (FreeTheAi)',              6, 5, 'Medium', 10, 250, null, null, '~10M',    131072, 1, 0, 0],

    // kai/* — Kilo/NVIDIA/StepFun/Poolside
    ['freetheai', 'kai/nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (FreeTheAi)', 7, 5, 'Large', 10, 250, null, null, '~10M', 131072, 1, 0, 1],
    ['freetheai', 'kai/openrouter/free',         'Nemotron 3 Ultra (FreeTheAi)',     8, 4, 'Large',  10, 250, null, null, '~10M',    131072, 1, 0, 1],
    ['freetheai', 'kai/stepfun/step-3.7-flash:free', 'Step 3.7 Flash (FreeTheAi)',   5, 7, 'Medium', 10, 250, null, null, '~10M',    131072, 1, 0, 0],
    ['freetheai', 'kai/poolside/laguna-xs-2.1:free', 'Laguna XS 2.1 (FreeTheAi)',   5, 6, 'Medium', 10, 250, null, null, '~10M',    131072, 1, 0, 0],

    // opc/* — OpenCode free models
    ['freetheai', 'opc/mimo-v2.5-free',          'MiMo v2.5 Free (FreeTheAi)',       6, 5, 'Medium', 10, 250, null, null, '~10M',    131072, 1, 0, 1],
    ['freetheai', 'opc/north-mini-code-free',    'North Mini Code (FreeTheAi)',       4, 7, 'Small',  10, 250, null, null, '~10M',     32768, 1, 0, 0],

    // bbl/* — Bubble models (responded but self-identified as different models)
    ['freetheai', 'bbl/gemini-2.5-flash-lite',   'Gemini 2.5 Flash Lite (bbl)',      6, 6, 'Medium', 10, 250, null, null, '~10M',   1048576, 1, 1, 1],
    ['freetheai', 'bbl/gemini-3.0-flash',         'Gemini 3.0 Flash (bbl)',           6, 6, 'Medium', 10, 250, null, null, '~10M',   1048576, 1, 1, 1],
    ['freetheai', 'bbl/gemini-3.1-flash-lite',    'Gemini 3.1 Flash Lite (bbl)',      6, 7, 'Medium', 10, 250, null, null, '~10M',   1048576, 1, 1, 1],
    ['freetheai', 'bbl/gemini-3.5-flash',          'Gemini 3.5 Flash (bbl)',           6, 6, 'Medium', 10, 250, null, null, '~10M',   1048576, 1, 1, 1],
    ['freetheai', 'bbl/gpt-5.5-mini',              'GPT-5.5 Mini (bbl)',               6, 6, 'Medium', 10, 250, null, null, '~10M',    400000, 1, 1, 1],
    ['freetheai', 'bbl/grok-4.1-fast-non-reasoning', 'Grok 4.1 Fast (bbl)',           6, 6, 'Medium', 10, 250, null, null, '~10M',    131072, 1, 0, 0],
  ];

  for (const r of rows) insert.run(...r);

  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'freetheai'`).run();

  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority)
    SELECT id, 9999 FROM models WHERE platform = 'freetheai'
    AND id NOT IN (SELECT model_db_id FROM fallback_config)
  `).run();
}

export function down(db: Database.Database): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'freetheai'`).run();
}
