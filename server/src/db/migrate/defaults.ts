import type { Db } from '../types.js';
import * as legacyBaseline from '../migrations/20260101_000000_legacy_baseline.js';

import * as customProviderModalities from '../migrations/20260627_000001_custom_provider_modalities.js';

import * as catalogModelState from '../migrations/20260627_000002_catalog_model_state.js';

import * as requestAggregates from '../migrations/20260628_120000_request_aggregates.js';
import * as githubGpt41Context from '../migrations/20260630_000001_github_gpt41_context.js';
import * as requestClientInfo from '../migrations/20260706_000001_request_client_info.js';
import * as customModelToolSupport from '../migrations/20260706_000002_custom_model_tool_support.js';

import * as cooldownProbeMetadata from '../migrations/20260628_130000_cooldown_probe_metadata.js';

import * as opencodeBudgetUpdate from '../migrations/20260628_140000_opencode_budget_update.js';

import * as opencodeZenModels from '../migrations/20260628_150000_opencode_zen_models.js';

import * as agnesModels from '../migrations/20260629_000000_agnes_models.js';

import * as g4fModels from '../migrations/20260702_000000_g4f_models.js';

import * as freetheaiModels from '../migrations/20260703_000000_freetheai_models.js';

import * as freetheaiGlm5 from '../migrations/20260703_120000_add_freetheai_glm5.js';

import * as freetheaiDeepseek from '../migrations/20260703_140000_add_freetheai_deepseek.js';

import * as nvidiaGlm52 from '../migrations/20260705_000000_nvidia_glm52.js';

import * as disableDeadNvidia from '../migrations/20260705_010000_disable_dead_nvidia_models.js';

export interface MigrationModule {
  up(db: Db): void;
  down(db: Db): void;
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
export const OPENCODE_ZEN_MODELS_FILENAME = '20260628_150000_opencode_zen_models.ts';
export const AGNES_MODELS_FILENAME = '20260629_000000_agnes_models.ts';
export const G4F_MODELS_FILENAME = '20260702_000000_g4f_models.ts';
export const FREETHEAI_MODELS_FILENAME = '20260703_000000_freetheai_models.ts';
export const FREETHEAI_GLM5_FILENAME = '20260703_120000_add_freetheai_glm5.ts';
export const FREETHEAI_DEEPSEEK_FILENAME = '20260703_140000_add_freetheai_deepseek.ts';
export const NVIDIA_GLM52_FILENAME = '20260705_000000_nvidia_glm52.ts';
export const DISABLE_DEAD_NVIDIA_FILENAME = '20260705_010000_disable_dead_nvidia_models.ts';
export const GITHUB_GPT41_CONTEXT_FILENAME = '20260630_000001_github_gpt41_context.ts';
export const REQUEST_CLIENT_INFO_FILENAME = '20260706_000001_request_client_info.ts';
export const CUSTOM_MODEL_TOOL_SUPPORT_FILENAME = '20260706_000002_custom_model_tool_support.ts';

export const DEFAULT_MIGRATIONS: readonly DefaultMigration[] = [
  { filename: LEGACY_BASELINE_FILENAME, module: legacyBaseline },
  { filename: CUSTOM_PROVIDER_MODALITIES_FILENAME, module: customProviderModalities },
  { filename: CATALOG_MODEL_STATE_FILENAME, module: catalogModelState },
  { filename: REQUEST_AGGREGATES_FILENAME, module: requestAggregates },
  { filename: COOLDOWN_PROBE_METADATA_FILENAME, module: cooldownProbeMetadata },
  { filename: OPENCODE_BUDGET_UPDATE_FILENAME, module: opencodeBudgetUpdate },
  { filename: OPENCODE_ZEN_MODELS_FILENAME, module: opencodeZenModels },
  { filename: AGNES_MODELS_FILENAME, module: agnesModels },
  { filename: G4F_MODELS_FILENAME, module: g4fModels },
  { filename: FREETHEAI_MODELS_FILENAME, module: freetheaiModels },
  { filename: FREETHEAI_GLM5_FILENAME, module: freetheaiGlm5 },
  { filename: FREETHEAI_DEEPSEEK_FILENAME, module: freetheaiDeepseek },
  { filename: NVIDIA_GLM52_FILENAME, module: nvidiaGlm52 },
  { filename: DISABLE_DEAD_NVIDIA_FILENAME, module: disableDeadNvidia },
  { filename: GITHUB_GPT41_CONTEXT_FILENAME, module: githubGpt41Context },
  { filename: REQUEST_CLIENT_INFO_FILENAME, module: requestClientInfo },
  { filename: CUSTOM_MODEL_TOOL_SUPPORT_FILENAME, module: customModelToolSupport },
];
