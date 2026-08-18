import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { computeResponseCost, getResponsePricing, isCostTrackingEnabled } from '../../lib/response-cost.js';

describe('computeResponseCost', () => {
  it('uses explicit pricing for uncached input, output, and cached tokens', () => {
    const cost = computeResponseCost(
      { prompt: 100_000, completion: 40_000, cached: 20_000 },
      { paid_input_per_m: 2, paid_output_per_m: 8, paid_cached_per_m: 0.5 },
    );
    expect(cost).toBeCloseTo(0.49);
  });

  it('derives the cached rate from the input rate when the cached price is null', () => {
    const cost = computeResponseCost(
      { prompt: 100_000, completion: 40_000, cached: 20_000 },
      { paid_input_per_m: 2, paid_output_per_m: 8, paid_cached_per_m: null },
    );
    expect(cost).toBeCloseTo(0.49);
  });

  it('falls back to the global fallback prices when no pricing row exists', () => {
    const cost = computeResponseCost({ prompt: 0, completion: 1000, cached: 0 }, null);
    expect(cost).toBeCloseTo(0.0008);
  });

  it('uses the input-based cached rate when the whole pricing row is missing', () => {
    const cost = computeResponseCost({ prompt: 100, completion: 0, cached: 500 }, null);
    expect(cost).toBeCloseTo(0.000025);
  });

  it('never charges un-cached input for tokens already counted as cached', () => {
    const cost = computeResponseCost(
      { prompt: 100, completion: 0, cached: 500 },
      { paid_input_per_m: 1, paid_output_per_m: 1, paid_cached_per_m: 1 },
    );
    expect(cost).toBeCloseTo(500 / 1_000_000);
  });

  it('rounds to six decimal places', () => {
    const cost = computeResponseCost({ prompt: 123_457, completion: 0, cached: 0 }, { paid_input_per_m: 1, paid_output_per_m: 1, paid_cached_per_m: null });
    expect(cost).toBe(0.123457);
  });
});

describe('getResponsePricing', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('reads the seeded bundled prices for a known platform/model', () => {
    expect(getResponsePricing('groq', 'llama-3.3-70b-versatile')).toEqual({
      paid_input_per_m: 0.1,
      paid_output_per_m: 0.32,
      paid_cached_per_m: null,
    });
  });

  it('returns null for a model with no pricing row', () => {
    expect(getResponsePricing('groq', 'no-such-model')).toBeNull();
  });

  it('is disabled when no setting refers to a value', () => {
    getDb().prepare("DELETE FROM settings WHERE key = 'cost_tracking_enabled'").run();
    expect(isCostTrackingEnabled()).toBe(false);
  });
});