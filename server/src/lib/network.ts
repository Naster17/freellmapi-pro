import { proxyFetch } from './proxy.js';

const PROBE_URL = 'https://www.google.com/generate_204';
const PROBE_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 10_000;

let cachedAt = 0;
let cachedResult: boolean | null = null;
let inFlight: Promise<boolean> | null = null;

export interface HasNetworkOptions {
  forceRefresh?: boolean;
}

export async function hasNetwork(opts: HasNetworkOptions = {}): Promise<boolean> {
  const now = Date.now();
  if (!opts.forceRefresh && cachedResult !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }
  if (inFlight) return inFlight;

  inFlight = probe()
    .then(result => {
      cachedAt = Date.now();
      cachedResult = result;
      return result;
    })
    .catch(() => {
      cachedAt = Date.now();
      cachedResult = false;
      return false;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

async function probe(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await proxyFetch(PROBE_URL, {
      method: 'GET',
      signal: controller.signal,
    }, 'health');
    return res.status >= 200 && res.status < 400;
  } finally {
    clearTimeout(timer);
  }
}

export function _resetNetworkCacheForTests(): void {
  cachedAt = 0;
  cachedResult = null;
  inFlight = null;
}
