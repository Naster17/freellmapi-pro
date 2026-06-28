import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { recordQuotaObservation, getQuotaStateForKeys } from '../../services/provider-quota.js';

function insertTestKey(platform: string, label: string): number {
  const db = getDb();
  const plaintext = `test-api-key-${platform}-${Date.now()}`;
  const { encrypted, iv, authTag } = encrypt(plaintext);
  const result = db.prepare(
    'INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(platform, label, encrypted, iv, authTag, 'healthy', 1);
  return Number(result.lastInsertRowid);
}

describe('quota-probe quota_api source recording', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('records OpenRouter credits observation via quota_api source', () => {
    const keyId = insertTestKey('openrouter', 'test-or');
    recordQuotaObservation({
      platform: 'openrouter',
      keyId,
      quotaPoolKey: 'openrouter::free',
      metric: 'credits',
      limit: 10000,
      remaining: 7500,
      resetStrategy: 'rolling_window',
      source: 'quota_api',
      endpoint: 'auth/key',
      confidence: 1,
      notes: 'free tier',
      rawJson: '{"usage":2500,"limit":10000,"is_free_tier":true}',
    });

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'openrouter' && s.keyId === keyId && s.metric === 'credits',
    );
    expect(states).toHaveLength(1);
    expect(states[0].limit).toBe(10000);
    expect(states[0].remaining).toBe(7500);
    expect(states[0].source).toBe('quota_api');
    expect(states[0].confidence).toBe(1);
  });

  it('records OpenRouter rate_limit observation', () => {
    const keyId = insertTestKey('openrouter', 'test-or-rl');
    recordQuotaObservation({
      platform: 'openrouter',
      keyId,
      quotaPoolKey: 'openrouter::account',
      metric: 'requests',
      limit: 200,
      remaining: null,
      resetStrategy: 'provider_reported',
      source: 'quota_api',
      endpoint: 'auth/key',
      confidence: 1,
      notes: 'interval=10s',
      rawJson: '{"requests":200,"interval":"10s"}',
    });

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'openrouter' && s.keyId === keyId && s.metric === 'requests',
    );
    expect(states).toHaveLength(1);
    expect(states[0].limit).toBe(200);
    expect(states[0].remaining).toBeNull();
    expect(states[0].source).toBe('quota_api');
  });

  it('records GitHub billing credits observation via quota_api source', () => {
    const keyId = insertTestKey('github', 'test-gh');
    recordQuotaObservation({
      platform: 'github',
      keyId,
      quotaPoolKey: 'github::account',
      metric: 'credits',
      limit: null,
      remaining: null,
      resetStrategy: 'fixed_calendar',
      source: 'quota_api',
      endpoint: 'billing/ai_credit/usage',
      confidence: 0.9,
      notes: 'user=testuser, total_used=150.5, paid_used=0, free_used=150.5, date=2026-06-28',
      rawJson: '{"total_credits_used":150.5,"total_paid_credits_used":0}',
      providerAccountId: 'testuser',
    });

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'github' && s.keyId === keyId && s.metric === 'credits',
    );
    expect(states).toHaveLength(1);
    expect(states[0].limit).toBeNull();
    expect(states[0].remaining).toBeNull();
    expect(states[0].source).toBe('quota_api');
    expect(states[0].confidence).toBe(0.9);
    expect(states[0].notes).toContain('user=testuser');
  });

  it('quota_api source has highest priority over probe', () => {
    const keyId = insertTestKey('openrouter', 'test-priority');
    recordQuotaObservation({
      platform: 'openrouter',
      keyId,
      quotaPoolKey: 'openrouter::free',
      metric: 'credits',
      limit: null,
      remaining: null,
      resetStrategy: 'unknown',
      source: 'probe',
      confidence: 0.1,
      notes: 'no quota headers exposed',
    });

    recordQuotaObservation({
      platform: 'openrouter',
      keyId,
      quotaPoolKey: 'openrouter::free',
      metric: 'credits',
      limit: 10000,
      remaining: 9000,
      resetStrategy: 'rolling_window',
      source: 'quota_api',
      endpoint: 'auth/key',
      confidence: 1,
    });

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'openrouter' && s.keyId === keyId && s.metric === 'credits',
    );
    expect(states).toHaveLength(1);
    expect(states[0].source).toBe('quota_api');
    expect(states[0].limit).toBe(10000);
    expect(states[0].confidence).toBe(1);
  });

  it('probe source cannot downgrade quota_api or header source', () => {
    const keyId = insertTestKey('openrouter', 'test-no-downgrade');
    recordQuotaObservation({
      platform: 'openrouter',
      keyId,
      quotaPoolKey: 'openrouter::free',
      metric: 'credits',
      limit: 10000,
      remaining: 9000,
      resetStrategy: 'rolling_window',
      source: 'quota_api',
      endpoint: 'auth/key',
      confidence: 1,
    });

    recordQuotaObservation({
      platform: 'openrouter',
      keyId,
      quotaPoolKey: 'openrouter::free',
      metric: 'credits',
      limit: 5000,
      remaining: 3000,
      resetStrategy: 'unknown',
      source: 'probe',
      confidence: 0.1,
    });

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'openrouter' && s.keyId === keyId && s.metric === 'credits',
    );
    expect(states).toHaveLength(1);
    expect(states[0].source).toBe('quota_api');
  });
});
