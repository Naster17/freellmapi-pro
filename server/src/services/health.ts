import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { providerLog } from '../lib/server-logs.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';
import { inferQuotaPoolKey } from './provider-quota.js';
import { pruneRouterState } from './router.js';
import type { Scheduler } from '../lib/scheduler.js';
import { hasNetwork } from '../lib/network.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;
const HEALTH_PROBE_CONCURRENCY = 5;

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const failureCount = new Map<number, number>();

export function invalidateKey(keyId: number, reason: string): void {
  const db = getDb();
  const row = db.prepare('SELECT platform FROM api_keys WHERE id = ?').get(keyId) as { platform: string } | undefined;
  const result = db.prepare(`
    UPDATE api_keys
       SET status = 'invalid', enabled = 0, last_checked_at = datetime('now')
     WHERE id = ?
  `).run(keyId);
  failureCount.delete(keyId);
  if (result.changes > 0) {
    providerLog(`Auto-disabled key ${keyId}: ${reason.slice(0, 160)}`, { level: 'warn', provider: row?.platform ?? 'unknown', event: 'key_disabled' });
  }
}

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) return 'error';

  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider) return 'error';

  if (!(await hasNetwork())) {
    providerLog(`Skipping probe of key ${keyId} (${row.platform}): network unreachable`, { level: 'warn', provider: row.platform, event: 'probe_skipped_no_network' });
    return row.status as KeyStatus ?? 'unknown';
  }

  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const isValid = await provider.validateKey(apiKey, {
      platform: row.platform as Platform,
      keyId,
      quotaPoolKey: inferQuotaPoolKey(row.platform as Platform, null),
      endpoint: 'models',
      origin: 'health',
    });

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, keyId);

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      const count = (failureCount.get(keyId) ?? 0) + 1;
      failureCount.set(keyId, count);
      providerLog(`Key ${keyId} rejected as invalid (failure ${count}/${CONSECUTIVE_FAILURES_TO_DISABLE})`, { level: 'warn', provider: row.platform, event: 'key_invalid' });

      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId);
        providerLog(`Auto-disabled key ${keyId} after ${count} consecutive failures`, { level: 'warn', provider: row.platform, event: 'key_disabled' });
      }
    }

    return status;
  } catch (err: any) {
    const transportLine = `[Health] Key ${keyId} (${row.platform}, base=${row.base_url ?? 'default'}) transport error: ${err.message}`;
    console.error(transportLine);
    providerLog(transportLine, { level: 'error', provider: row.platform, event: 'transport_error' });
    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run('error', keyId);
    return 'error';
  }
}

let inFlightCheckAll: Promise<void> | null = null;
let inFlightStartedAt = 0;

export function isCheckAllInFlight(): boolean {
  return inFlightCheckAll !== null;
}

export function getCheckAllStartedAt(): number {
  return inFlightStartedAt;
}

export function _resetInFlightForTests(): void {
  inFlightCheckAll = null;
  inFlightStartedAt = 0;
}

export async function checkAllKeys(): Promise<void> {
  if (inFlightCheckAll) {
    return inFlightCheckAll;
  }

  if (!(await hasNetwork())) {
    console.log('[Health] Skipping checkAllKeys: network unreachable');
    providerLog('Skipping scheduled health check: network unreachable', { level: 'warn', provider: 'health', event: 'probe_skipped_no_network' });
    return;
  }

  inFlightStartedAt = Date.now();
  inFlightCheckAll = (async () => {
    try {
      const db = getDb();
      const keys = db.prepare('SELECT id, platform FROM api_keys').all() as { id: number; platform: string }[];

      console.log(`[Health] Checking ${keys.length} keys (concurrency ${HEALTH_PROBE_CONCURRENCY})...`);

      await runWithConcurrency(keys, HEALTH_PROBE_CONCURRENCY, key => checkKeyHealth(key.id));

      pruneRouterState();

      console.log(`[Health] Check complete.`);
    } finally {
      inFlightCheckAll = null;
    }
  })();

  return inFlightCheckAll;
}

let cancelHealthCheck: (() => void) | null = null;

export function startHealthChecker(scheduler: Scheduler): void {
  if (cancelHealthCheck) return;
  console.log(`[Health] Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);
  cancelHealthCheck = scheduler.every(CHECK_INTERVAL_MS, () =>
    checkAllKeys().catch(err => console.error('[Health] Check failed:', err)),
  );
}

export function stopHealthChecker(): void {
  if (cancelHealthCheck) {
    cancelHealthCheck();
    cancelHealthCheck = null;
  }
}
