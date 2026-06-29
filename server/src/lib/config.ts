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
  };
}
