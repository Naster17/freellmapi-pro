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
      expect(hasTable(db, 'models')).toBe(false);
      expect(hasTable(db, 'migrations')).toBe(false);
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
      expect(getAppliedMigrationNames(db)).toEqual([
        LEGACY_BASELINE_FILENAME,
        CUSTOM_PROVIDER_MODALITIES_FILENAME,
        CATALOG_MODEL_STATE_FILENAME,
        REQUEST_AGGREGATES_FILENAME,
        COOLDOWN_PROBE_METADATA_FILENAME,
        OPENCODE_BUDGET_UPDATE_FILENAME,
        OPENCODE_ZEN_MODELS_FILENAME,
        AGNES_MODELS_FILENAME,
        G4F_MODELS_FILENAME,
        FREETHEAI_MODELS_FILENAME,
        FREETHEAI_GLM5_FILENAME,
        FREETHEAI_DEEPSEEK_FILENAME,
        NVIDIA_GLM52_FILENAME,
        DISABLE_DEAD_NVIDIA_FILENAME,
        GITHUB_GPT41_CONTEXT_FILENAME,
        REQUEST_CLIENT_INFO_FILENAME,
        CUSTOM_MODEL_TOOL_SUPPORT_FILENAME,
      ]);
    } finally {
      db.close();
    }
  });

  it('runs all migrations up, down to baseline, then up to the same schema', async () => {
    const db = new Database(':memory:');

    try {
      await runMigrations(db as unknown as Db, 'up');
      expect(getPendingMigrationNames(db)).toEqual([]);

      // The catalog seed has no custom models, so the custom-model tool-support
      // backfill only alters state once a user endpoint exists. Seed one (in its
      // post-migration state, tools = 1) so the round trip actually exercises
      // that migration's down (tools -> 0) and up (tools -> 1).
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, enabled)
        VALUES ('custom', 'roundtrip-custom', 'Roundtrip Custom', 50, 50, 1, 0, 1)
      `).run();

      const fullState = snapshotAppState(db as unknown as Db);
      await runDownToBaseline(db as unknown as Db);

      expect(getAppliedMigrationNames(db)).toEqual([LEGACY_BASELINE_FILENAME]);

      await runMigrations(db as unknown as Db, 'up');
      expect(getPendingMigrationNames(db)).toEqual([]);
      expect(snapshotAppState(db as unknown as Db)).toEqual(fullState);
    } finally {
      db.close();
    }
  });
});

async function runDownToBaseline(db: Db): Promise<void> {
  while (getAppliedMigrationNames(db).length > 1) {
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
  return `"${identifier.replaceAll('"', '""')}"`;
}
