import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { checkAllKeys, checkKeyHealth, isCheckAllInFlight } from '../../services/health.js';

vi.mock('../../lib/network.js', () => ({
  hasNetwork: vi.fn(),
}));

import { hasNetwork } from '../../lib/network.js';
const mockedHasNetwork = vi.mocked(hasNetwork);

function insertKey(platform: string, status: 'healthy' | 'invalid' | 'error' | 'unknown' = 'healthy') {
  const db = getDb();
  const enc = encrypt('test-key-value');
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status, base_url, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, NULL, datetime('now'))
  `).run(platform, `${platform}-label`, enc.encrypted, enc.iv, enc.authTag, status);
  return Number(result.lastInsertRowid);
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  vi.clearAllMocks();
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
  mockedHasNetwork.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkAllKeys — network gate', () => {
  it('short-circuits entirely when the network is unreachable', async () => {
    const id = insertKey('groq', 'healthy');
    mockedHasNetwork.mockResolvedValueOnce(false);

    await checkAllKeys();

    expect(isCheckAllInFlight()).toBe(false);
    const row = getDb().prepare('SELECT status, last_checked_at FROM api_keys WHERE id = ?').get(id) as any;
    expect(row.status).toBe('healthy');
  });

  it('still probes normally when the network is reachable', async () => {
    const id = insertKey('groq', 'healthy');
    await checkAllKeys();
    expect(mockedHasNetwork).toHaveBeenCalled();
  });
});

describe('checkKeyHealth — network gate', () => {
  it('skips and does not touch status when the network is unreachable', async () => {
    const id = insertKey('groq', 'healthy');
    mockedHasNetwork.mockResolvedValueOnce(false);

    const status = await checkKeyHealth(id);

    expect(status).toBe('healthy');
    const row = getDb().prepare('SELECT status, last_checked_at FROM api_keys WHERE id = ?').get(id) as any;
    expect(row.status).toBe('healthy');
  });

  it('probes normally when the network is reachable', async () => {
    insertKey('groq', 'healthy');
    await checkKeyHealth(insertKey('groq', 'healthy'));
    expect(mockedHasNetwork).toHaveBeenCalled();
  });
});
