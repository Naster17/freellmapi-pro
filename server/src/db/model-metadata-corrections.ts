import type Database from 'better-sqlite3';

interface ModelMetadataCorrection {
  platform: string;
  modelId: string;
  contextWindow: number;
}

// Local corrections for provider/catalog rows that are known to be stale.
// Keep this small and evidence-backed; catalog sync remains authoritative for
// normal model churn, but should not re-apply values contradicted by providers.
const CONTEXT_CORRECTIONS: ModelMetadataCorrection[] = [
  { platform: 'google', modelId: 'gemma-4-26b-a4b-it', contextWindow: 262144 },
  { platform: 'google', modelId: 'gemma-4-31b-it', contextWindow: 262144 },
  { platform: 'github', modelId: 'gpt-4o', contextWindow: 128000 },
];

export function applyModelMetadataCorrections(db: Database.Database): void {
  const updateContext = db.prepare(`
    UPDATE models
       SET context_window = ?
     WHERE platform = ?
       AND model_id = ?
       AND (context_window IS NULL OR context_window != ?)
  `);

  const apply = db.transaction(() => {
    for (const c of CONTEXT_CORRECTIONS) {
      updateContext.run(c.contextWindow, c.platform, c.modelId, c.contextWindow);
    }
  });
  apply();
}
