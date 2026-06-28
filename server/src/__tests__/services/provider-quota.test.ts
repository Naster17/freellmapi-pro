import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  parseQuotaObservationsFromResponse,
  recordQuotaObservationsFromResponse,
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
});