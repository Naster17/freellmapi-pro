import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getQuotaStateForKeys, parseQuotaObservationsFromResponse } from '../../services/provider-quota.js';
import { probeAllKeys } from '../../services/quota-probe.js';

function insertTestKey(platform: string, label: string, apiKeyValue: string): number {
  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(apiKeyValue);
  const result = db.prepare(
    'INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(platform, label, encrypted, iv, authTag, 'healthy', 1);
  return Number(result.lastInsertRowid);
}

function mockFetchResponses(responses: Array<{ urlPattern: RegExp; status: number; body: unknown }>): ReturnType<typeof vi.fn> {
  const calls: Array<{ url: string }> = [];
  const fn = vi.fn(async (input: any, _init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url });
    const match = responses.find(r => r.urlPattern.test(url));
    if (!match) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  global.fetch = fn as any;
  return fn;
}

function clearQuotaObservations(platform: string, keyId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM provider_quota_observations WHERE platform = ? AND key_id = ?').run(platform, keyId);
  db.prepare('DELETE FROM provider_quota_state WHERE platform = ? AND key_id = ?').run(platform, keyId);
}

describe('quota-probe: Pollinations', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records Pollinations pollen balance via quota_api', async () => {
    const keyId = insertTestKey('pollinations', 'test-pol', 'sk_test_123');
    const mockFn = mockFetchResponses([
      { urlPattern: /\/account\/balance$/, status: 200, body: { balance: 42.5, tier_balance: 30, paid_balance: 12.5 } },
    ]);

    await probeAllKeys();

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'pollinations' && s.keyId === keyId && s.metric === 'credits',
    );
    expect(states).toHaveLength(1);
    expect(states[0].remaining).toBe(42.5);
    expect(states[0].source).toBe('quota_api');
    expect(states[0].endpoint).toBe('account/balance');
    expect(states[0].notes).toContain('pollen_balance=42.5');
    expect(mockFn).toHaveBeenCalled();
  });

  it('skips Pollinations when balance is missing', async () => {
    const keyId = insertTestKey('pollinations', 'test-pol-empty', 'sk_test_empty');
    mockFetchResponses([
      { urlPattern: /\/account\/balance$/, status: 200, body: { tier: 'spore' } },
    ]);

    await probeAllKeys();

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'pollinations' && s.keyId === keyId,
    );
    expect(states).toHaveLength(0);
  });
});

describe('quota-probe: Routeway', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records Routeway USD balance via quota_api', async () => {
    const keyId = insertTestKey('routeway', 'test-rw', 'rw_test_123');
    mockFetchResponses([
      { urlPattern: /\/v1\/account\/balance$/, status: 200, body: { balance: 4.20 } },
    ]);

    await probeAllKeys();

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'routeway' && s.keyId === keyId && s.metric === 'credits',
    );
    expect(states).toHaveLength(1);
    expect(states[0].remaining).toBe(4.20);
    expect(states[0].source).toBe('quota_api');
    expect(states[0].endpoint).toBe('account/balance');
    expect(states[0].notes).toContain('usd_balance=4.2');
  });
});

describe('quota-probe: BazaarLink', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records BazaarLink credit balance via quota_api', async () => {
    const keyId = insertTestKey('bazaarlink', 'test-bl', 'sk-bl-test');
    mockFetchResponses([
      { urlPattern: /\/api\/v1\/key$/, status: 200, body: { status: 'active', credits: 100, points_balance: 50 } },
    ]);

    await probeAllKeys();

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'bazaarlink' && s.keyId === keyId && s.metric === 'credits',
    );
    expect(states).toHaveLength(1);
    expect(states[0].remaining).toBe(100);
    expect(states[0].source).toBe('quota_api');
    expect(states[0].endpoint).toBe('key');
    expect(states[0].notes).toContain('status=active');
  });
});

describe('quota-probe: AINative', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records AINative credit balance with plan + period via quota_api', async () => {
    const keyId = insertTestKey('ainative', 'test-ain', 'ain_test_123');
    mockFetchResponses([
      {
        urlPattern: /\/api\/v1\/credits\/balance$/,
        status: 200,
        body: {
          total_credits: 50000,
          used_credits: 12340,
          remaining_credits: 37660,
          plan: 'pro',
          period_start: '2026-06-01T00:00:00Z',
          period_end: '2026-06-30T23:59:59Z',
          usage_percentage: 24.68,
        },
      },
    ]);

    await probeAllKeys();

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'ainative' && s.keyId === keyId && s.metric === 'credits',
    );
    expect(states).toHaveLength(1);
    expect(states[0].limit).toBe(50000);
    expect(states[0].remaining).toBe(37660);
    expect(states[0].source).toBe('quota_api');
    expect(states[0].endpoint).toBe('credits/balance');
    expect(states[0].notes).toContain('plan=pro');
    expect(states[0].notes).toContain('pct=24.68%');
  });
});

describe('quota-probe: AI Horde', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records AI Horde kudos via quota_api with provider account id', async () => {
    const keyId = insertTestKey('aihorde', 'test-ah', '0000000000');
    mockFetchResponses([
      {
        urlPattern: /\/api\/v2\/find_user$/,
        status: 200,
        body: { username: 'tester', kudos: 250, concurrency: 5, trusted: true },
      },
    ]);

    await probeAllKeys();

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'aihorde' && s.keyId === keyId && s.metric === 'credits',
    );
    expect(states).toHaveLength(1);
    expect(states[0].remaining).toBe(250);
    expect(states[0].source).toBe('quota_api');
    expect(states[0].endpoint).toBe('find_user');
    expect(states[0].notes).toContain('username=tester');
    expect(states[0].notes).toContain('kudos=250');
    expect(states[0].notes).toContain('trusted=true');
  });
});

describe('quota-probe: graceful error handling', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not record when API returns 401', async () => {
    const keyId = insertTestKey('pollinations', 'test-401', 'sk_bad');
    mockFetchResponses([
      { urlPattern: /.*/, status: 401, body: { error: 'unauthorized' } },
    ]);

    await probeAllKeys();

    const states = getQuotaStateForKeys().filter(
      s => s.platform === 'pollinations' && s.keyId === keyId,
    );
    expect(states).toHaveLength(0);
  });

  it('does not throw when fetch fails with network error', async () => {
    insertTestKey('routeway', 'test-net-err', 'rw_net_err');
    const fn = vi.fn(async () => {
      throw new Error('network failure');
    });
    global.fetch = fn as any;

    await expect(probeAllKeys()).resolves.not.toThrow();
  });
});

describe('provider-quota HEADER_SPECS: Routeway custom headers', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('parses Routeway X-RateLimit-Limit-Minute/Remaining headers', () => {
    const res = new Response(null, {
      status: 200,
      headers: {
        'x-ratelimit-limit-minute': '5',
        'x-ratelimit-remaining-minute': '3',
        'x-ratelimit-reset-minute': '60',
      },
    });
    const obs = parseQuotaObservationsFromResponse(res, { platform: 'routeway' });
    const requests = obs.find((o: any) => o.metric === 'requests');
    expect(requests).toBeDefined();
    expect(requests?.limit).toBe(5);
    expect(requests?.remaining).toBe(3);
  });
});