import type Database from 'better-sqlite3';
import * as legacyBaseline from '../migrations/20260101_000000_legacy_baseline.js';

import * as customProviderModalities from '../migrations/20260627_000001_custom_provider_modalities.js';

import * as catalogModelState from '../migrations/20260627_000002_catalog_model_state.js';

import * as requestAggregates from '../migrations/20260628_120000_request_aggregates.js';

import * as cooldownProbeMetadata from '../migrations/20260628_130000_cooldown_probe_metadata.js';

import * as opencodeBudgetUpdate from '../migrations/20260628_140000_opencode_budget_update.js';

export interface MigrationModule {
  up(db: Database.Database): void;
  down(db: Database.Database): void;
}

export interface DefaultMigration {
  filename: string;
  module: MigrationModule;
}

export const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';
export const CUSTOM_PROVIDER_MODALITIES_FILENAME = '20260627_000001_custom_provider_modalities.ts';
export const CATALOG_MODEL_STATE_FILENAME = '20260627_000002_catalog_model_state.ts';
export const REQUEST_AGGREGATES_FILENAME = '20260628_120000_request_aggregates.ts';
export const COOLDOWN_PROBE_METADATA_FILENAME = '20260628_130000_cooldown_probe_metadata.ts';
export const OPENCODE_BUDGET_UPDATE_FILENAME = '20260628_140000_opencode_budget_update.ts';

export const DEFAULT_MIGRATIONS: readonly DefaultMigration[] = [
  { filename: LEGACY_BASELINE_FILENAME, module: legacyBaseline },
  { filename: CUSTOM_PROVIDER_MODALITIES_FILENAME, module: customProviderModalities },
  { filename: CATALOG_MODEL_STATE_FILENAME, module: catalogModelState },
  { filename: REQUEST_AGGREGATES_FILENAME, module: requestAggregates },
  { filename: COOLDOWN_PROBE_METADATA_FILENAME, module: cooldownProbeMetadata },
  { filename: OPENCODE_BUDGET_UPDATE_FILENAME, module: opencodeBudgetUpdate },
];