import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { isAbortLikeError } from '../lib/error-classify.js';

// ── Model discovery on a user's own custom endpoint (#488) ──────────────────
//
// Relay services add and drop models weekly, so registering them by hand from a
// `curl .../v1/models | jq` goes stale immediately. This asks the operator's
// OWN endpoint, with the operator's OWN key, what it currently serves.
//
// Scope: this reads one user-configured base_url. It does not read, refresh or
// publish the provider catalog — nothing here touches catalog sync.
//
// Everything in here assumes the upstream is hostile-by-accident: relays are
// wildly inconsistent about the /models envelope, some answer HTML, and a
// misconfigured base_url can point at something that streams forever. So: cap
// the body, cap the list, accept every envelope we've actually seen, and turn
// any surprise into a clean error instead of a 500.

/** Hard cap on the catalog body we will read. The largest real OpenAI-style
 *  catalog (OpenRouter, ~400 models with metadata) is well under 1 MB. */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

/** Hard cap on how many ids we hand back — a checkbox list, not a data dump. */
export const MAX_DISCOVERED_MODELS = 500;

/** Ids longer than this are certainly not model ids; skip rather than store. */
const MAX_MODEL_ID_LENGTH = 256;

export interface DiscoveredModel {
  id: string;
  ownedBy: string | null;
}

/** Carries the HTTP status the route should answer with, so a relay's 401 stays
 *  a 401 and an unreachable box reads as a gateway problem. */
export class ModelDiscoveryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ModelDiscoveryError';
    this.status = status;
  }
}

// Envelope keys seen in the wild: OpenAI/most relays use `data`, Ollama and a
// few gateways use `models`, some wrap the list one level deeper.
const LIST_KEYS = ['data', 'models', 'result', 'results', 'items'] as const;
// Id aliases: `id` (OpenAI), `name`/`model` (Ollama), plus the snake/camel and
// slug spellings assorted relays ship.
const ID_KEYS = ['id', 'name', 'model', 'model_id', 'modelId', 'slug'] as const;
const OWNER_KEYS = ['owned_by', 'ownedBy', 'organization', 'owner', 'provider', 'publisher'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The model array inside whatever envelope this relay chose. Descends at most
 *  one nesting level ({ data: { models: [...] } }) before giving up. */
function findModelArray(payload: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return null;
  for (const key of LIST_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (depth < 1 && asRecord(value)) {
      const nested = findModelArray(value, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function toDiscovered(entry: unknown): DiscoveredModel | null {
  if (typeof entry === 'string') {
    const id = entry.trim();
    return id ? { id, ownedBy: null } : null;
  }
  const record = asRecord(entry);
  if (!record) return null;
  const id = firstString(record, ID_KEYS);
  return id ? { id, ownedBy: firstString(record, OWNER_KEYS) } : null;
}

/** Whether this payload carries a model list at all — the difference between
 *  an endpoint that genuinely serves nothing and one whose answer we can't
 *  read (an HTML error page, a login redirect, a bare error object). */
export function hasModelList(payload: unknown): boolean {
  return findModelArray(payload) !== null;
}

/**
 * Model ids out of any /models envelope we recognize, deduped, sorted and
 * capped. Returns an empty list for a payload with no list in it — the caller
 * decides whether that's an error worth surfacing.
 */
export function parseModelCatalog(payload: unknown): DiscoveredModel[] {
  const entries = findModelArray(payload);
  if (!entries) return [];

  const byId = new Map<string, DiscoveredModel>();
  for (const entry of entries) {
    const model = toDiscovered(entry);
    if (!model || model.id.length > MAX_MODEL_ID_LENGTH) continue;
    if (!byId.has(model.id)) byId.set(model.id, model);
  }

  return [...byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_DISCOVERED_MODELS);
}

/**
 * Read a response body with a hard byte cap. A declared Content-Length over the
 * cap is refused without reading anything; otherwise the stream is abandoned
 * the moment it runs past the cap, so a base_url pointed at something that
 * never stops can't take the process with it.
 */
export async function readCappedBody(res: Response, maxBytes = MAX_CATALOG_BYTES): Promise<string> {
  const tooLarge = () => new ModelDiscoveryError(
    502, `The endpoint's model list is larger than ${Math.round(maxBytes / 1024)} KB — refusing to read it.`,
  );

  const declared = Number(res.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooLarge();
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

/** The provider's own error text, when it bothered to send one. */
function upstreamMessage(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const error = asRecord(parsed.error);
    const detail = [
      typeof error?.message === 'string' ? error.message : null,
      typeof parsed.message === 'string' ? parsed.message : null,
      typeof parsed.detail === 'string' ? parsed.detail : null,
      typeof parsed.error === 'string' ? parsed.error : null,
    ].find(value => typeof value === 'string' && value.trim().length > 0);
    return detail ? detail.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

/**
 * Ask a custom OpenAI-compatible endpoint what it serves. Reuses the provider
 * adapter's own catalog fetch (auth header, proxy, timeout, quota bookkeeping)
 * rather than re-implementing an HTTP call here.
 */
export async function discoverEndpointModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const provider = new OpenAICompatProvider({
    platform: 'custom',
    name: 'Custom (OpenAI-compatible)',
    baseUrl,
    // Discovery is interactive — the operator is watching a spinner — so don't
    // inherit the 120s custom-provider chat timeout.
    timeoutMs: 30_000,
  });

  let res: Response;
  try {
    res = await provider.fetchModelCatalog(apiKey);
  } catch (err) {
    const reason = isAbortLikeError(err) ? 'timed out' : ((err as Error)?.message ?? 'unknown error');
    throw new ModelDiscoveryError(502, `Could not reach ${baseUrl}/models: ${reason}`);
  }

  const bodyText = await readCappedBody(res);

  if (!res.ok) {
    const detail = upstreamMessage(bodyText);
    if (res.status === 401 || res.status === 403) {
      throw new ModelDiscoveryError(401, `The endpoint rejected the key (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    }
    throw new ModelDiscoveryError(502, `${baseUrl}/models returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new ModelDiscoveryError(502, `${baseUrl}/models did not return a model list (response was not JSON).`);
  }

  // An endpoint that genuinely serves nothing answers `{"data": []}` and that
  // is a valid (if disappointing) result; an unreadable envelope is an error.
  if (!hasModelList(payload)) {
    throw new ModelDiscoveryError(502, `${baseUrl}/models did not return a model list in a format this gateway understands.`);
  }
  return parseModelCatalog(payload);
}
