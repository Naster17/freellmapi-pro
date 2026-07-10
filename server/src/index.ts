import './env.js';
import { installServerLogCapture } from './lib/server-logs.js';
import { createApp } from './app.js';
import { initDb, getDb, getSetting, closeDb } from './db/index.js';
import { startHealthChecker, checkAllKeys } from './services/health.js';
import { startQuotaProbe } from './services/quota-probe.js';
import { applyProxyUrl, applyProxyEnabled, applyProxyBypass, flushProxyCache } from './lib/proxy.js';
import { startCatalogSync } from './services/catalog-sync.js';
import { installProcessSafetyNet } from './lib/process-safety-net.js';
import { NodeScheduler } from './lib/scheduler.js';
import { loadConfig } from './lib/config.js';
import { applyDeclarativeConfigFromEnv } from './services/declarative-config.js';
import { restoreDbBackupIfNeeded, startDbBackupPump } from './lib/db-backup.js';
import { startWakeDetect } from './lib/wake-detect.js';
import { resetAllInflight } from './services/ratelimit.js';

installServerLogCapture();

async function main() {
  const config = loadConfig();
  const { port: PORT, host: HOST } = config;

  // Install first so a late provider socket reset (undici HTTP/2 error with no
  // listener) can't take the proxy down. Genuine bugs still exit 1.
  installProcessSafetyNet();

  const scheduler = new NodeScheduler();

  if (config.dbPath) {
    await restoreDbBackupIfNeeded(config.dbPath);
  } else {
    await restoreDbBackupIfNeeded();
  }
  initDb(config.dbPath ?? undefined);
  applyDeclarativeConfigFromEnv();

  // Load the persisted proxy settings from the DB (env var wins if set).
  // Must happen after initDb so the settings table is ready.
  applyProxyUrl(getSetting('proxy_url') ?? '');
  applyProxyEnabled(getSetting('proxy_enabled') !== '0'); // default: enabled
  applyProxyBypass(getSetting('proxy_bypass') ?? '');

  const app = createApp(config);

  const onReady = (host: string) => () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`Server running on http://${display}:${PORT}`);
    console.log(`Proxy endpoint: http://${display}:${PORT}/v1/chat/completions`);
    startHealthChecker(scheduler);
    startQuotaProbe(scheduler);
    startCatalogSync(scheduler);
    startDbBackupPump(getDb(), scheduler, config.dbPath ?? undefined);

    // Detect OS sleep/wake and post-wake recovery. Runs every 5s; when
    // wall-clock drift exceeds 30s (i.e. the process was suspended), flush
    // stale state and trigger an immediate health probe so traffic recovers
    // before the 5-minute scheduled check fires.
    startWakeDetect({
      async onWake(event) {
        console.log(`[wake] detected (reason=${event.reason}, idle=${event.idleMs}ms) — flushing stale state`);
        flushProxyCache();
        resetAllInflight();
        try {
          await checkAllKeys();
        } catch (err: any) {
          console.error(`[wake] post-wake health check failed: ${err?.message ?? err}`);
        }
      },
    });
  };

  const server = app.listen(Number(PORT), HOST, onReady(HOST));
  server.keepAliveTimeout = 15_000;
  server.headersTimeout = 30_000;
  installShutdownHandlers(server);
  server.on('error', (err: NodeJS.ErrnoException) => {
    // The default '::' bind fails where IPv6 is disabled (kernel
    // ipv6.disable=1 and the like) — retry IPv4-only rather than dying.
    // Anything else (EADDRINUSE, an explicit HOST that can't bind) keeps the
    // fail-fast posture documented in main().catch below.
    if (!process.env.HOST && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      console.warn('[server] IPv6 unavailable on this host — falling back to 0.0.0.0 (IPv4-only)');
      const fallback = app.listen(Number(PORT), '0.0.0.0', onReady('0.0.0.0'));
      fallback.keepAliveTimeout = 15_000;
      fallback.headersTimeout = 30_000;
      installShutdownHandlers(fallback);
      return;
    }
    console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
    process.exit(1);
  });
}

let activeServer: import('http').Server | null = null;
let shutdownInstalled = false;
function installShutdownHandlers(server: import('http').Server): void {
  activeServer = server;
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received — draining (timeout 10s)`);
    const force = setTimeout(() => {
      console.error('[server] drain timeout — forcing exit');
      process.exit(1);
    }, 10_000);
    force.unref();
    const target = activeServer;
    if (!target) {
      closeDb();
      process.exit(0);
      return;
    }
    target.close((err) => {
      if (err) console.error(`[server] close error: ${err.message}`);
      closeDb();
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // A boot failure (e.g. a missing production ENCRYPTION_KEY) must exit
  // non-zero rather than leaving a half-initialized process that never starts
  // listening — that silent state is what surfaces in the client as
  // "Can't reach the server".
  console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
  process.exit(1);
});
