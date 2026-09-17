import { proxyFetchVia } from '../lib/proxy.js';
import { newZenRequestId, newZenSessionId, zenSpoofClient, zenSpoofUserAgent } from '../providers/zen.js';
import { providerLog } from '../lib/server-logs.js';
import { buildProxyUrl, disablePoolProxy, getProxy, listProxies, recordProxyOutcome } from './proxy-pool.js';

export const ZEN_CHECK_CONCURRENCY = 6;
export const ZEN_CHECK_TIMEOUT_MS = 45_000;
export const ZEN_CHECK_MODEL = 'union-alpha';

export interface ZenCheckSummary {
  startedAt: string;
  model: string;
  checked: number;
  served: number;
  rateLimited: number;
  disabled: string[];
  transportFailed: number;
  otherFailed: number;
  errors: string[];
}

let zenCheckInFlight: Promise<ZenCheckSummary> | null = null;
let lastZenCheck: ZenCheckSummary | null = null;

export function isZenCheckInFlight(): boolean {
  return zenCheckInFlight !== null;
}

export function getLastZenCheck(): ZenCheckSummary | null {
  return lastZenCheck;
}

function rateLimitedEnvelope(body: unknown): boolean {
  const type = (body as { error?: { type?: unknown } })?.error?.type;
  return type === 'FreeUsageLimitError' || type === 'RateLimitError' || type === 'SubscriptionUsageLimitError';
}

function envelopeError(body: unknown): boolean {
  const err = (body as { error?: unknown })?.error;
  if (typeof err === 'string') return err.length > 0;
  if (err && typeof err === 'object') return typeof (err as { message?: unknown }).message === 'string';
  return false;
}

export function checkZenPool(): Promise<ZenCheckSummary> {
  if (zenCheckInFlight) return zenCheckInFlight;
  zenCheckInFlight = runZenCheck().finally(() => {
    zenCheckInFlight = null;
  });
  return zenCheckInFlight;
}

async function runZenCheck(): Promise<ZenCheckSummary> {
  const summary: ZenCheckSummary = {
    startedAt: new Date().toISOString(),
    model: ZEN_CHECK_MODEL,
    checked: 0,
    served: 0,
    rateLimited: 0,
    disabled: [],
    transportFailed: 0,
    otherFailed: 0,
    errors: [],
  };
  const targets = listProxies().filter(p => p.enabled === 1 && p.status !== 'error');
  let cursor = 0;
  const workers = Array.from({ length: Math.min(ZEN_CHECK_CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const row = targets[cursor++]!;
      summary.checked++;
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ZEN_CHECK_TIMEOUT_MS);
      try {
        const proxyUrl = buildProxyUrl(row);
        const res: Response = await proxyFetchVia(
          `https://opencode.ai/zen/v1/messages`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'anthropic-version': '2023-06-01',
              'user-agent': zenSpoofUserAgent(),
              'x-opencode-session': newZenSessionId(),
              'x-opencode-request': newZenRequestId(),
              'x-opencode-project': 'global',
              'x-opencode-client': zenSpoofClient(),
            },
            body: JSON.stringify({
              model: ZEN_CHECK_MODEL,
              max_tokens: 20,
              stream: false,
              messages: [{ role: 'user', content: 'ok' }],
            }),
          },
          proxyUrl,
          ZEN_CHECK_TIMEOUT_MS,
        );
        const body = await res.json().catch(() => ({}));
        if (res.status === 429 || rateLimitedEnvelope(body)) {
          summary.rateLimited++;
          summary.disabled.push(row.label || `${row.type}://${row.host}:${row.port}`);
          recordProxyOutcome(row.id, false);
          disablePoolProxy(row.id, `Zen checker: upstream 429 over this proxy`, 'proxy_zen_rate_limit_disabled');
          continue;
        }
        if (res.ok && !envelopeError(body)) {
          summary.served++;
          recordProxyOutcome(row.id, true, Date.now() - startedAt);
          continue;
        }
        summary.otherFailed++;
        recordProxyOutcome(row.id, false);
      } catch (err: any) {
        summary.transportFailed++;
        recordProxyOutcome(row.id, false);
        disablePoolProxy(row.id, `Zen checker: transport failure: ${String(err?.message ?? err).slice(0, 160)}`, 'proxy_transport_disabled');
      } finally {
        clearTimeout(timer);
      }
    }
  });
  await Promise.all(workers);
  lastZenCheck = summary;
  providerLog(
    `Zen checker: ${summary.checked} proxies tested against ${summary.model}, ${summary.served} served, ${summary.rateLimited} rate-limited and disabled, ${summary.transportFailed} transport failures`,
    { level: summary.served > 0 ? 'info' : 'warn', provider: 'proxy-pool', event: 'zen_check_done' },
  );
  return summary;
}
