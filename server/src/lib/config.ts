const DEFAULT_PROXY_RPM = 120;

export function parseRateLimitRpm(envVar = process.env.PROXY_RATE_LIMIT_RPM, fallback = DEFAULT_PROXY_RPM): number {
  const raw = envVar;
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export interface Config {
  port: number | string;
  host: string;
  dbPath: string | null;
  dashboardOrigins: string[];
  clientDist: string | null;
  proxyRateLimitRpm: number;
  nodeEnv: string;
  serveStaticAssets: boolean;
  /**
   * Tri-state override for the CSP `upgrade-insecure-requests` directive (#682).
   * - undefined: auto — emit the directive only when the request arrived over
   *   TLS (or behind an HTTPS reverse proxy that forwarded X-Forwarded-Proto).
   * - true:      always emit (force HTTPS upgrade even on plain HTTP).
   * - false:     never emit (let HTTP LAN installs render the dashboard).
   */
  cspUpgradeInsecureRequests: boolean | undefined;
}

export function loadConfig(): Config {
  return {
    port: process.env.PORT ?? 3001,
    host: process.env.HOST ?? '::',
    dbPath: process.env.FREEAPI_DB_PATH?.trim() || null,
    dashboardOrigins: (process.env.DASHBOARD_ORIGINS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    clientDist: process.env.CLIENT_DIST ?? null,
    proxyRateLimitRpm: parseRateLimitRpm(),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    serveStaticAssets: true,
    // CSP_UPGRADE_INSECURE_REQUESTS: true|false forces the directive on/off;
    // unset (the default) leaves it on auto — emit only when the request is
    // already TLS or forwarded as https, so HTTP LAN installs still render.
    cspUpgradeInsecureRequests: parseCspUpgradeInsecureRequests(),
  };
}

function parseCspUpgradeInsecureRequests(): boolean | undefined {
  const raw = process.env.CSP_UPGRADE_INSECURE_REQUESTS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}
