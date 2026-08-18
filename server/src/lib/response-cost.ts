import type { Db } from '../db/types.js';
import { getDb, getSetting } from '../db/index.js';
import { FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, CACHE_READ_PRICE_FACTOR } from '../db/model-pricing.js';

export interface ResponsePricing {
  paid_input_per_m: number | null;
  paid_output_per_m: number | null;
  paid_cached_per_m: number | null;
}

export interface CostTokens {
  prompt: number;
  completion: number;
  cached: number;
}

let pricingStmt: ReturnType<Db['prepare']> | undefined;

export function isCostTrackingEnabled(): boolean {
  const db = getSetting('cost_tracking_enabled');
  if (db === '1' || db === '0') return db === '1';
  const raw = process.env.FREELLMAPI_COST_TRACKING?.trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true';
}

export function getResponsePricing(platform: string, modelId: string): ResponsePricing | null {
  if (!pricingStmt) {
    pricingStmt = getDb().prepare(
      'SELECT paid_input_per_m, paid_output_per_m, paid_cached_per_m FROM models WHERE platform = ? AND model_id = ?',
    );
  }
  const row = pricingStmt.get(platform, modelId) as ResponsePricing | undefined;
  return row ?? null;
}

export function computeResponseCost(tokens: CostTokens, pricing: ResponsePricing | null): number {
  const inputPrice = pricing?.paid_input_per_m ?? FALLBACK_INPUT_PER_M;
  const outputPrice = pricing?.paid_output_per_m ?? FALLBACK_OUTPUT_PER_M;
  const cachedPrice = pricing?.paid_cached_per_m ?? (pricing?.paid_input_per_m ?? FALLBACK_INPUT_PER_M) * CACHE_READ_PRICE_FACTOR;
  const uncachedInput = Math.max(tokens.prompt - tokens.cached, 0);
  const cost =
    uncachedInput * inputPrice / 1_000_000 +
    tokens.completion * outputPrice / 1_000_000 +
    tokens.cached * cachedPrice / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function responseCostFor(platform: string, modelId: string, tokens: CostTokens): number | undefined {
  if (!isCostTrackingEnabled()) return undefined;
  return computeResponseCost(tokens, getResponsePricing(platform, modelId));
}