import type { Db } from '../types.js';

const DEAD_MODELS = [
  ['nvidia', 'deepseek-ai/deepseek-v4-flash'],
  ['nvidia', 'deepseek-ai/deepseek-v4-pro'],
  ['nvidia', 'minimaxai/minimax-m2.7'],
  ['nvidia', 'meta/llama-4-maverick-17b-128e-instruct'],
  ['nvidia', 'mistralai/mistral-large-3-675b-instruct-2512'],
  ['nvidia', 'z-ai/glm-5.2'],
  ['opencode', 'muse-spark-1.2-contributor-free'],
  ['kilo', 'poolside/laguna-m.1:free'],
  ['openrouter', 'poolside/laguna-m.1:free'],
  ['groq', 'llama-3.1-8b-instant'],
  ['groq', 'llama-3.3-70b-versatile'],
  ['groq', 'meta-llama/llama-4-scout-17b-16e-instruct'],
  ['groq', 'qwen/qwen3-32b'],
] as const;

const GONE_PLATFORMS = ['freetheai', 'ovh'] as const;

export function up(db: Db): void {
  for (const [platform, modelId] of DEAD_MODELS) {
    db.prepare('UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?').run(platform, modelId);
  }
  const disablePlatform = db.prepare('UPDATE models SET enabled = 0 WHERE platform = ?');
  for (const platform of GONE_PLATFORMS) {
    disablePlatform.run(platform);
  }
}

export function down(db: Db): void {
  for (const [platform, modelId] of DEAD_MODELS) {
    db.prepare('UPDATE models SET enabled = 1 WHERE platform = ? AND model_id = ?').run(platform, modelId);
  }
  const enablePlatform = db.prepare('UPDATE models SET enabled = 1 WHERE platform = ?');
  for (const platform of GONE_PLATFORMS) {
    enablePlatform.run(platform);
  }
}
