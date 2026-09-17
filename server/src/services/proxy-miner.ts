import { getSetting, setSetting } from '../db/index.js';
import { providerLog } from '../lib/server-logs.js';
import type { Scheduler } from '../lib/scheduler.js';
import {
  checkProxy,
  createProxy,
  deleteProxy,
  isPublicProxyMiningEnabled,
  listProxies,
  updateProxy,
  type ProxyType,
} from './proxy-pool.js';

export const PROXY_MINER_KEEP_SETTING = 'proxy_miner_keep_best';
export const DEFAULT_MINER_KEEP_BEST = 30;
export const MINER_BATCH_SIZE = 50;
export const MINER_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 8;

interface MinedCandidate {
  type: ProxyType;
  address: string;
}

const SOURCES: Array<{ name: string; type: ProxyType; url: string; parse: (text: string) => string[] }> = [
  {
    name: 'proxyscrape-socks5',
    type: 'socks5',
    url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all',
    parse: parseHostPortLines,
  },
  {
    name: 'proxyscrape-socks4',
    type: 'socks4',
    url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000&country=all&ssl=all&anonymity=all',
    parse: parseHostPortLines,
  },
  {
    name: 'proxy-list-download-https',
    type: 'https',
    url: 'https://www.proxy-list.download/api/v1/get?type=https',
    parse: parseHostPortLines,
  },
  {
    name: 'geonode-socks5',
    type: 'socks5',
    url: 'https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5',
    parse: parseGeonode,
  },
];

function parseHostPortLines(text: string): string[] {
  return text
    .split(/[\r\n,;]+/)
    .map(s => s.trim())
    .filter(s => /^\[?[0-9a-fA-F.:]+\]?:\d{1,5}$/.test(s));
}

function parseGeonode(text: string): string[] {
  try {
    const data = JSON.parse(text) as { data?: Array<{ ip?: string; port?: string | number }> };
    return (data.data ?? [])
      .filter(e => e.ip && e.port)
      .map(e => `${e.ip}:${e.port}`);
  } catch {
    return [];
  }
}

export function getMinerKeepBest(): number {
  try {
    const raw = getSetting(PROXY_MINER_KEEP_SETTING);
    if (raw === undefined || raw.trim() === '') return DEFAULT_MINER_KEEP_BEST;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 5 || n > 200) return DEFAULT_MINER_KEEP_BEST;
    return n;
  } catch {
    return DEFAULT_MINER_KEEP_BEST;
  }
}

export function setMinerKeepBest(n: number): void {
  if (!Number.isInteger(n) || n < 5 || n > 200) throw new Error('keep-best must be an integer 5..200');
  setSetting(PROXY_MINER_KEEP_SETTING, String(n));
}

async function fetchSource(url: string, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`list answered HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export interface MineSummary {
  sourcesOk: number;
  sourcesFailed: number;
  fetched: number;
  added: number;
  healthy: number;
  kept: number;
  removed: number;
  errors: string[];
}

let mineInFlight: Promise<MineSummary> | null = null;

export function isMineInFlight(): boolean {
  return mineInFlight !== null;
}

export function minePublicProxies(fetchImpl: typeof fetch = fetch): Promise<MineSummary> {
  if (mineInFlight) return mineInFlight;
  mineInFlight = runMine(fetchImpl).finally(() => {
    mineInFlight = null;
  });
  return mineInFlight;
}

async function runMine(fetchImpl: typeof fetch): Promise<MineSummary> {
  const summary: MineSummary = { sourcesOk: 0, sourcesFailed: 0, fetched: 0, added: 0, healthy: 0, kept: 0, removed: 0, errors: [] };
  const seen = new Map<string, MinedCandidate>();
  for (const source of SOURCES) {
    try {
      const text = await fetchSource(source.url, fetchImpl);
      summary.sourcesOk++;
      for (const line of source.parse(text)) {
        const key = line.toLowerCase();
        if (!seen.has(key)) {
          seen.set(key, { type: source.type, address: line });
        }
      }
    } catch (err: any) {
      summary.sourcesFailed++;
      summary.errors.push(`${source.name}: ${err?.message ?? err}`.slice(0, 160));
    }
  }
  summary.fetched = seen.size;

  const existing = new Set(listProxies().map(p => `${p.host.toLowerCase()}:${p.port}`));
  const fresh = [...seen.values()].filter(c => {
    const parsed = /^(\[?[0-9a-fA-F.:]+\]?):(\d{1,5})$/.exec(c.address);
    if (!parsed) return false;
    const port = Number(parsed[2]);
    if (port < 1 || port > 65535) return false;
    return !existing.has(`${parsed[1].toLowerCase()}:${port}`);
  });

  for (let i = fresh.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fresh[i], fresh[j]] = [fresh[j]!, fresh[i]!];
  }
  const batch = fresh.slice(0, MINER_BATCH_SIZE);

  const createdIds: number[] = [];
  for (const candidate of batch) {
    try {
      const row = createProxy({ type: candidate.type, address: candidate.address, source: 'public' });
      updateProxy(row.id, { enabled: false });
      createdIds.push(row.id);
      summary.added++;
    } catch {
      continue;
    }
  }

  const probed: Array<{ id: number; ok: boolean; latency: number }> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, createdIds.length) }, async () => {
    while (cursor < createdIds.length) {
      const id = createdIds[cursor++]!;
      try {
        const result = await checkProxy(id);
        probed.push({ id, ok: result.status === 'healthy', latency: result.latencyMs ?? Infinity });
      } catch {
        probed.push({ id, ok: false, latency: Infinity });
      }
    }
  });
  await Promise.all(workers);
  summary.healthy = probed.filter(p => p.ok).length;

  const keepBest = getMinerKeepBest();
  const winners = new Set(
    probed
      .filter(p => p.ok)
      .sort((a, b) => a.latency - b.latency)
      .slice(0, keepBest)
      .map(p => p.id),
  );
  for (const probe of probed) {
    try {
      if (winners.has(probe.id)) {
        updateProxy(probe.id, { enabled: true });
      } else {
        deleteProxy(probe.id);
        summary.removed++;
      }
    } catch {
      continue;
    }
  }
  summary.kept = winners.size;

  const enabledPublic = listProxies()
    .filter(p => (p.source ?? 'manual') === 'public' && p.enabled === 1)
    .sort((a, b) => (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity));
  for (const row of enabledPublic.slice(keepBest)) {
    try {
      deleteProxy(row.id);
      summary.removed++;
    } catch {
      continue;
    }
  }

  providerLog(
    `Proxy miner: ${summary.added} tested, ${summary.healthy} healthy, kept ${summary.kept}, removed ${summary.removed} (${summary.sourcesOk} lists ok, ${summary.sourcesFailed} failed)`,
    { level: summary.healthy > 0 ? 'info' : 'warn', provider: 'proxy-pool', event: 'proxy_mined' },
  );
  return summary;
}

export function startProxyMiner(scheduler: Scheduler): () => void {
  return scheduler.every(MINER_INTERVAL_MS, () => {
    if (!isPublicProxyMiningEnabled()) return;
    void minePublicProxies().catch(err => {
      console.error('[ProxyPool] Scheduled mine failed:', err?.message ?? err);
    });
  }, { name: 'proxy-miner' });
}
