import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  parseQuotaObservationsFromResponse,
  recordQuotaObservationsFromResponse,
  recordQuotaObservation,
  getQuotaStateForKeys,
  inferQuotaPoolKey,
} from '../../services/provider-quota.js';
import type { Platform } from '@freellmapi/shared/types.js';

function makeResponse(headers: Record<string, string>, status = 200, body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers,
  });
}

function insertState(row: {
  platform: string;
  keyId: number;
  pool: string;
  metric: string;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}) {
  getDb().prepare(`
    INSERT INTO provider_quota_state
      (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.platform, row.keyId, row.pool, row.metric, row.limit, row.remaining, row.resetAt);
}

function readState(platform: string, keyId: number, pool: string, metric: string) {
  return getDb().prepare(`
    SELECT limit_value AS lim, remaining_value AS remaining, reset_at AS resetAt
      FROM provider_quota_state
     WHERE platform = ? AND key_id = ? AND quota_pool_key = ? AND metric = ?
  `).get(platform, keyId, pool, metric) as { lim: number | null; remaining: number | null; resetAt: string | null } | undefined;
}

describe('provider-quota HEADER_SPECS coverage', () => {
  const platforms: Platform[] = [
    'nvidia',
    'mistral',
    'huggingface',
    'github',
    'zhipu',
    'reka',
    'siliconflow',
  ];

  for (const platform of platforms) {
    it(`${platform}: parses x-ratelimit requests and tokens headers`, () => {
      const res = makeResponse({
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '25',
        'x-ratelimit-reset-requests': '60',
        'x-ratelimit-limit-tokens': '10000',
        'x-ratelimit-remaining-tokens': '7500',
        'x-ratelimit-reset-tokens': '60',
      });
      const observations = parseQuotaObservationsFromResponse(res, { platform });
      const requests = observations.find(o => o.metric === 'requests');
      const tokens = observations.find(o => o.metric === 'tokens');
      expect(requests).toBeDefined();
      expect(requests?.limit).toBe(30);
      expect(requests?.remaining).toBe(25);
      expect(requests?.source).toBe('header');
      expect(tokens).toBeDefined();
      expect(tokens?.limit).toBe(10000);
      expect(tokens?.remaining).toBe(7500);
    });
  }

  it('returns no header observations when headers are absent', () => {
    const res = makeResponse({}, 200);
    const observations = parseQuotaObservationsFromResponse(res, { platform: 'nvidia' });
    const headerObs = observations.find(o => o.source === 'header' && o.metric === 'requests');
    expect(headerObs).toBeUndefined();
  });

  it('still produces a shared-pool probe observation for 200 with no headers', () => {
    const res = makeResponse({}, 200);
    const observations = parseQuotaObservationsFromResponse(res, { platform: 'mistral' });
    const probe = observations.find(o => o.source === 'probe');
    expect(probe).toBeDefined();
    expect(probe?.notes).toBe('no quota headers exposed');
  });

  it('nvidia tokens strategy is token_bucket', () => {
    const res = makeResponse({
      'x-ratelimit-limit-tokens': '5000',
      'x-ratelimit-remaining-tokens': '1000',
    });
    const observations = parseQuotaObservationsFromResponse(res, { platform: 'nvidia' });
    const tokens = observations.find(o => o.metric === 'tokens');
    expect(tokens?.resetStrategy).toBe('token_bucket');
  });

  it('mistral requests strategy is provider_reported', () => {
    const res = makeResponse({
      'x-ratelimit-limit-requests': '5',
      'x-ratelimit-remaining-requests': '3',
    });
    const observations = parseQuotaObservationsFromResponse(res, { platform: 'mistral' });
    const requests = observations.find(o => o.metric === 'requests');
    expect(requests?.resetStrategy).toBe('provider_reported');
  });

  it('existing groq header parsing still works', () => {
    const res = makeResponse({
      'x-ratelimit-limit-requests': '30',
      'x-ratelimit-remaining-requests': '20',
      'x-ratelimit-reset-requests': '1m',
      'x-ratelimit-limit-tokens': '30000',
      'x-ratelimit-remaining-tokens': '15000',
      'x-ratelimit-reset-tokens': '1m',
    });
    const observations = parseQuotaObservationsFromResponse(res, { platform: 'groq' });
    const requests = observations.find(o => o.metric === 'requests');
    const tokens = observations.find(o => o.metric === 'tokens');
    expect(requests?.remaining).toBe(20);
    expect(tokens?.limit).toBe(30000);
  });
});

describe('provider-quota persistence', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('records header observations for nvidia into the DB', () => {
    const res = makeResponse({
      'x-ratelimit-limit-requests': '40',
      'x-ratelimit-remaining-requests': '40',
      'x-ratelimit-reset-requests': '60',
    });
    recordQuotaObservationsFromResponse(res, { platform: 'nvidia', keyId: 1 });
    const states = getQuotaStateForKeys().filter(s => s.platform === 'nvidia');
    expect(states.length).toBeGreaterThan(0);
    const requests = states.find(s => s.metric === 'requests');
    expect(requests?.limit).toBe(40);
    expect(requests?.remaining).toBe(40);
    expect(requests?.source).toBe('header');
  });

  it('updates remaining when a subsequent response shows lower value', () => {
    const res1 = makeResponse({ 'x-ratelimit-remaining-requests': '10' });
    recordQuotaObservationsFromResponse(res1, { platform: 'mistral', keyId: 2 });
    const res2 = makeResponse({ 'x-ratelimit-remaining-requests': '5' });
    recordQuotaObservationsFromResponse(res2, { platform: 'mistral', keyId: 2 });
    const mistralStates = getQuotaStateForKeys().filter(
      s => s.platform === 'mistral' && s.keyId === 2 && s.metric === 'requests',
    );
    expect(mistralStates.length).toBe(1);
    expect(mistralStates[0].remaining).toBe(5);
  });

  it('inferQuotaPoolKey returns platform-specific pools', () => {
    expect(inferQuotaPoolKey('nvidia')).toBe('nvidia::credit-pool');
    expect(inferQuotaPoolKey('mistral')).toBe('mistral::experiment-pool');
    expect(inferQuotaPoolKey('zhipu')).toBe('zhipu::account');
    expect(inferQuotaPoolKey('reka')).toBe('reka::account');
    expect(inferQuotaPoolKey('siliconflow')).toBe('siliconflow::account');
    expect(inferQuotaPoolKey('huggingface')).toBe('huggingface::router');
    expect(inferQuotaPoolKey('github')).toBe('github::account');
  });

  it('freetheai pool key maps to freetheai::account', () => {
    expect(inferQuotaPoolKey('freetheai')).toBe('freetheai::account');
  });
});

describe('provider-quota freetheai HEADER_SPECS', () => {
  it('parses x-ratelimit per-minute headers from a chat response', () => {
    const res = makeResponse({
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '8',
      'x-ratelimit-reset': '60',
    });
    const observations = parseQuotaObservationsFromResponse(res, { platform: 'freetheai' });
    const rpm = observations.find(o => o.metric === 'requests' && o.limit === 10);
    expect(rpm).toBeDefined();
    expect(rpm?.remaining).toBe(8);
    expect(rpm?.quotaPoolKey).toBe('freetheai::account');
    expect(rpm?.source).toBe('header');
  });

  it('parses x-dailylimit 250 RPD headers from a chat response', () => {
    const res = makeResponse({
      'x-dailylimit-limit': '250',
      'x-dailylimit-remaining': '191',
      'x-dailylimit-reset': '1783123200',
    });
    const observations = parseQuotaObservationsFromResponse(res, { platform: 'freetheai' });
    const daily = observations.find(o => o.metric === 'requests' && o.limit === 250);
    expect(daily).toBeDefined();
    expect(daily?.remaining).toBe(191);
    expect(daily?.quotaPoolKey).toBe('freetheai::account');
    expect(daily?.source).toBe('header');
  });
});

describe('provider-quota: pool inference', () => {
  it('buckets shared-pool providers per account and openrouter free vs account', () => {
    expect(inferQuotaPoolKey('groq')).toBe('groq::account');
    expect(inferQuotaPoolKey('openrouter', 'meta-llama/llama-3.1-8b-instruct:free')).toBe('openrouter::free');
    expect(inferQuotaPoolKey('openrouter', 'openai/gpt-4o')).toBe('openrouter::account');
    expect(inferQuotaPoolKey('acme' as any, 'x')).toBe('acme::x');
    expect(inferQuotaPoolKey('acme' as any)).toBe('acme::account');
  });
});

describe('provider-quota: record + read round-trip', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_quota_state').run();
    getDb().prepare('DELETE FROM provider_quota_observations').run();
  });

  it('records an observation and surfaces it via getQuotaStateForKeys', () => {
    const rec = recordQuotaObservation({
      platform: 'groq',
      keyId: 7,
      quotaPoolKey: 'groq::account',
      metric: 'requests',
      limit: 1000,
      remaining: 950,
      source: 'header',
    });
    expect(rec).not.toBeNull();

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'groq' && s.keyId === 7 && s.metric === 'requests');
    expect(row).toBeDefined();
    expect(row!.limit).toBe(1000);
    expect(row!.remaining).toBe(950);
  });
});

describe('provider-quota: parse from response headers (shared parseRetryAfterMs)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('parses Groq ratelimit headers into a requests observation', () => {
    const resp = new Response(null, {
      status: 200,
      headers: {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '90',
        'x-ratelimit-reset-requests': '60',
      },
    });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 });
    const requests = obs.find(o => o.metric === 'requests');
    expect(requests).toBeDefined();
    expect(requests!.limit).toBe(100);
    expect(requests!.remaining).toBe(90);
  });

  it('reads Retry-After on a 429 via the shared parser (dedup of base.ts)', () => {
    const resp = new Response(null, { status: 429, headers: { 'retry-after': '30' } });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 });
    expect(obs.some(o => o.retryAfterMs === 30_000)).toBe(true);
    expect(obs.some(o => o.remaining === 0)).toBe(true);
  });
});

describe('provider-quota: reset_at replenishment on read (#453)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_quota_state').run();
    getDb().prepare('DELETE FROM provider_quota_observations').run();
  });

  const past = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it('restores remaining to the known limit once reset_at has passed, and persists it', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 0, resetAt: past() });

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'groq' && s.keyId === 1);
    expect(row!.remaining).toBe(100);
    expect(row!.resetAt).toBeNull();

    const persisted = readState('groq', 1, 'groq::account', 'requests');
    expect(persisted!.remaining).toBe(100);
    expect(persisted!.resetAt).toBeNull();
  });

  it('clears remaining to unknown when the limit is unknown and reset_at passed', () => {
    insertState({ platform: 'ollama', keyId: 2, pool: 'ollama::cloud', metric: 'requests', limit: null, remaining: 0, resetAt: past() });

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'ollama' && s.keyId === 2);
    expect(row!.remaining).toBeNull();
    expect(row!.resetAt).toBeNull();

    const persisted = readState('ollama', 2, 'ollama::cloud', 'requests');
    expect(persisted!.remaining).toBeNull();
  });

  it('leaves a still-active window (reset_at in the future) untouched', () => {
    insertState({ platform: 'groq', keyId: 3, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 0, resetAt: future() });

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'groq' && s.keyId === 3);
    expect(row!.remaining).toBe(0);
    expect(row!.resetAt).not.toBeNull();
  });
});
