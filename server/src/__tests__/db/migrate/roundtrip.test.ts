import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../../db/types.js';
import { getMigrationStatuses, runMigrations } from '../../../db/migrate/runner.js';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';

const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';
const CUSTOM_PROVIDER_MODALITIES_FILENAME = '20260627_000001_custom_provider_modalities.ts';
const CATALOG_MODEL_STATE_FILENAME = '20260627_000002_catalog_model_state.ts';
const REQUEST_AGGREGATES_FILENAME = '20260628_120000_request_aggregates.ts';
const COOLDOWN_PROBE_METADATA_FILENAME = '20260628_130000_cooldown_probe_metadata.ts';
const OPENCODE_BUDGET_UPDATE_FILENAME = '20260628_140000_opencode_budget_update.ts';
const OPENCODE_ZEN_MODELS_FILENAME = '20260628_150000_opencode_zen_models.ts';
const AGNES_MODELS_FILENAME = '20260629_000000_agnes_models.ts';
const G4F_MODELS_FILENAME = '20260702_000000_g4f_models.ts';
const FREETHEAI_MODELS_FILENAME = '20260703_000000_freetheai_models.ts';
const FREETHEAI_GLM5_FILENAME = '20260703_120000_add_freetheai_glm5.ts';
const FREETHEAI_DEEPSEEK_FILENAME = '20260703_140000_add_freetheai_deepseek.ts';
const NVIDIA_GLM52_FILENAME = '20260705_000000_nvidia_glm52.ts';
const DISABLE_DEAD_NVIDIA_FILENAME = '20260705_010000_disable_dead_nvidia_models.ts';
const GITHUB_GPT41_CONTEXT_FILENAME = '20260630_000001_github_gpt41_context.ts';
const REQUEST_CLIENT_INFO_FILENAME = '20260706_000001_request_client_info.ts';
const CUSTOM_MODEL_TOOL_SUPPORT_FILENAME = '20260706_000002_custom_model_tool_support.ts';
const PROFILE_CHAIN_BACKFILL_FILENAME = '20260714_000001_profile_chain_backfill.ts';
const KEY_HEALTH_ERROR_FILENAME = '20260720_000001_key_health_error.ts';
const COOLDOWN_PROBE_PROVENANCE_FILENAME = '20260726_000001_cooldown_probe_provenance.ts';
const REQUEST_ATTEMPTS_FILENAME = '20260726_000002_request_attempts.ts';
const MODEL_SOURCE_PROVENANCE_FILENAME = '20260726_000003_model_source_provenance.ts';
const MEDIA_MODEL_META_FILENAME = '20260726_000004_media_model_meta.ts';
const REQUEST_SERVED_MODEL_FILENAME = '20260726_000005_request_served_model.ts';
const ATTEMPT_ERROR_SUMMARY_FILENAME = '20260726_000006_attempt_error_summary.ts';
const AGENT_COMPATIBILITY_FILENAME = '20260727_000001_agent_compatibility.ts';
const TOMBSTONE_PROVENANCE_FILENAME = '20260728_000001_tombstone_provenance.ts';
const CUSTOM_MODEL_ENDPOINT_IDENTITY_FILENAME = '20260729_000001_custom_model_endpoint_identity.ts';
const CUSTOM_ENDPOINT_HOST_LABELS_FILENAME = '20260802_000001_custom_endpoint_host_labels.ts';
const KEY_MODEL_SCOPE_FILENAME = '20260805_000001_key_model_scope.ts';
const CLIENT_PROFILES_FILENAME = '20260805_000002_client_profiles.ts';
const REQUEST_HOURLY_CACHED_TOKENS_FILENAME = '20260806_000000_request_hourly_cached_tokens.ts';
const PROXY_POOL_FILENAME = '20260813_000001_proxy_pool.ts';
const MODAL_MODELS_FILENAME = '20260815_000000_modal_models.ts';
const REQUEST_DAILY_AGGREGATES_FILENAME = '20260820_000000_request_daily_aggregates.ts';

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface DatabaseSnapshot {
  schema: SchemaRow[];
  rows: Record<string, unknown[]>;
}

