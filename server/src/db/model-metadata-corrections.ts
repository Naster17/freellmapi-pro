import type Database from 'better-sqlite3';

interface ModelMetadataCorrection {
  platform: string;
  modelId: string;
  contextWindow: number;
}

const CONTEXT_CORRECTIONS: ModelMetadataCorrection[] = [
  { platform: 'cerebras', modelId: 'zai-glm-4.7', contextWindow: 65536 },
  { platform: 'cerebras', modelId: 'gpt-oss-120b', contextWindow: 65536 },
  { platform: 'cloudflare', modelId: '@cf/openai/gpt-oss-120b', contextWindow: 128000 },
  { platform: 'cloudflare', modelId: '@cf/qwen/qwen3-30b-a3b-fp8', contextWindow: 32768 },
  { platform: 'cloudflare', modelId: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', contextWindow: 80000 },
  { platform: 'cloudflare', modelId: '@cf/nvidia/nemotron-3-120b-a12b', contextWindow: 256000 },
  { platform: 'cloudflare', modelId: '@cf/google/gemma-4-26b-a4b-it', contextWindow: 256000 },
  { platform: 'google', modelId: 'gemma-4-26b-a4b-it', contextWindow: 262144 },
  { platform: 'google', modelId: 'gemma-4-31b-it', contextWindow: 262144 },
  { platform: 'github', modelId: 'gpt-4o', contextWindow: 128000 },
  { platform: 'huggingface', modelId: 'deepseek-ai/DeepSeek-V4-Flash', contextWindow: 1000000 },
  { platform: 'kilo', modelId: 'nvidia/nemotron-3-super-120b-a12b:free', contextWindow: 1000000 },
  { platform: 'mistral', modelId: 'mistral-large-latest', contextWindow: 256000 },
  { platform: 'mistral', modelId: 'mistral-medium-latest', contextWindow: 256000 },
  { platform: 'mistral', modelId: 'mistral-small-latest', contextWindow: 256000 },
  { platform: 'mistral', modelId: 'codestral-latest', contextWindow: 128000 },
  { platform: 'mistral', modelId: 'devstral-latest', contextWindow: 256000 },
  { platform: 'mistral', modelId: 'ministral-8b-latest', contextWindow: 256000 },
  { platform: 'ollama', modelId: 'glm-4.7', contextWindow: 198008 },
  { platform: 'ollama', modelId: 'gemma4:31b', contextWindow: 262144 },
  { platform: 'openrouter', modelId: 'poolside/laguna-m.1:free', contextWindow: 262144 },
  { platform: 'openrouter', modelId: 'poolside/laguna-xs.2:free', contextWindow: 262144 },
  { platform: 'openrouter', modelId: 'nvidia/nemotron-3-nano-30b-a3b:free', contextWindow: 256000 },
  { platform: 'openrouter', modelId: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', contextWindow: 256000 },
  { platform: 'openrouter', modelId: 'nvidia/nemotron-3-super-120b-a12b:free', contextWindow: 1000000 },
  { platform: 'zhipu', modelId: 'glm-4.7-flash', contextWindow: 204800 },
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
