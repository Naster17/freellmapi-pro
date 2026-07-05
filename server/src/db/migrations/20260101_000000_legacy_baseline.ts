import crypto from 'crypto';
import Database from 'better-sqlite3';
import { initEncryptionKey } from '../../lib/crypto.js';
import { applyModelPricing } from '../model-pricing.js';
import { applyModelMetadataCorrections } from '../model-metadata-corrections.js';

export function up(db: Database.Database): void {
  createTables(db);
  migrateProxyRateLimitWindows(db);
  initEncryptionKey(db);
  seedModels(db);
  migrateModels(db);
  migrateModelsV2(db);
  migrateModelsV3Ranks(db);
  migrateModelsV4(db);
  migrateModelsV5(db);
  migrateModelsV6(db);
  migrateModelsV7(db);
  migrateModelsV8(db);
  migrateModelsV9(db);
  migrateModelsV10(db);
  migrateModelsV11(db);
  migrateModelsV12(db);
  migrateModelsV13(db);
  migrateModelsV14(db);
  migrateModelsV15(db);
  migrateModelsV16Vision(db);
  migrateModelsV17IntelligenceTiers(db);
  migrateModelsV18OpenCodeZen(db);
  migrateModelsV19Gemma4(db);
  migrateModelsV20KiloFree(db);
  migrateModelsV21PruneDead(db);
  migrateModelsV22Tools(db);
  migrateModelsV23FreeTierAudit(db);
  migrateModelsV24ZenRefresh(db);
  migrateModelsV25ZenDeadPromos(db);
  
  
  
  
  
  
  
  
  
  
  applyModelPricing(db);
  applyModelMetadataCorrections(db);
  migrateEmbeddingsV1(db);
  migrateMediaV1(db);
  migrateQuirksV1(db);
  ensureUnifiedKey(db);
  migrateProfilesInit(db);
}

export function down(_db: Database.Database): void {
  throw new Error('Legacy baseline is irreversible - restore from backup');
}

function createTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      client_ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
      tokens INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#6366f1',
      type TEXT NOT NULL DEFAULT 'custom',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      auto_sort TEXT,
      layout_config TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(profile_id, model_db_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Dashboard accounts (email + password) gating the /api/* admin surface (#35).
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_recent ON requests(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_lookup ON rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_cooldowns_expires ON rate_limit_cooldowns(expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);

    CREATE TABLE IF NOT EXISTS provider_quota_state (
      platform TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      quota_pool_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      limit_value INTEGER,
      remaining_value INTEGER,
      reset_at TEXT,
      reset_strategy TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'probe',
      confidence REAL NOT NULL DEFAULT 0,
      notes TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, key_id, quota_pool_key, metric)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_quota_state_platform ON provider_quota_state(platform, key_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_state_reset_at ON provider_quota_state(reset_at);

    CREATE TABLE IF NOT EXISTS provider_quota_observations (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      provider_account_id TEXT,
      model_id TEXT,
      quota_pool_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      status_code INTEGER,
      limit_value INTEGER,
      remaining_value INTEGER,
      reset_at TEXT,
      retry_after_ms INTEGER,
      reset_strategy TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'probe',
      confidence REAL NOT NULL DEFAULT 0,
      notes TEXT,
      raw_json TEXT,
      endpoint TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_platform ON provider_quota_observations(platform, key_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_reset_at ON provider_quota_observations(reset_at);
  `);

  ensureRequestKeyIdColumn(db);
  ensureApiKeysBaseUrlColumn(db);
  ensureModelsKeyIdColumn(db);
  ensureRequestTtfbColumn(db);
  ensureRequestRequestedModelColumn(db);
  ensureRequestClientIpColumn(db);
  ensureRequestCachedTokensColumn(db);
}

function runSchemaMigration(db: Database.Database, id: string, apply: () => void) {
  const exists = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(id);
  if (exists) return;
  const run = db.transaction(() => {
    apply();
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(id);
  });
  run();
}

function migrateProxyRateLimitWindows(db: Database.Database) {
  runSchemaMigration(db, '2026-06-20-proxy-rate-limit-windows', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_rate_limit_windows (
        ip TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_proxy_rate_limit_windows_reset ON proxy_rate_limit_windows(reset_at_ms);
    `);
  });
}





function ensureRequestRequestedModelColumn(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'requested_model')) {
    db.prepare('ALTER TABLE requests ADD COLUMN requested_model TEXT').run();
  }
}

function ensureRequestClientIpColumn(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'client_ip')) {
    db.prepare('ALTER TABLE requests ADD COLUMN client_ip TEXT').run();
  }
}







function ensureRequestCachedTokensColumn(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'cached_tokens')) {
    db.prepare('ALTER TABLE requests ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0').run();
  }
}




function ensureRequestTtfbColumn(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'ttfb_ms')) {
    db.prepare('ALTER TABLE requests ADD COLUMN ttfb_ms INTEGER').run();
  }
}

function ensureRequestKeyIdColumn(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'key_id')) {
    db.prepare('ALTER TABLE requests ADD COLUMN key_id INTEGER').run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_key_id ON requests(key_id)').run();
}



function ensureApiKeysBaseUrlColumn(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'base_url')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN base_url TEXT').run();
  }
}




function ensureModelsKeyIdColumn(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'key_id')) {
    db.prepare('ALTER TABLE models ADD COLUMN key_id INTEGER').run();
    
    
    db.prepare(`
      UPDATE models
         SET key_id = (SELECT id FROM api_keys WHERE platform = 'custom' ORDER BY id LIMIT 1)
       WHERE platform = 'custom' AND key_id IS NULL
    `).run();
  }
}

function seedModels(db: Database.Database) {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM models').get() as { cnt: number };
  if (count.cnt > 0) return;

  const insert = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  
  const models = [
    
    ['google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 1, 8, 'Frontier', 5, 100, 250000, null, '~12M', 1048576],
    ['google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 4, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
    ['google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 8, 3, 'Medium', 15, 1000, 250000, null, '~120M', 1048576],
    
    ['openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'moonshotai/kimi-k2:free', 'Kimi K2 (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 3, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 4, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    
    ['cerebras', 'qwen-3-coder-480b', 'Qwen3-Coder 480B', 2, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 3, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'qwen3-235b', 'Qwen3 235B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 8192],
    ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 131072],
    
    ['github', 'openai/gpt-5', 'GPT-5 (GitHub)', 1, 7, 'Frontier', 10, 50, null, null, '~18M', 128000],
    
    ['sambanova', 'Meta-Llama-3.3-70B-Instruct', 'Llama 3.3 70B', 6, 9, 'Large', 20, null, null, 200000, '~6M', 8192],
    
    ['mistral', 'mistral-large-latest', 'Mistral Large 3', 7, 8, 'Large', 2, null, 500000, null, '~50-100M', 131072],
    ['mistral', 'magistral-medium-latest', 'Magistral Medium', 4, 8, 'Large', 2, null, 500000, null, '~50-100M', 40000],
    ['mistral', 'codestral-latest', 'Codestral', 6, 6, 'Medium', 2, null, 500000, null, '~50-100M', 32000],
    
    ['groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 9, 2, 'Medium', 30, 1000, 6000, 500000, '~15M', 131072],
    ['groq', 'llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 10, 2, 'Medium', 30, 1000, 6000, 1000000, '~30M', 131072],
    
    ['nvidia', 'meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (NV)', 11, 6, 'Large', 40, null, null, null, 'credits-based', 131072],
    
    ['cohere', 'command-r-plus-08-2024', 'Command R+ (08-2024)', 12, 11, 'Large', 20, 33, null, null, '~1-2M', 131072],
    ['cloudflare', '@cf/meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (CF)', 13, 11, 'Medium', null, null, null, null, '~18-45M', 131072],
    
    ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'Llama 3.3 70B (HF)', 14, 11, 'Medium', null, null, null, null, '~1-3M', 131072],
    
    ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 5, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ['moonshot', 'kimi-latest', 'Kimi Latest', 4, 8, 'Large', 60, null, null, 500000, '~15M', 200000],
    ['minimax', 'MiniMax-M1', 'MiniMax M1', 5, 8, 'Large', 20, null, 1000000, null, '~30M', 200000],
  ];

  const insertMany = db.transaction(() => {
    for (const m of models) {
      insert.run(...m);
    }
  });
  insertMany();

  
  const allModels = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as { id: number; intelligence_rank: number }[];
  const insertFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  const insertFallbacks = db.transaction(() => {
    for (let i = 0; i < allModels.length; i++) {
      insertFallback.run(allModels[i].id, i + 1);
    }
  });
  insertFallbacks();

  console.log(`Seeded ${models.length} models and fallback config`);
}


function migrateModels(db: Database.Database) {
  
  const renames: Array<[string, string, string, string, number, string, number | null, number | null, number]> = [
    
  ];
  const renameStmt = db.prepare(`
    UPDATE models
       SET model_id = ?, display_name = ?, intelligence_rank = ?,
           monthly_token_budget = ?, rpd_limit = COALESCE(?, rpd_limit),
           context_window = COALESCE(?, context_window),
           size_label = COALESCE(?, size_label)
     WHERE platform = ? AND model_id = ?
  `);
  
  renameStmt.run('deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, '~6M', 200, 131072, 'Frontier', 'openrouter', 'deepseek/deepseek-r1:free');
  
  renameStmt.run('openai/gpt-5', 'GPT-5 (GitHub)', 1, '~18M', null, 128000, 'Frontier', 'github', 'gpt-4o');

  
  db.prepare(`UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'`).run();
  db.prepare(`UPDATE models SET rpm_limit = 20 WHERE platform = 'sambanova' AND model_id = 'Meta-Llama-3.3-70B-Instruct'`).run();
  db.prepare(`UPDATE models SET tpm_limit = 6000 WHERE platform = 'groq' AND model_id = 'llama-4-scout-17b-16e-instruct'`).run();
  db.prepare(`UPDATE models SET monthly_token_budget = '~1-2M' WHERE platform = 'cohere' AND model_id = 'command-r-plus-08-2024'`).run();
  db.prepare(`UPDATE models SET monthly_token_budget = '~1-3M' WHERE platform = 'huggingface' AND model_id = 'accounts/fireworks/models/llama-v3p3-70b-instruct'`).run();
  
  db.prepare(`UPDATE models SET monthly_token_budget = 'credits-based', enabled = 0 WHERE platform = 'nvidia' AND model_id = 'meta/llama-3.1-70b-instruct'`).run();

  
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const newModels: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    
    ['cerebras', 'qwen-3-coder-480b', 'Qwen3-Coder 480B', 2, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 3, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 131072],
    
    ['openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'moonshotai/kimi-k2:free', 'Kimi K2 (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 3, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 4, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    
    ['mistral', 'magistral-medium-latest', 'Magistral Medium', 4, 8, 'Large', 2, null, 500000, null, '~50-100M', 40000],
    ['mistral', 'codestral-latest', 'Codestral', 6, 6, 'Medium', 2, null, 500000, null, '~50-100M', 32000],
    
    ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 5, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ['moonshot', 'kimi-latest', 'Kimi Latest', 4, 8, 'Large', 60, null, null, 500000, '~15M', 200000],
    ['minimax', 'MiniMax-M1', 'MiniMax M1', 5, 8, 'Large', 20, null, 1000000, null, '~30M', 200000],
  ];

  const apply = db.transaction(() => {
    for (const m of newModels) insert.run(...m);

    
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL
      ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) {
        addFallback.run(missing[i].id, maxPriority + i + 1);
      }
    }
  });
  apply();
}


function migrateModelsV2(db: Database.Database) {
  
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    
    
    
    ['cerebras', 'qwen-3-coder-480b'],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct'],
    ['cerebras', 'gpt-oss-120b'],
    
    ['openrouter', 'deepseek/deepseek-v3.1:free'],
    ['openrouter', 'moonshotai/kimi-k2:free'],
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  
  
  db.prepare(`
    UPDATE models
       SET model_id = 'gpt-4o', display_name = 'GPT-4o', intelligence_rank = 5,
           size_label = 'Large', context_window = 8000, monthly_token_budget = '~18M'
     WHERE platform = 'github' AND model_id = 'openai/gpt-5'
  `).run();

  
  db.prepare(`
    UPDATE models SET model_id = 'meta-llama/llama-4-scout-17b-16e-instruct'
     WHERE platform = 'groq' AND model_id = 'llama-4-scout-17b-16e-instruct'
  `).run();

  
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    
    ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free', 'Qwen3-Next 80B (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'minimax/minimax-m2.5:free', 'MiniMax M2.5 (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 196608],
    ['openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B (free)', 5, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
  ];
  const applyAdditions = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  applyAdditions();
}


function migrateModelsV3Ranks(db: Database.Database) {
  const setRank = db.prepare(`UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?`);
  const ranks: Array<[number, string, string]> = [
    
    [1,  'openrouter',  'minimax/minimax-m2.5:free'],                     
    [2,  'openrouter',  'qwen/qwen3-coder:free'],                         
    [3,  'openrouter',  'qwen/qwen3-next-80b-a3b-instruct:free'],         
    [4,  'moonshot',    'kimi-latest'],                                   
    [5,  'cerebras',    'qwen-3-235b-a22b-instruct-2507'],                
    [6,  'google',      'gemini-2.5-pro'],                                
    [7,  'openrouter',  'z-ai/glm-4.5-air:free'],                         
    [8,  'openrouter',  'openai/gpt-oss-120b:free'],                      
    [9,  'openrouter',  'nvidia/nemotron-3-super-120b-a12b:free'],        
    [10, 'minimax',     'MiniMax-M1'],                                    
    
    [11, 'mistral',     'codestral-latest'],                              
    [12, 'mistral',     'mistral-large-latest'],
    [13, 'mistral',     'magistral-medium-latest'],                       
    [14, 'google',      'gemini-2.5-flash'],
    [15, 'zhipu',       'glm-4.5-flash'],
    
    [16, 'groq',        'llama-3.3-70b-versatile'],
    [16, 'sambanova',   'Meta-Llama-3.3-70B-Instruct'],
    [16, 'openrouter',  'meta-llama/llama-3.3-70b-instruct:free'],
    [16, 'huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
    
    [17, 'openrouter',  'nousresearch/hermes-3-llama-3.1-405b:free'],     
    [18, 'groq',        'meta-llama/llama-4-scout-17b-16e-instruct'],     
    [19, 'openrouter',  'google/gemma-4-31b-it:free'],
    [20, 'google',      'gemini-2.5-flash-lite'],
    [21, 'github',      'gpt-4o'],                                        
    [22, 'nvidia',      'meta/llama-3.1-70b-instruct'],                   
    [22, 'cloudflare',  '@cf/meta/llama-3.1-70b-instruct'],               
    [23, 'cohere',      'command-r-plus-08-2024'],                        
  ];
  const apply = db.transaction(() => {
    for (const [rank, platform, modelId] of ranks) {
      setRank.run(rank, platform, modelId);
    }
  });
  apply();
}


function migrateModelsV4(db: Database.Database) {
  
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    ['moonshot', 'kimi-latest'],                                            
    ['minimax', 'MiniMax-M1'],                                              
    ['openrouter', 'google/gemma-4-31b-it:free'],                           
    ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],  
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  
  db.prepare(`
    UPDATE models
       SET model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
           display_name = 'Llama 3.3 70B fp8-fast (CF)',
           context_window = 131072
     WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.1-70b-instruct'
  `).run();

  
  db.prepare(`UPDATE models SET tpm_limit = 12000 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'`).run();
  db.prepare(`UPDATE models SET rpd_limit = 20 WHERE platform = 'sambanova' AND model_id = 'Meta-Llama-3.3-70B-Instruct'`).run();
  db.prepare(`UPDATE models SET rpd_limit = 14400 WHERE platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507'`).run();
  db.prepare(`UPDATE models SET rpd_limit = 250, monthly_token_budget = '~25M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'`).run();
  
  
  db.prepare(`UPDATE models SET rpd_limit = 50, monthly_token_budget = '~6M' WHERE platform = 'google' AND model_id = 'gemini-2.5-pro'`).run();

  
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    
    ['openrouter', 'inclusionai/ling-2.6-flash:free',        'Ling 2.6 Flash (free)',         7,  9,  'Large',    20, 200, null, null, '~6M', 262144],
    ['openrouter', 'arcee-ai/trinity-large-preview:free',    'Trinity Large Preview (free)',  13, 9,  'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free',    'Nemotron 3 Nano 30B (free)',    22, 9,  'Medium',   20, 200, null, null, '~6M', 262144],
    ['openrouter', 'openai/gpt-oss-120b:free',               'GPT-OSS 120B (free)',           6,  9,  'Large',    20, 200, null, null, '~6M', 131072],
    ['openrouter', 'openai/gpt-oss-20b:free',                'GPT-OSS 20B (free)',            18, 9,  'Medium',   20, 200, null, null, '~6M', 131072],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B (free)',          17, 9,  'Medium',   20, 200, null, null, '~6M', 131072],

    
    ['sambanova',  'DeepSeek-V3.1',                          'DeepSeek V3.1',                 5,  9,  'Frontier', 20, 20,  null, 200000, '~3M', 131072],
    ['sambanova',  'DeepSeek-V3.2',                          'DeepSeek V3.2',                 4,  9,  'Frontier', 20, 20,  null, 200000, '~3M', 131072],
    ['sambanova',  'Llama-4-Maverick-17B-128E-Instruct',     'Llama 4 Maverick',              11, 9,  'Large',    20, 20,  null, 200000, '~3M', 8192],
    ['sambanova',  'gpt-oss-120b',                           'GPT-OSS 120B (SambaNova)',      6,  9,  'Large',    20, 20,  null, 200000, '~3M', 131072],

    
    ['groq',       'openai/gpt-oss-120b',                    'GPT-OSS 120B (Groq)',           6,  2,  'Large',    30, 1000, 8000, 200000,  '~6M',  131072],
    ['groq',       'openai/gpt-oss-20b',                     'GPT-OSS 20B (Groq)',            18, 2,  'Medium',   30, 1000, 8000, 200000,  '~6M',  131072],
    ['groq',       'qwen/qwen3-32b',                         'Qwen3 32B (Groq)',              19, 2,  'Medium',   60, 1000, 6000, 500000,  '~15M', 131072],
    ['groq',       'llama-3.1-8b-instant',                   'Llama 3.1 8B Instant',          28, 2,  'Small',    30, 14400, 6000, 500000, '~15M', 131072],

    
    ['mistral',    'devstral-latest',                        'Devstral',                      16, 8,  'Medium',   2, null, 500000, null, '~50-100M', 131072],
    ['mistral',    'mistral-medium-latest',                  'Mistral Medium 3.5',            14, 8,  'Large',    2, null, 500000, null, '~50-100M', 131072],

    
    ['github',     'openai/gpt-4.1',                         'GPT-4.1 (GitHub)',              20, 7,  'Large',    10, 50,  null, null, '~9M', 128000],

    
    ['cohere',     'command-a-03-2025',                      'Command-A (03-2025)',           27, 11, 'Large',    20, 33,  null, null, '~1-2M', 131072],

    
    ['cloudflare', '@cf/openai/gpt-oss-120b',                'GPT-OSS 120B (CF)',             6,  11, 'Large',    null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/zai-org/glm-4.7-flash',              'GLM-4.7 Flash (CF)',            10, 11, 'Large',    null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout (CF)',            12, 11, 'Large',    null, null, null, null, '~18-45M', 131072],
  ];

  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();

  
  
  const setRank = db.prepare(`UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?`);
  const ranks: Array<[number, string, string]> = [
    [1,  'openrouter',  'minimax/minimax-m2.5:free'],
    [2,  'openrouter',  'qwen/qwen3-coder:free'],
    [3,  'openrouter',  'qwen/qwen3-next-80b-a3b-instruct:free'],
    [4,  'sambanova',   'DeepSeek-V3.2'],
    [5,  'sambanova',   'DeepSeek-V3.1'],
    [6,  'cerebras',    'qwen-3-235b-a22b-instruct-2507'],
    [6,  'openrouter',  'openai/gpt-oss-120b:free'],
    [6,  'groq',        'openai/gpt-oss-120b'],
    [6,  'sambanova',   'gpt-oss-120b'],
    [6,  'cloudflare',  '@cf/openai/gpt-oss-120b'],
    [7,  'openrouter',  'inclusionai/ling-2.6-flash:free'],
    [8,  'openrouter',  'z-ai/glm-4.5-air:free'],
    [10, 'cloudflare',  '@cf/zai-org/glm-4.7-flash'],
    [11, 'sambanova',   'Llama-4-Maverick-17B-128E-Instruct'],
    [12, 'groq',        'meta-llama/llama-4-scout-17b-16e-instruct'],
    [12, 'cloudflare',  '@cf/meta/llama-4-scout-17b-16e-instruct'],
    [13, 'openrouter',  'arcee-ai/trinity-large-preview:free'],
    [14, 'google',      'gemini-2.5-pro'],
    [14, 'mistral',     'mistral-large-latest'],
    [14, 'mistral',     'mistral-medium-latest'],
    [16, 'mistral',     'devstral-latest'],
    [16, 'mistral',     'codestral-latest'],
    [17, 'groq',        'llama-3.3-70b-versatile'],
    [17, 'sambanova',   'Meta-Llama-3.3-70B-Instruct'],
    [17, 'cloudflare',  '@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    [17, 'openrouter',  'meta-llama/llama-3.3-70b-instruct:free'],
    [17, 'nvidia',      'meta/llama-3.1-70b-instruct'],
    [18, 'openrouter',  'openai/gpt-oss-20b:free'],
    [18, 'groq',        'openai/gpt-oss-20b'],
    [19, 'groq',        'qwen/qwen3-32b'],
    [20, 'google',      'gemini-2.5-flash'],
    [20, 'github',      'openai/gpt-4.1'],
    [21, 'mistral',     'magistral-medium-latest'],
    [22, 'openrouter',  'nvidia/nemotron-3-super-120b-a12b:free'],
    [23, 'openrouter',  'nvidia/nemotron-3-nano-30b-a3b:free'],
    [24, 'zhipu',       'glm-4.5-flash'],
    [25, 'github',      'gpt-4o'],
    [26, 'google',      'gemini-2.5-flash-lite'],
    [27, 'cohere',      'command-a-03-2025'],
    [27, 'cohere',      'command-r-plus-08-2024'],
    [28, 'groq',        'llama-3.1-8b-instant'],
  ];
  const applyRanks = db.transaction(() => {
    for (const [r, p, m] of ranks) setRank.run(r, p, m);
  });
  applyRanks();
}


function migrateModelsV5(db: Database.Database) {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'google' AND model_id = 'gemini-2.5-pro'`).run();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const apply = db.transaction(() => {
    insert.run('cerebras', 'zai-glm-4.7', 'GLM-4.7 (Cerebras)', 7, 1, 'Frontier', 10, 100, null, null, '~3M', 8192);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}


function migrateModelsV6(db: Database.Database) {
  
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    ['openrouter', 'arcee-ai/trinity-large-preview:free'],
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  
  db.prepare(`
    UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M'
     WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'
  `).run();
  db.prepare(`
    UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M'
     WHERE platform = 'google' AND model_id = 'gemini-2.5-flash-lite'
  `).run();

  
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    
    
    
    
    ['cloudflare', '@cf/moonshotai/kimi-k2.5',                    'Kimi K2.5 (CF)',                  3,  11, 'Frontier', null, null, null, null, '~10-20M', 262144],
    ['cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8',                  'Qwen3 30B-A3B fp8 (CF)',          7,  11, 'Large',    null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'DeepSeek R1 Distill Qwen 32B (CF)', 9, 11, 'Large',  null, null, null, null, '~3-5M',   131072],

    
    
    ['google',     'gemini-3.1-flash-lite-preview',               'Gemini 3.1 Flash-Lite Preview',   18, 3,  'Medium',   15, 20,  250000, null, '~3M',  1048576],
    ['google',     'gemini-3-flash-preview',                       'Gemini 3 Flash Preview',          11, 5,  'Large',    10, 20,  250000, null, '~3M',  1048576],
    ['google',     'gemini-3.1-pro-preview',                       'Gemini 3.1 Pro Preview',          1,  8,  'Frontier',  5, 20,  250000, null, '~3M',  1048576],

    
    ['openrouter', 'google/gemma-4-31b-it:free',                   'Gemma 4 31B (free)',             19, 9,  'Medium',   20, 200, null, null, '~6M', 262144],
    ['openrouter', 'liquid/lfm-2.5-1.2b-instruct:free',            'Liquid LFM 2.5 1.2B (free)',     30, 10, 'Small',    20, 200, null, null, '~6M', 32768],
  ];
  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}


function migrateModelsV7(db: Database.Database) {
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    ['openrouter', 'inclusionai/ling-2.6-flash:free'],
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    ['openrouter', 'inclusionai/ling-2.6-1t:free',                           'Ling 2.6 1T (free)',                       4,  9,  'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'tencent/hy3-preview:free',                               'Tencent HY3 Preview (free)',               7,  9,  'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'poolside/laguna-m.1:free',                               'Poolside Laguna M.1 (free)',               13, 9,  'Large',    20, 200, null, null, '~6M', 131072],
    ['openrouter', 'google/gemma-4-26b-a4b-it:free',                         'Gemma 4 26B-A4B (free)',                   22, 9,  'Medium',   20, 200, null, null, '~6M', 262144],
    ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',     'Nemotron 3 Nano 30B Reasoning (free)',     23, 9,  'Medium',   20, 200, null, null, '~6M', 262144],
    ['openrouter', 'poolside/laguna-xs.2:free',                              'Poolside Laguna XS.2 (free)',              26, 10, 'Medium',   20, 200, null, null, '~6M', 131072],
    ['openrouter', 'nvidia/nemotron-nano-9b-v2:free',                        'Nemotron Nano 9B v2 (free)',               28, 10, 'Medium',   20, 200, null, null, '~6M', 128000],
    ['openrouter', 'liquid/lfm-2.5-1.2b-thinking:free',                      'Liquid LFM 2.5 1.2B Thinking (free)',      30, 10, 'Small',    20, 200, null, null, '~6M', 32768],
    
    ['zhipu',      'glm-4.7-flash',                                          'GLM-4.7 Flash',                            18, 4,  'Large',    null, null, null, 1000000, '~30M', 131072],
  ];
  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}


function migrateModelsV8(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    
    ['sambanova',  'DeepSeek-V3.1-cb',                          'DeepSeek V3.1 (CB)',             5,  9,  'Frontier', 20, 20, null, 200000, '~3M',     131072],
    ['sambanova',  'gemma-3-12b-it',                            'Gemma 3 12B (SambaNova)',        22, 9,  'Medium',   20, 20, null, 200000, '~3M',     131072],
    
    ['cloudflare', '@cf/moonshotai/kimi-k2.6',                  'Kimi K2.6 (CF)',                 2,  11, 'Frontier', null, null, null, null, '~10-20M', 262144],
    ['cloudflare', '@cf/ibm-granite/granite-4.0-h-micro',       'Granite 4.0 H Micro (CF)',       29, 11, 'Small',    null, null, null, null, '~5-10M',  131072],
  ];
  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}


function migrateModelsV9(db: Database.Database) {
  db.prepare(
    "UPDATE models SET enabled = 0 WHERE platform = 'cerebras' AND model_id = 'zai-glm-4.7'"
  ).run();
}


function migrateModelsV10(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    
    
    
    
    ['ollama', 'qwen3-coder:480b',     'Qwen3-Coder 480B (Ollama)',    2,  9, 'Frontier', null, null, null, null, '~5-10M',  262144],
    ['ollama', 'mistral-large-3:675b', 'Mistral Large 3 675B (Ollama)', 3,  9, 'Frontier', null, null, null, null, '~5-10M',  131072],
    ['ollama', 'deepseek-v3.2',        'DeepSeek V3.2 (Ollama)',        4,  9, 'Frontier', null, null, null, null, '~5-10M',  131072],
    ['ollama', 'cogito-2.1:671b',      'Cogito 2.1 671B (Ollama)',      4,  9, 'Frontier', null, null, null, null, '~5-10M',  131072],
    ['ollama', 'kimi-k2-thinking',     'Kimi K2 Thinking (Ollama)',     5,  9, 'Frontier', null, null, null, null, '~5-10M',  131072],
    ['ollama', 'glm-4.7',              'GLM-4.7 (Ollama)',              6,  9, 'Frontier', null, null, null, null, '~5-10M',  131072],
    ['ollama', 'gpt-oss:120b',         'GPT-OSS 120B (Ollama)',         6,  9, 'Large',    null, null, null, null, '~10-20M', 131072],
    ['ollama', 'devstral-2:123b',      'Devstral 2 123B (Ollama)',      8, 10, 'Large',    null, null, null, null, '~10-20M', 131072],
    ['ollama', 'gpt-oss:20b',          'GPT-OSS 20B (Ollama)',         18, 10, 'Medium',   null, null, null, null, '~20-30M', 131072],
    ['ollama', 'gemma4:31b',           'Gemma 4 31B (Ollama)',         22, 10, 'Medium',   null, null, null, null, '~20-30M', 131072],
  ];
  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}


function migrateModelsV11(db: Database.Database) {
  
  
  db.prepare(`
    UPDATE models SET model_id = 'qwen-3-235b-a22b-instruct-2507'
     WHERE platform = 'cerebras' AND model_id = 'qwen3-235b'
  `).run();

  
  db.prepare(`
    UPDATE models SET enabled = 1, monthly_token_budget = '~3M (1k credits)'
     WHERE platform = 'nvidia' AND model_id = 'meta/llama-3.1-70b-instruct'
  `).run();

  
  
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    
    
    
    
    ['nvidia',       'meta/llama-3.3-70b-instruct',                       'Llama 3.3 70B (NV)',                17, 6, 'Large',    40, null, null, null, '~3M (credits)', 131072],
    ['nvidia',       'meta/llama-4-maverick-17b-128e-instruct',           'Llama 4 Maverick (NV)',             11, 6, 'Large',    40, null, null, null, '~3M (credits)', 131072],
    ['nvidia',       'deepseek-ai/deepseek-v4-pro',                       'DeepSeek V4 Pro (NV)',               3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],
    ['nvidia',       'mistralai/mistral-large-3-675b-instruct-2512',      'Mistral Large 3 675B (NV)',          3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],
    ['nvidia',       'minimaxai/minimax-m2.7',                            'MiniMax M2.7 (NV)',                  3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 196608],
    ['nvidia',       'nvidia/nemotron-3-super-120b-a12b',                 'Nemotron 3 Super 120B (NV)',        22, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 262144],
    ['nvidia',       'nvidia/nemotron-3-nano-30b-a3b',                    'Nemotron 3 Nano 30B (NV)',          22, 9, 'Medium',   40, null, null, null, '~3M (credits)', 262144],
    ['nvidia',       'google/gemma-4-31b-it',                             'Gemma 4 31B (NV)',                  19, 9, 'Medium',   40, null, null, null, '~3M (credits)', 262144],
    ['nvidia',       'moonshotai/kimi-k2.6',                              'Kimi K2.6 (NV)',                     3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],

    
    
    
    
    
    ['cerebras',     'gpt-oss-120b',                              'GPT-OSS 120B (Cerebras)',        6,  1, 'Large',    30, 1000, 60000, 1000000, '~30M', 131072],
    ['cerebras',     'llama3.1-8b',                               'Llama 3.1 8B (Cerebras)',       28,  1, 'Small',    30, 1000, 60000, 1000000, '~30M', 131072],

    
    
    
    ['groq',         'groq/compound',                             'Compound (Groq)',                6,  2, 'Large',    30, 1000, 8000, 200000, '~6M', 131072],
    ['groq',         'groq/compound-mini',                        'Compound Mini (Groq)',          18,  2, 'Medium',   30, 1000, 8000, 200000, '~6M', 131072],

    
    
    ['kilo',         'nvidia/nemotron-3-super-120b-a12b:free',  'Nemotron 3 Super 120B (Kilo)',  22, 9,  'Frontier', null, null, null, null, '~2-3M (200/hr)', 262144],

    
    
    ['pollinations', 'openai-fast',                              'GPT-OSS 20B (Pollinations)',    18, 10, 'Medium',   null, null, null, null, '~? (anon)',      131072],

    
    ['llm7',         'gpt-oss-20b',                              'GPT-OSS 20B (LLM7)',            18, 10, 'Medium',   100, null, null, null, '~2-3M (100/hr)', 131072],
    ['llm7',         'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Llama 3.1 8B Turbo (LLM7)', 28, 10, 'Small',    100, null, null, null, '~2-3M (100/hr)', 131072],
    ['llm7',         'codestral-latest',                          'Codestral (LLM7)',              16, 8,  'Medium',   100, null, null, null, '~2-3M (100/hr)',  32000],
    ['llm7',         'ministral-8b-2512',                         'Ministral 8B (LLM7)',           28, 10, 'Small',    100, null, null, null, '~2-3M (100/hr)', 131072],
    ['llm7',         'GLM-4.6V-Flash',                            'GLM-4.6V Flash (LLM7)',         15, 9,  'Large',    100, null, null, null, '~2-3M (100/hr)', 131072],
  ];

  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}


function migrateModelsV12(db: Database.Database) {
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    ['openrouter', 'inclusionai/ling-2.6-1t:free'],
    ['openrouter', 'tencent/hy3-preview:free'],
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  
  db.prepare(`
    UPDATE models SET context_window = 1000000
     WHERE platform = 'openrouter' AND model_id = 'nvidia/nemotron-3-super-120b-a12b:free'
  `).run();
  db.prepare(`
    UPDATE models SET context_window = 1048576
     WHERE platform = 'openrouter' AND model_id = 'qwen/qwen3-coder:free'
  `).run();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  
  
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    ['openrouter', 'arcee-ai/trinity-large-thinking:free',         'Trinity Large Thinking (free)',  5,  9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'baidu/cobuddy:free',                           'CoBuddy (free)',                 6,  9, 'Large',    20, 200, null, null, '~6M', 131072],
    ['openrouter', 'openrouter/owl-alpha',                         'Owl Alpha (OR-house)',           5,  9, 'Frontier', 20, 200, null, null, '~6M', 1048576],
    ['openrouter', 'nousresearch/hermes-3-llama-3.1-405b:free',    'Hermes 3 405B (free)',          17,  9, 'Large',    20, 200, null, null, '~6M', 131072],
  ];
  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}


function migrateModelsV13(db: Database.Database) {
  
  const disable = db.prepare(`UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?`);
  const disables: Array<[string, string]> = [
    ['google', 'gemini-3.1-pro-preview'],
    ['ollama', 'kimi-k2-thinking'],
    ['ollama', 'mistral-large-3:675b'],
    ['ollama', 'deepseek-v3.2'],
  ];
  for (const [p, m] of disables) disable.run(p, m);

  
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    ['sambanova', 'DeepSeek-V3.1-cb'],
    ['cloudflare', '@cf/moonshotai/kimi-k2.5'],
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  
  
  db.prepare(`
    UPDATE models
       SET rpm_limit = 5, rpd_limit = 2400, tpm_limit = 30000, tpd_limit = 1000000
     WHERE platform = 'cerebras'
       AND model_id IN ('qwen-3-235b-a22b-instruct-2507', 'gpt-oss-120b', 'llama3.1-8b')
  `).run();

  
  db.prepare(`UPDATE models SET tpd_limit = 100000 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'`).run();
  db.prepare(`UPDATE models SET tpm_limit = 30000 WHERE platform = 'groq' AND model_id = 'meta-llama/llama-4-scout-17b-16e-instruct'`).run();
  db.prepare(`
    UPDATE models SET rpd_limit = 250, tpm_limit = 70000, tpd_limit = NULL
     WHERE platform = 'groq' AND model_id IN ('groq/compound', 'groq/compound-mini')
  `).run();

  
  db.prepare(`UPDATE models SET context_window = 32768 WHERE platform = 'sambanova' AND model_id = 'DeepSeek-V3.2'`).run();
  db.prepare(`UPDATE models SET context_window = 24000 WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'`).run();

  
  db.prepare(`UPDATE models SET context_window = 256000 WHERE platform = 'mistral' AND model_id = 'codestral-latest'`).run();
  db.prepare(`UPDATE models SET context_window = 262144 WHERE platform = 'mistral' AND model_id = 'devstral-latest'`).run();
  db.prepare(`UPDATE models SET context_window = 131072 WHERE platform = 'mistral' AND model_id = 'magistral-medium-latest'`).run();
  db.prepare(`UPDATE models SET context_window = 262144 WHERE platform = 'mistral' AND model_id = 'mistral-large-latest'`).run();

  
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    
    ['groq',       'openai/gpt-oss-safeguard-20b',          'GPT-OSS Safeguard 20B (Groq)',   18, 2, 'Medium',   30, 1000, 8000, 200000, '~6M', 131072],

    
    ['cloudflare', '@cf/nvidia/nemotron-3-120b-a12b',       'Nemotron 3 120B (CF)',            9, 11, 'Frontier', null, null, null, null, '~5-10M',  262144],
    ['cloudflare', '@cf/google/gemma-4-26b-a4b-it',         'Gemma 4 26B-A4B it (CF)',        22, 11, 'Medium',   null, null, null, null, '~10-20M', 262144],

    
    ['google',     'gemini-3.5-flash',                      'Gemini 3.5 Flash',                3, 5, 'Large',    10, 20,  250000, null, '~3M', 1048576],

    
    ['nvidia',     'deepseek-ai/deepseek-v4-flash',         'DeepSeek V4 Flash (NV)',          4, 9, 'Frontier', 40, null, null, null, '~3M (credits)', 131072],
    ['nvidia',     'z-ai/glm-5.1',                          'GLM-5.1 (NV)',                    5, 9, 'Frontier', 40, null, null, null, '~3M (credits)', 200000],
    ['nvidia',     'qwen/qwen3-coder-480b-a35b-instruct',   'Qwen3-Coder 480B (NV)',           2, 9, 'Frontier', 40, null, null, null, '~3M (credits)', 262144],

    
    ['mistral',    'mistral-small-latest',                  'Mistral Small 4',                14, 8, 'Medium',   2, null, 500000, null, '~50-100M', 262144],
    ['mistral',    'ministral-8b-latest',                   'Ministral 3 8B',                 28, 8, 'Small',    2, null, 500000, null, '~50-100M', 262144],

    
    ['cohere',     'command-a-reasoning-08-2025',           'Command A Reasoning (08-2025)',  13, 11, 'Large',   20, 33, null, null, '~1-2M', 256000],
    ['cohere',     'command-r-08-2024',                     'Command R (08-2024)',            25, 11, 'Medium',  20, 33, null, null, '~1-2M', 131072],

    
    ['ollama',     'qwen3-coder-next',                      'Qwen3-Coder Next (Ollama)',       3, 9, 'Large',   null, null, null, null, '~10-20M', 262144],

    
    ['huggingface', 'deepseek-ai/DeepSeek-V4-Flash',        'DeepSeek V4 Flash (HF)',          4, 9, 'Frontier', null, null, null, null, '~1-3M', 131072],
    ['huggingface', 'moonshotai/Kimi-K2.6',                 'Kimi K2.6 (HF)',                  3, 9, 'Frontier', null, null, null, null, '~1-3M', 262144],
    ['huggingface', 'Qwen/Qwen3-Coder-Next',                'Qwen3-Coder Next (HF)',           3, 9, 'Large',    null, null, null, null, '~1-3M', 262144],
  ];

  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}


function migrateModelsV14(db: Database.Database) {
  db.prepare(`
    UPDATE models SET enabled = 0
     WHERE platform = 'cerebras'
       AND model_id IN ('qwen-3-235b-a22b-instruct-2507', 'llama3.1-8b')
  `).run();
}


function migrateModelsV15(db: Database.Database) {
  db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = 'siliconflow'
    )
  `).run();
  db.prepare(`DELETE FROM models WHERE platform = 'siliconflow'`).run();
}













function migrateModelsV16Vision(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'supports_vision')) {
    db.prepare('ALTER TABLE models ADD COLUMN supports_vision INTEGER NOT NULL DEFAULT 0').run();
  }
  const apply = db.transaction(() => {
    
    
    db.prepare('UPDATE models SET supports_vision = 0').run();
    
    db.prepare("UPDATE models SET supports_vision = 1 WHERE platform = 'google'").run();
    
    
    db.prepare(`
      UPDATE models SET supports_vision = 1
      WHERE LOWER(model_id) LIKE '%llama-4%'
        AND platform NOT IN ('cloudflare', 'cohere')
    `).run();
    
    db.prepare(`
      UPDATE models SET supports_vision = 1
      WHERE platform = 'github'
        AND (model_id LIKE '%gpt-4o%' OR model_id LIKE '%gpt-4.1%' OR model_id LIKE '%gpt-5%')
    `).run();
    
    
    
    db.prepare(`
      UPDATE models SET supports_vision = 1
      WHERE LOWER(model_id) LIKE '%glm-4.6v%'
         OR LOWER(model_id) LIKE '%nemotron-nano-12b-v2-vl%'
         OR LOWER(model_id) LIKE '%mimo%'  -- MiMo-V2.5 vision live-verified on OpenCode Zen (V27, 2026-06-27)
    `).run();
  });
  apply();
}



















function migrateModelsV17IntelligenceTiers(db: Database.Database) {
  const apply = db.transaction(() => {
    
    
    db.prepare(`
      UPDATE models SET size_label = 'Frontier' WHERE
           LOWER(model_id) LIKE '%gemini-3.1-pro%'
        OR LOWER(model_id) LIKE '%gemini-3.5-flash%'
        OR LOWER(model_id) LIKE '%gemini-3-flash%'
        OR LOWER(model_id) LIKE '%kimi-k2.6%'
        OR LOWER(model_id) LIKE '%kimi-k2-thinking%'
        OR LOWER(model_id) LIKE '%deepseek-v4-pro%'
        OR LOWER(model_id) LIKE '%deepseek-v4-flash%'
        OR LOWER(model_id) LIKE '%glm-5.1%'
        OR LOWER(model_id) LIKE '%minimax-m2.7%'
    `).run();

    
    
    
    db.prepare(`
      UPDATE models SET size_label = 'Large' WHERE
           LOWER(model_id) LIKE '%minimax-m2.5%'
        OR LOWER(model_id) LIKE '%qwen3-next%'
        OR LOWER(model_id) LIKE '%qwen3-coder-next%'
        OR LOWER(model_id) LIKE '%gpt-oss-120b%' OR LOWER(model_id) LIKE '%gpt-oss:120b%'
        OR LOWER(model_id) LIKE '%glm-4.7%'
        OR LOWER(model_id) LIKE '%nemotron-3-super%' OR LOWER(model_id) LIKE '%nemotron-3-120b%'
        OR LOWER(model_id) LIKE '%gemini-2.5-pro%'
        OR LOWER(model_id) LIKE '%deepseek-v3.2%'
        OR LOWER(model_id) LIKE '%deepseek-v3.1%'
        OR LOWER(model_id) LIKE '%trinity-large%'
        OR LOWER(model_id) LIKE '%mistral-medium%'
        OR LOWER(model_id) LIKE '%magistral-medium%'
        OR LOWER(model_id) LIKE '%gpt-4.1%'
        OR LOWER(model_id) LIKE '%gemma-4-31b%' OR LOWER(model_id) LIKE '%gemma4:31b%'
        OR LOWER(model_id) LIKE '%gemma-4-26b%'
        OR LOWER(model_id) LIKE '%gemini-3.1-flash-lite%'
    `).run();

    
    
    
    
    db.prepare(`
      UPDATE models SET size_label = 'Medium' WHERE
           (LOWER(model_id) LIKE '%qwen3-coder%' AND LOWER(model_id) NOT LIKE '%qwen3-coder-next%')
        OR LOWER(model_id) LIKE '%qwen-3-235b%' OR LOWER(model_id) LIKE '%qwen3-235b%'
        OR LOWER(model_id) LIKE '%mistral-large%'
        OR LOWER(model_id) LIKE '%gpt-oss-20b%' OR LOWER(model_id) LIKE '%gpt-oss:20b%'
        OR LOWER(model_id) LIKE '%gpt-oss-safeguard-20b%' OR model_id = 'openai-fast'
        OR LOWER(model_id) LIKE '%glm-4.5-air%'
        OR LOWER(model_id) LIKE '%devstral-2%'
        OR LOWER(model_id) LIKE '%deepseek-r1-distill%'
        OR LOWER(model_id) LIKE '%qwen3-30b%'
        OR LOWER(model_id) LIKE '%qwen3-32b%'
        OR LOWER(model_id) LIKE '%llama-4-maverick%'
        OR LOWER(model_id) LIKE '%llama-4-scout%'
        OR LOWER(model_id) LIKE '%llama-3.3-70b%'
        OR LOWER(model_id) LIKE '%llama-3.1-70b%'
        OR (LOWER(model_id) LIKE '%gemini-2.5-flash%' AND LOWER(model_id) NOT LIKE '%flash-lite%')
        OR LOWER(model_id) LIKE '%gemini-2.5-flash-lite%'
        OR LOWER(model_id) LIKE '%gpt-4o%'
        OR LOWER(model_id) LIKE '%command-a-03-2025%'
        OR LOWER(model_id) LIKE '%command-r-plus%'
        OR LOWER(model_id) LIKE '%nemotron-3-nano%'
        OR LOWER(model_id) LIKE '%nemotron-nano-9b%'
    `).run();

    
    
    db.prepare(`
      UPDATE models SET size_label = 'Small' WHERE
           LOWER(model_id) LIKE '%gemma-3-12b%'
        OR LOWER(model_id) LIKE '%command-r-08-2024%'
        OR LOWER(model_id) LIKE '%codestral%'
        OR LOWER(model_id) LIKE '%llama-3.1-8b%' OR LOWER(model_id) LIKE '%llama3.1-8b%'
        OR LOWER(model_id) LIKE '%meta-llama-3.1-8b%'
        OR LOWER(model_id) LIKE '%ministral-8b%'
        OR LOWER(model_id) LIKE '%granite-4.0-h-micro%'
        OR LOWER(model_id) LIKE '%lfm-2.5-1.2b%'
    `).run();
  });
  apply();
}



















function migrateModelsV18OpenCodeZen(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    ['opencode', 'big-pickle',             'Big Pickle (OpenCode Zen, stealth)',     10, 4, 'Large',    20, 200, null, null, '~500M', 200000],
    ['opencode', 'deepseek-v4-flash-free', 'DeepSeek V4 Flash Free (OpenCode Zen)',   4, 4, 'Frontier', 20, 200, null, null, '~500M', 200000],
    ['opencode', 'mimo-v2.5-free',         'MiMo-V2.5 Free (OpenCode Zen)',          14, 4, 'Medium',   20, 200, null, null, '~500M', 200000],
    ['opencode', 'nemotron-3-super-free',  'Nemotron 3 Super Free (OpenCode Zen)',   12, 4, 'Large',    20, 200, null, null, '~500M', 131072],
  ];

  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();
}


function migrateModelsV19Gemma4(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    ['google', 'gemma-4-31b-it',     'Gemma 4 31B IT', 19, 4, 'Large', 15, 1000, 250000, null, '~30M', 262144],
    ['google', 'gemma-4-26b-a4b-it', 'Gemma 4 26B IT', 20, 4, 'Large', 15, 1000, 250000, null, '~30M', 262144],
  ];

  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    backfillFallback(db);
  });
  apply();
}


function migrateModelsV20KiloFree(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    ['kilo', 'poolside/laguna-m.1:free',               'Poolside Laguna M.1 (Kilo)',    13, 8, 'Large',  null, null, null, null, 'free · 200/hr per IP',         262144],
    ['kilo', 'poolside/laguna-xs.2:free',              'Poolside Laguna XS.2 (Kilo)',   16, 4, 'Medium', null, null, null, null, 'free · 200/hr per IP',         262144],
    ['kilo', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (Kilo)',  12, 5, 'Large',  null, null, null, null, 'free · 200/hr per IP (trial)', 1000000],
    ['kilo', 'stepfun/step-3.7-flash:free',            'StepFun Step 3.7 Flash (Kilo)', 14, 3, 'Medium', null, null, null, null, 'free · 200/hr per IP',         262144],
  ];

  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    backfillFallback(db);
  });
  apply();
}


function migrateModelsV21PruneDead(db: Database.Database) {
  const dead: Array<[string, string]> = [
    ['llm7', 'gpt-oss-20b'],
    ['llm7', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'],
    ['llm7', 'ministral-8b-2512'],
    ['llm7', 'GLM-4.6V-Flash'],
    ['openrouter', 'arcee-ai/trinity-large-thinking:free'],
    ['openrouter', 'minimax/minimax-m2.5:free'],
    ['openrouter', 'baidu/cobuddy:free'],
  ];
  const apply = db.transaction(() => {
    const getId = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?');
    const delFb = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
    const delModel = db.prepare('DELETE FROM models WHERE id = ?');
    for (const [platform, modelId] of dead) {
      const row = getId.get(platform, modelId) as { id: number } | undefined;
      if (!row) continue;
      delFb.run(row.id);   
      delModel.run(row.id);
    }
    
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'cerebras' AND model_id = 'zai-glm-4.7'").run();
    db.prepare(`
      UPDATE fallback_config SET enabled = 1
       WHERE model_db_id = (SELECT id FROM models WHERE platform = 'cerebras' AND model_id = 'zai-glm-4.7')
    `).run();
  });
  apply();
}


























function migrateModelsV22Tools(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'supports_tools')) {
    db.prepare('ALTER TABLE models ADD COLUMN supports_tools INTEGER NOT NULL DEFAULT 0').run();
  }
  const apply = db.transaction(() => {
    
    db.prepare('UPDATE models SET supports_tools = 0').run();
    db.prepare(`
      UPDATE models SET supports_tools = 1
      WHERE (
           LOWER(model_id) LIKE '%gpt-oss%'        -- groq/OR/cerebras/CF/sambanova/ollama; incl. safeguard (tool-tuned)
        OR ((LOWER(model_id) LIKE '%llama-3%' OR LOWER(model_id) LIKE '%llama-4%')
            AND LOWER(model_id) NOT LIKE '%hermes%'   -- hermes-3-llama emits text tool calls
            AND LOWER(model_id) NOT LIKE '%llama-3.2%') -- 3B route declares no tool support (V23)
        OR LOWER(model_id) LIKE '%gemini-%'        -- every Gemini; gemma intentionally NOT matched
        OR LOWER(model_id) LIKE '%glm-%'           -- GLM 4.5+/5.x are agentic-tuned (zai/zhipu/CF/ollama)
        OR LOWER(model_id) LIKE '%qwen3%'
        OR LOWER(model_id) LIKE '%qwen-3%'         -- Qwen3 incl. coder/next variants
        OR LOWER(model_id) LIKE '%deepseek-v%'     -- V3.x/V4 function calling; excludes r1-distill
        OR LOWER(model_id) LIKE '%kimi-k2%'        -- K2 family is tool-native
        OR LOWER(model_id) LIKE '%minimax-m2%'     -- M2.x is agent-focused
        OR LOWER(model_id) LIKE '%mistral-large%'  -- Mistral API function calling (whole family)
        OR LOWER(model_id) LIKE '%mistral-medium%'
        OR LOWER(model_id) LIKE '%mistral-small%'
        OR LOWER(model_id) LIKE '%magistral%'
        OR LOWER(model_id) LIKE '%codestral%'
        OR LOWER(model_id) LIKE '%devstral%'
        OR LOWER(model_id) LIKE '%ministral%'
        OR LOWER(model_id) LIKE '%command-a%'      -- Cohere native tool use (benchmarked top-20)
        OR LOWER(model_id) LIKE '%command-r%'
        OR LOWER(model_id) LIKE '%gpt-4o%'         -- GitHub's OpenAI models
        OR LOWER(model_id) LIKE '%gpt-4.1%'
        OR LOWER(model_id) LIKE '%gpt-5%'
        OR LOWER(model_id) LIKE '%nemotron-3-super%' -- benchmarked #8 with real tool calls; nano stays excluded
        OR LOWER(model_id) LIKE '%nemotron-nano-12b-v2-vl%' -- unlike the 30B nano: live-probed structured tool_calls (V23, 2026-06-07)
        OR LOWER(model_id) LIKE '%nemotron-3-ultra%' -- structured tool_calls live-verified via Zen's dedicated endpoint (V24, 2026-06-07); covers the disabled OR row too
        OR LOWER(model_id) LIKE '%minimax-m3%'       -- finish_reason:tool_calls live-verified on Zen (V24)
        OR LOWER(model_id) LIKE '%north-mini-code%'  -- structured tool_calls + reasoning_content live-verified on Zen (V26, 2026-06-10)
        OR LOWER(model_id) LIKE '%big-pickle%'       -- structured tool_calls live-verified on OpenCode Zen (V27, 2026-06-27)
        OR LOWER(model_id) LIKE '%mimo%'             -- structured tool_calls + vision live-verified on OpenCode Zen (V27, 2026-06-27)
      )
    `).run();
  });
  apply();
}


function migrateModelsV23FreeTierAudit(db: Database.Database) {
  const apply = db.transaction(() => {
    for (const platform of ['sambanova', 'chutes']) {
      db.prepare(`
        DELETE FROM fallback_config WHERE model_db_id IN (
          SELECT id FROM models WHERE platform = ?
        )
      `).run(platform);
      db.prepare('DELETE FROM models WHERE platform = ?').run(platform);
      db.prepare('DELETE FROM api_keys WHERE platform = ?').run(platform);
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null, number, number, number]> = [
      ['openrouter', 'moonshotai/kimi-k2.6:free',                                     'Kimi K2.6 (OR free)',                 3, 9,  'Frontier', 20, 200, null, null, '~6M',  262144,  1, 0, 1],
      ['openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free',                        'Nemotron 3 Ultra 550B (free, slow)',  7, 11, 'Frontier', 20, 200, null, null, '~6M',  1000000, 0, 0, 1],
      ['openrouter', 'nvidia/nemotron-nano-12b-v2-vl:free',                           'Nemotron Nano 12B VL (free)',        26, 9,  'Medium',   20, 200, null, null, '~6M',  128000,  1, 1, 1],
      ['openrouter', 'meta-llama/llama-3.2-3b-instruct:free',                         'Llama 3.2 3B (free)',                30, 9,  'Small',    20, 200, null, null, '~6M',  131072,  1, 0, 0],
      ['openrouter', 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', 'Dolphin Mistral 24B Venice (free)',  25, 9,  'Medium',   20, 200, null, null, '~6M',  32768,   1, 0, 0],
      ['zhipu',      'glm-4.6v-flash',                                                'GLM-4.6V Flash',                     21, 4,  'Large',    null, null, null, null, '~30M', 131072,  1, 1, 1],
    ];
    for (const a of additions) insert.run(...a);
    backfillFallback(db);
  });
  apply();
}


function migrateModelsV24ZenRefresh(db: Database.Database) {
  const apply = db.transaction(() => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null, number, number, number]> = [
      ['opencode', 'nemotron-3-ultra-free', 'Nemotron 3 Ultra Free (OpenCode Zen)',  7, 4, 'Frontier', 20, 200, null, null, '~500M', 200000, 1, 0, 1],
      ['opencode', 'minimax-m3-free',       'MiniMax M3 Free (OpenCode Zen)',        4, 4, 'Frontier', 20, 200, null, null, '~500M', 131072, 1, 0, 1],
    ];
    for (const a of additions) insert.run(...a);
    backfillFallback(db);

    db.prepare(`
      UPDATE models SET enabled = 0
       WHERE platform = 'nvidia' AND model_id = 'google/gemma-4-31b-it'
    `).run();
  });
  apply();
}


function migrateModelsV25ZenDeadPromos(db: Database.Database) {
  const disable = db.prepare(`UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?`);
  const disables: Array<[string, string]> = [
    ['opencode', 'nemotron-3-super-free'],
    ['opencode', 'minimax-m3-free'],
  ];
  const apply = db.transaction(() => {
    for (const [p, m] of disables) disable.run(p, m);
  });
  apply();
}

















function migrateEmbeddingsV1(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      max_input_tokens INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      quota_label TEXT NOT NULL DEFAULT '',
      UNIQUE(platform, model_id)
    );
  `);

  
  
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'request_type')) {
    db.prepare("ALTER TABLE requests ADD COLUMN request_type TEXT NOT NULL DEFAULT 'chat'").run();
  }

  const seed = db.prepare(`
    INSERT OR IGNORE INTO embedding_models
      (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rows: Array<[string, string, string, string, number, number | null, number, number, string]> = [
    
    ['gemini-embedding-001', 'google', 'gemini-embedding-001', 'Gemini Embedding', 3072, 2048, 1, 1, '100 rpm · 1K req/day'],
    ['llama-nemotron-embed-vl-1b-v2', 'nvidia', 'nvidia/llama-nemotron-embed-vl-1b-v2', 'Nemotron Embed VL 1B', 2048, 8192, 1, 1, '~40 rpm'],
    ['llama-nemotron-embed-vl-1b-v2', 'openrouter', 'nvidia/llama-nemotron-embed-vl-1b-v2', 'Nemotron Embed VL 1B (OR)', 2048, 8192, 2, 1, '$0/M tok'],
    ['llama-nemotron-embed-1b-v2', 'nvidia', 'nvidia/llama-nemotron-embed-1b-v2', 'Nemotron Embed 1B', 2048, 8192, 1, 1, '~40 rpm'],
    ['nv-embedqa-e5-v5', 'nvidia', 'nvidia/nv-embedqa-e5-v5', 'NV-EmbedQA E5 v5', 1024, 512, 1, 1, '~40 rpm'],
    ['text-embedding-3-small', 'github', 'openai/text-embedding-3-small', 'Text Embedding 3 Small', 1536, 8191, 1, 1, 'rate-limited free'],
    ['text-embedding-3-large', 'github', 'openai/text-embedding-3-large', 'Text Embedding 3 Large', 3072, 8191, 1, 1, 'rate-limited free'],
    ['bge-m3', 'cloudflare', '@cf/baai/bge-m3', 'BGE-M3', 1024, 8192, 1, 1, '10K neurons/day (shared)'],
    ['bge-m3', 'huggingface', 'BAAI/bge-m3', 'BGE-M3 (HF)', 1024, 8192, 2, 1, '$0.10/mo credits'],
    ['embeddinggemma-300m', 'cloudflare', '@cf/google/embeddinggemma-300m', 'EmbeddingGemma 300M', 768, 2048, 1, 1, '10K neurons/day (shared)'],
    ['qwen3-embedding-0.6b', 'cloudflare', '@cf/qwen/qwen3-embedding-0.6b', 'Qwen3 Embedding 0.6B', 1024, 4096, 1, 1, '10K neurons/day (shared)'],
    
    
    ['embed-v4.0', 'cohere', 'embed-v4.0', 'Cohere Embed v4', 1536, 128000, 1, 0, '1K calls/mo (shared w/ chat)'],
  ];
  const apply = db.transaction(() => { for (const r of rows) seed.run(...r); });
  apply();

  const def = db.prepare("SELECT value FROM settings WHERE key = 'embeddings_default_family'").get();
  if (!def) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('embeddings_default_family', 'gemini-embedding-001')").run();
  }
}


function migrateMediaV1(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      modality TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      quota_label TEXT NOT NULL DEFAULT '',
      UNIQUE(platform, model_id)
    );
  `);
}


function migrateQuirksV1(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quirks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'info',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quirk_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quirk_id INTEGER NOT NULL REFERENCES quirks(id) ON DELETE CASCADE,
      platform TEXT,
      model_glob TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quirk_targets_quirk ON quirk_targets(quirk_id);
  `);

  
  
  
  
  
  db.prepare("DELETE FROM quirks WHERE slug = 'nvidia-credits-based'").run();

  
  
  type Seed = {
    slug: string;
    title: string;
    body: string;
    severity: 'info' | 'warning' | 'blocker';
    targets: Array<{ platform?: string; modelGlob?: string }>;
  };
  const seeds: Seed[] = [
    {
      slug: 'keyless-anonymous',
      title: 'No API key required',
      body: 'Routes anonymously — the catalog ships a keyless sentinel row and calls work with no account or key.',
      severity: 'info',
      targets: [{ platform: 'kilo' }, { platform: 'llm7' }, { platform: 'pollinations' }, { platform: 'ovh' }],
    },
    {
      slug: 'ovh-anon-trickle',
      title: 'Anonymous tier is 2 req/min',
      body: 'OVH AI Endpoints anonymous mode is documented at 2 req/min per IP per model (observed even stricter across models). The 400 req/min authenticated tier requires a Public Cloud project with a payment method, so the catalog ships the keyless path. Treat as a breadth/fallback tier, not a throughput tier.',
      severity: 'warning',
      targets: [{ platform: 'ovh' }],
    },
    {
      slug: 'pollinations-degraded',
      title: 'Anon tier degraded (1 concurrent)',
      body: 'Pollinations’ legacy text API is deprecated for authenticated users (replacement enter.pollinations.ai is pay-as-you-go), but anonymous access is explicitly unaffected. Anon is queue-limited to 1 concurrent request per IP and serves a single model (openai-fast); expect 429 "Queue full" under any parallelism. Live-probed 2026-06-10.',
      severity: 'warning',
      targets: [{ platform: 'pollinations' }],
    },
    {
      slug: 'or-free-cap-account-wide',
      title: 'Daily :free cap is account-wide',
      body: 'OpenRouter’s :free daily cap (50/day, or 1000/day once you have ever bought $10 of credits) is shared across ALL :free models on the account, not per model. Per-row rpd values here are therefore optimistic; the router’s cooldown handling absorbs the shared 429s.',
      severity: 'info',
      targets: [{ platform: 'openrouter', modelGlob: '*:free' }],
    },
    {
      slug: 'zen-promo-roster',
      title: 'Limited-time promo, roster rotates',
      body: 'OpenCode Zen free models are explicitly limited-time promotional access ("available for a limited time" per the docs), not a recurring quota. The roster rotates: qwen3.6-plus and minimax-m3 promos already ended. Expect any row here to die without notice; prompts/outputs may be used for model improvement.',
      severity: 'warning',
      targets: [{ platform: 'opencode' }],
    },
    {
      slug: 'cloudflare-key-format',
      title: 'Key is account_id:token',
      body: 'Cloudflare Workers AI authenticates with a combined credential in the form "account_id:token", not a bare token.',
      severity: 'info',
      targets: [{ platform: 'cloudflare' }],
    },
    {
      
      
      
      
      slug: 'nvidia-rate-limited',
      title: 'Recurring free, 40 RPM, eval-only ToS',
      body: 'NVIDIA NIM replaced its depleting trial credits with a recurring per-account rate limit (40 RPM default, varies by model), verified June 2026. The trial ToS still scopes usage to evaluation/prototyping, not production.',
      severity: 'info',
      targets: [{ platform: 'nvidia' }],
    },
    {
      slug: 'nim-gemma-hung',
      title: 'NIM gemma route hangs',
      body: 'The NVIDIA NIM gemma endpoint is listed but hangs (capacity starvation plus an upstream FlashAttention bug). Paused; probe with a 120s timeout before re-enabling.',
      severity: 'blocker',
      targets: [{ platform: 'nvidia', modelGlob: '*gemma*' }],
    },
    {
      slug: 'or-ultra-hangs',
      title: 'OpenRouter ultra route hangs',
      body: 'nemotron-3-ultra (550B) on OpenRouter takes 180s+ even on trivial prompts (heavily congested), so its OR row is seeded disabled. Use the OpenCode Zen route instead.',
      severity: 'warning',
      targets: [{ platform: 'openrouter', modelGlob: '*nemotron-3-ultra*' }],
    },
    {
      slug: 'zen-serves-ultra-fast',
      title: 'Zen serves the 550B fast',
      body: 'OpenCode Zen serves nemotron-3-ultra in ~2s with working tool calls where the OpenRouter route hangs — the live-verified path for this model.',
      severity: 'info',
      targets: [{ platform: 'opencode', modelGlob: '*nemotron-3-ultra*' }],
    },
    {
      slug: 'zhipu-shared-key',
      title: 'Works with existing Zhipu key',
      body: 'glm-4.6v-flash is listed Free on Z.AI and answers 200 with the existing bigmodel.cn key; vision and structured tool calls both live-verified.',
      severity: 'info',
      targets: [{ platform: 'zhipu', modelGlob: '*glm-4.6v*' }],
    },
  ];

  const now = Date.now();
  const upsertQuirk = db.prepare(`
    INSERT INTO quirks (slug, title, body, severity, created_at_ms, updated_at_ms)
    VALUES (@slug, @title, @body, @severity, @now, @now)
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      severity = excluded.severity,
      updated_at_ms = excluded.updated_at_ms
  `);
  const getId = db.prepare('SELECT id FROM quirks WHERE slug = ?');
  const clearTargets = db.prepare('DELETE FROM quirk_targets WHERE quirk_id = ?');
  const addTarget = db.prepare(
    'INSERT INTO quirk_targets (quirk_id, platform, model_glob) VALUES (?, ?, ?)',
  );

  const apply = db.transaction(() => {
    for (const s of seeds) {
      upsertQuirk.run({ slug: s.slug, title: s.title, body: s.body, severity: s.severity, now });
      const { id } = getId.get(s.slug) as { id: number };
      
      
      clearTargets.run(id);
      for (const t of s.targets) addTarget.run(id, t.platform ?? null, t.modelGlob ?? null);
    }
  });
  apply();
}


function backfillFallback(db: Database.Database) {
  const missing = db.prepare(`
    SELECT m.id FROM models m
    LEFT JOIN fallback_config f ON m.id = f.model_db_id
    WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
  `).all() as { id: number }[];
  if (missing.length > 0) {
    const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
    const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
    for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
  }
}

function ensureUnifiedKey(db: Database.Database) {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
  if (!existing) {
    const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
    db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(key);
    console.log(`\n  Your unified API key: ${key}\n`);
  }
}


function migrateProfilesInit(db: Database.Database) {
  
  db.prepare(`
    UPDATE profiles
    SET type = 'custom'
    WHERE type = 'builtin'
  `).run();

  
  const hasDefault = db.prepare("SELECT COUNT(*) as cnt FROM profiles WHERE type = 'default'").get() as { cnt: number };
  if (hasDefault.cnt === 0) {
    const minOrder = (db.prepare('SELECT COALESCE(MIN(sort_order), 0) AS mn FROM profiles').get() as { mn: number }).mn;
    const targetOrder = Math.min(-1, minOrder - 1);

    const result = db.prepare(
      "INSERT INTO profiles (name, emoji, color, type, sort_order) VALUES ('Default', '⚙️', '#6366f1', 'default', ?)"
    ).run(targetOrder);

    const profileId = result.lastInsertRowid as number;

    
    db.prepare(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      SELECT ?, model_db_id, priority, enabled
      FROM fallback_config
      ORDER BY priority ASC
    `).run(profileId);

    
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(String(profileId));

    console.log('Created Default profile');
  } else {
    
    db.prepare(`
      UPDATE profiles
      SET emoji = '⚙️'
      WHERE type = 'default' AND emoji != '⚙️'
    `).run();
  }
}