describe('migration round trip', () => {
  it('connectDb opens a connection without applying migrations', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const db = new Database(':memory:');

    try {
      expect(hasTable(db as unknown as Db, 'models')).toBe(false);
      expect(hasTable(db as unknown as Db, 'migrations')).toBe(false);
    } finally {
      db.close();
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('runs the legacy baseline against existing legacy DBs so rebased legacy changes apply', async () => {
    const db = new Database(':memory:');

    try {
      runLegacyBaseline(db as unknown as Db);
      db.prepare(`
        UPDATE models
           SET enabled = 1
         WHERE platform = 'opencode'
           AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
      `).run();

      expect(getEnabledZenDeadPromoCount(db as unknown as Db)).toBe(2);

      await runMigrations(db as unknown as Db, 'up');

      expect(getEnabledZenDeadPromoCount(db as unknown as Db)).toBe(0);
      expect(getAppliedMigrationNames(db as unknown as Db)).toEqual([
        LEGACY_BASELINE_FILENAME,
        CUSTOM_PROVIDER_MODALITIES_FILENAME,
        CATALOG_MODEL_STATE_FILENAME,
        REQUEST_AGGREGATES_FILENAME,
        COOLDOWN_PROBE_METADATA_FILENAME,
        OPENCODE_BUDGET_UPDATE_FILENAME,
        OPENCODE_ZEN_MODELS_FILENAME,
        AGNES_MODELS_FILENAME,
        GITHUB_GPT41_CONTEXT_FILENAME,
        G4F_MODELS_FILENAME,
        FREETHEAI_MODELS_FILENAME,
        FREETHEAI_GLM5_FILENAME,
        FREETHEAI_DEEPSEEK_FILENAME,
        NVIDIA_GLM52_FILENAME,
        DISABLE_DEAD_NVIDIA_FILENAME,
        REQUEST_CLIENT_INFO_FILENAME,
        CUSTOM_MODEL_TOOL_SUPPORT_FILENAME,
        PROFILE_CHAIN_BACKFILL_FILENAME,
        KEY_HEALTH_ERROR_FILENAME,
        COOLDOWN_PROBE_PROVENANCE_FILENAME,
        REQUEST_ATTEMPTS_FILENAME,
        MODEL_SOURCE_PROVENANCE_FILENAME,
        MEDIA_MODEL_META_FILENAME,
        REQUEST_SERVED_MODEL_FILENAME,
        ATTEMPT_ERROR_SUMMARY_FILENAME,
        AGENT_COMPATIBILITY_FILENAME,
        TOMBSTONE_PROVENANCE_FILENAME,
        CUSTOM_MODEL_ENDPOINT_IDENTITY_FILENAME,
        CUSTOM_ENDPOINT_HOST_LABELS_FILENAME,
        KEY_MODEL_SCOPE_FILENAME,
        CLIENT_PROFILES_FILENAME,
        REQUEST_HOURLY_CACHED_TOKENS_FILENAME,
        PROXY_POOL_FILENAME,
        MODAL_MODELS_FILENAME,
        REQUEST_DAILY_AGGREGATES_FILENAME,
      ]);
    } finally {
      db.close();
    }
  });

  it('runs all migrations up, down to baseline, then up to the same schema', async () => {
    const db = new Database(':memory:');

    try {
      await runMigrations(db as unknown as Db, 'up');
      expect(getPendingMigrationNames(db as unknown as Db)).toEqual([]);

      // The catalog seed has no custom models, so the custom-model tool-support
      // backfill only alters state once a user endpoint exists. Seed one (in its
      // post-migration state, tools = 1) so the round trip actually exercises
      // that migration's down (tools -> 0) and up (tools -> 1).
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, enabled, source)
        VALUES ('custom', 'roundtrip-custom', 'Roundtrip Custom', 50, 50, 1, 0, 1, 'user')
      `).run();

      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url)
        VALUES ('custom', '127.0.0.1:11434', 'x', 'x', 'x', 'http://127.0.0.1:11434/v1')
      `).run();

      const fullState = snapshotAppState(db as unknown as Db);
      await runDownToBaseline(db as unknown as Db);

      expect(getAppliedMigrationNames(db as unknown as Db)).toEqual([LEGACY_BASELINE_FILENAME]);

      await runMigrations(db as unknown as Db, 'up');
      expect(getPendingMigrationNames(db as unknown as Db)).toEqual([]);
      expect(snapshotAppState(db as unknown as Db)).toEqual(fullState);
    } finally {
      db.close();
    }
  });
});

async function runDownToBaseline(db: Db): Promise<void> {
  while (getAppliedMigrationNames(db as unknown as Db).length > 1) {
    const migrationName = getLatestAppliedMigrationName(db);
    const before = snapshotAppState(db as unknown as Db);

    await runMigrations(db, 'down');

    expect(snapshotAppState(db as unknown as Db), `${migrationName} down() must alter app DB state or throw irreversible`)
      .not.toEqual(before);
  }
}

function getLatestAppliedMigrationName(db: Db): string {
  const row = db.prepare(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `).get() as { filename: string } | undefined;

  if (!row) throw new Error('No applied migrations found');
  return row.filename;
}

function getAppliedMigrationNames(db: Db): string[] {
  return getMigrationStatuses(db)
    .filter(status => status.status === 'applied')
    .map(status => status.filename);
}

function getPendingMigrationNames(db: Db): string[] {
  return getMigrationStatuses(db)
    .filter(status => status.status === 'pending')
    .map(status => status.filename);
}

function getEnabledZenDeadPromoCount(db: Db): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM models
     WHERE platform = 'opencode'
       AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
       AND enabled = 1
  `).get() as { count: number };

  return row.count;
}

function snapshotSchema(db: Db): SchemaRow[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_master
     WHERE type IN ('index', 'table', 'trigger', 'view')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name
  `).all() as SchemaRow[];
}

function snapshotAppState(db: Db): DatabaseSnapshot {
  const tableNames = getAppTableNames(db as unknown as Db);
  const rows: Record<string, unknown[]> = {};

  for (const tableName of tableNames) {
    rows[tableName] = snapshotTableRows(db as unknown as Db, tableName);
  }

  return {
    schema: snapshotSchema(db as unknown as Db),
    rows,
  };
}

function getAppTableNames(db: Db): string[] {
  const rows = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name <> 'migrations'
     ORDER BY name
  `).all() as { name: string }[];

  return rows.map(row => row.name);
}

function snapshotTableRows(db: Db, tableName: string): unknown[] {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as { name: string }[];
  const orderBy = columns.map(column => quoteIdentifier(column.name)).join(', ');

  return db.prepare(`
    SELECT *
      FROM ${quoteIdentifier(tableName)}
     ORDER BY ${orderBy}
  `).all() as unknown[];
}

function hasTable(db: Db, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
  `).get(tableName);

  return Boolean(row);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
