import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import {
  canMakeRequest,
  canUseTokens,
  canUseProvider,
  canUseProviderMinute,
  canUseProviderTokens,
  getSoftLimitsEnabled,
  setSoftLimitsEnabled,
  recordRequest,
  recordTokens,
  getRateLimitStatus,
} from '../../services/ratelimit.js';

/**
 * Advisory (soft) limits: the seeded catalog numbers (opencode 20 rpm / 200 rpd,
 * OpenRouter's 1000/day account cap, ...) are guesses, and hard pre-checks on
 * them artificially bench keys whose provider would still serve. In soft mode
 * every count-based gate passes regardless of the counters — the provider's own
 * 429 (handled by the cooldown machinery) is the only judge — while usage still
 * records for the dashboard.
 */
describe('advisory (soft) rate limits', () => {
  let keyId: number;

  beforeEach(() => {
    initDb(':memory:');
    setSoftLimitsEnabled(true);
    keyId = Math.floor(Math.random() * 1_000_000);
  });

  afterEach(() => {
    delete process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA;
    delete process.env.PROVIDER_DAILY_REQUEST_CAP_OPENROUTER;
  });

  it('defaults to ON when no setting is stored', () => {
    getDb().prepare("DELETE FROM settings WHERE key = 'routing_soft_limits'").run();
    expect(getSoftLimitsEnabled()).toBe(true);
  });

  it('toggles through the persisted setting', () => {
    expect(getSoftLimitsEnabled()).toBe(true);
    setSoftLimitsEnabled(false);
    expect(getSoftLimitsEnabled()).toBe(false);
    setSoftLimitsEnabled(true);
    expect(getSoftLimitsEnabled()).toBe(true);
  });

  it('passes requests past an exhausted RPM/RPD budget', () => {
    const limits = { rpm: 1, rpd: 1, tpm: null, tpd: null };
    recordRequest('opencode', 'deepseek-v4-flash-free', keyId);
    recordRequest('opencode', 'deepseek-v4-flash-free', keyId);
    expect(canMakeRequest('opencode', 'deepseek-v4-flash-free', keyId, limits)).toBe(true);
  });

  it('passes tokens past an exhausted TPM/TPD budget', () => {
    const limits = { rpm: null, rpd: null, tpm: 3000, tpd: 5000 };
    recordTokens('opencode', 'deepseek-v4-flash-free', keyId, 4000);
    expect(canUseTokens('opencode', 'deepseek-v4-flash-free', keyId, 2000, limits)).toBe(true);
  });

  it('passes a provider account past its daily request cap', () => {
    process.env.PROVIDER_DAILY_REQUEST_CAP_OPENROUTER = '3';
    recordRequest('openrouter', 'm1', keyId);
    recordRequest('openrouter', 'm2', keyId);
    recordRequest('openrouter', 'm3', keyId);
    expect(canUseProvider('openrouter', keyId)).toBe(true);
  });

  it('passes a provider account past its per-minute request cap', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '2';
    recordRequest('nvidia', 'glm-4.7', keyId);
    recordRequest('nvidia', 'minimax-m3', keyId);
    expect(canUseProviderMinute('nvidia', keyId)).toBe(true);
  });

  it('passes a provider account past its daily token cap', () => {
    recordTokens('navy', 'gemini-2.5-flash', keyId, 200_000);
    expect(canUseProviderTokens('navy', keyId, 'gemini-2.5-flash', 100_000)).toBe(true);
  });

  it('still records usage so the dashboard keeps counting', () => {
    recordRequest('opencode', 'deepseek-v4-flash-free', keyId);
    recordTokens('opencode', 'deepseek-v4-flash-free', keyId, 500);
    const status = getRateLimitStatus('opencode', 'deepseek-v4-flash-free', keyId, {
      rpm: 1, rpd: 1, tpm: null, tpd: null,
    });
    expect(status.rpm.used).toBe(1);
    expect(status.rpd.used).toBe(1);
    expect(status.tpm.used).toBe(500);
  });

  it('restores hard gating when the setting is off', () => {
    setSoftLimitsEnabled(false);
    const limits = { rpm: null, rpd: 1, tpm: null, tpd: null };
    recordRequest('opencode', 'deepseek-v4-flash-free', keyId);
    expect(canMakeRequest('opencode', 'deepseek-v4-flash-free', keyId, limits)).toBe(false);

    process.env.PROVIDER_DAILY_REQUEST_CAP_OPENROUTER = '1';
    recordRequest('openrouter', 'm1', keyId);
    expect(canUseProvider('openrouter', keyId)).toBe(false);
  });

  it('a stored "0" wins over the default', () => {
    setSetting('routing_soft_limits', '0');
    expect(getSoftLimitsEnabled()).toBe(false);
  });
});
