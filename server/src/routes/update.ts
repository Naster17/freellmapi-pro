import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getAppVersion } from '../lib/app-version.js';

const execFileAsync = promisify(nodeExecFile);

const REPOSITORY = 'tashfeenahmed/freellmapi';
const CACHE_TTL_MS = 5 * 60 * 1000;
// Failures are cached too, briefly. Without this a box that cannot reach GitHub
// re-dials the API and then the Atom feed on every single click.
const FAILURE_TTL_MS = 45 * 1000;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const COMPARE_STATUSES = ['identical', 'ahead', 'behind', 'diverged'] as const;
const MAX_CHANGES = 8;
const MAX_CHANGE_MESSAGE_LENGTH = 160;
const MAX_ATOM_FEED_LENGTH = 1_000_000;

// Express's Response is imported into this module, so name the fetch one via the
// fetch signature rather than the shadowed global.
type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

type Installation = 'source' | 'docker' | 'desktop' | 'unknown';
type CheckStatus = 'current' | 'available' | 'ahead' | 'diverged' | 'unknown' | 'unsupported' | 'disabled';
type CompareStatus = (typeof COMPARE_STATUSES)[number];

interface Identity {
  sha: string | null;
  installation: Installation;
}

interface CheckResult {
  status: CheckStatus;
  installation: Installation;
  localSha: string | null;
  checkedAt: string;
  /** The release this build is (#703), or null when it cannot be established. */
  version: string | null;
  remoteSha?: string;
  remoteMessage?: string;
  remoteDate?: string;
  changes?: Change[];
}

interface Change {
  sha: string;
  message: string;
  date?: string;
}

interface CachedResult {
  result: CheckResult;
  cachedAt: number;
}

type ExecFile = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8'; timeout: number },
) => Promise<{ stdout: string | Buffer }>;

export interface UpdateRouterOptions {
  fetch?: typeof globalThis.fetch;
  execFile?: ExecFile;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  logger?: Pick<Console, 'error'>;
  version?: () => string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSha(value: unknown): string | null {
  return typeof value === 'string' && SHA_PATTERN.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function compareStatus(value: unknown): CompareStatus | null {
  return typeof value === 'string' && (COMPARE_STATUSES as readonly string[]).includes(value)
    ? value as CompareStatus
    : null;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function mapCompareStatus(status: CompareStatus): Exclude<CheckStatus, 'unknown' | 'unsupported' | 'disabled'> {
  switch (status) {
    case 'identical': return 'current';
    case 'ahead': return 'available';
    case 'behind': return 'ahead';
    case 'diverged': return 'diverged';
  }
}

function remoteCommit(body: Record<string, unknown>, status: CompareStatus): Record<string, unknown> | null {
  if (!Array.isArray(body.commits)) {
    throw new Error('GitHub compare response has no commits array');
  }

  const lastCommit = body.commits.at(-1);
  const candidate = lastCommit
    ?? (status === 'behind' ? body.merge_base_commit : body.base_commit);

  if (candidate === undefined || candidate === null) return null;
  if (!isRecord(candidate)) throw new Error('GitHub compare response has an invalid commit');
  return candidate;
}

function parseRemoteMetadata(
  body: Record<string, unknown>,
  status: CompareStatus,
  localSha: string,
): Pick<CheckResult, 'remoteSha' | 'remoteMessage' | 'remoteDate'> {
  const candidate = remoteCommit(body, status);
  if (!candidate) {
    return status === 'identical' ? { remoteSha: localSha.slice(0, 7) } : {};
  }

  const sha = validSha(candidate.sha);
  if (!sha) throw new Error('GitHub compare response has an invalid commit SHA');

  const metadata: Pick<CheckResult, 'remoteSha' | 'remoteMessage' | 'remoteDate'> = {
    remoteSha: sha.slice(0, 7),
  };
  if (candidate.commit === undefined || candidate.commit === null) return metadata;
  if (!isRecord(candidate.commit)) throw new Error('GitHub compare response has invalid commit metadata');

  if (candidate.commit.message !== undefined) {
    if (typeof candidate.commit.message !== 'string') {
      throw new Error('GitHub compare response has an invalid commit message');
    }
    metadata.remoteMessage = candidate.commit.message.slice(0, 200);
  }

  const committer = candidate.commit.committer;
  if (committer !== undefined && committer !== null) {
    if (!isRecord(committer)) throw new Error('GitHub compare response has an invalid committer');
    if (committer.date !== undefined && committer.date !== null) {
      if (!validDate(committer.date)) {
        throw new Error('GitHub compare response has an invalid commit date');
      }
      metadata.remoteDate = committer.date;
    }
  }

  return metadata;
}

function parseChanges(body: Record<string, unknown>, status: CompareStatus): Change[] | undefined {
  if (status !== 'ahead') return undefined;
  if (!Array.isArray(body.commits)) {
    throw new Error('GitHub compare response has no commits array');
  }

  return body.commits.slice(-MAX_CHANGES).reverse().map((candidate: unknown) => {
    if (!isRecord(candidate)) throw new Error('GitHub compare response has an invalid commit');
    const sha = validSha(candidate.sha);
    if (!sha) throw new Error('GitHub compare response has an invalid commit SHA');
    if (!isRecord(candidate.commit)) {
      throw new Error('GitHub compare response has invalid commit metadata');
    }
    if (typeof candidate.commit.message !== 'string') {
      throw new Error('GitHub compare response has an invalid commit message');
    }

    const change: Change = {
      sha: sha.slice(0, 7),
      message: candidate.commit.message
        .slice(0, MAX_CHANGE_MESSAGE_LENGTH)
        .split(/[\r\n]/, 1)[0],
    };
    const committer = candidate.commit.committer;
    if (committer !== undefined && committer !== null) {
      if (!isRecord(committer)) throw new Error('GitHub compare response has an invalid committer');
      if (committer.date !== undefined && committer.date !== null) {
        if (!validDate(committer.date)) {
          throw new Error('GitHub compare response has an invalid commit date');
        }
        change.date = committer.date;
      }
    }
    return change;
  });
}

function decodeXmlText(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|apos|gt|lt|quot));/gi, (entity, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[String(name).toLowerCase()] ?? entity;
  });
}

/**
 * Read a response body with a hard byte ceiling, so an oversized feed is refused
 * on the way in rather than after it is already resident. Checking `.length`
 * after `await response.text()` — as this used to — is a cap that never bounds
 * anything.
 */
async function readCapped(response: FetchResponse, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error('GitHub Atom feed is too large');
  }

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // A fetch implementation without a readable body (or a stub); fall back to
    // buffering, and still refuse anything over the ceiling.
    const text = await response.text();
    if (text.length > limit) throw new Error('GitHub Atom feed is too large');
    return text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let read = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > limit) throw new Error('GitHub Atom feed is too large');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => { /* the ceiling already decided the outcome */ });
  }
  return text + decoder.decode();
}

function parseAtomFallback(
  xml: string,
  localSha: string,
  baseResult: Pick<CheckResult, 'installation' | 'localSha' | 'checkedAt' | 'version'>,
): CheckResult {
  const commits: Array<Change & { fullSha: string }> = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const entry = match[1];
    const sha = entry.match(/<id>[^<]*Commit\/([0-9a-f]{40})<\/id>/i)?.[1]?.toLowerCase();
    const title = entry.match(/<title>\s*([\s\S]*?)\s*<\/title>/i)?.[1];
    const updated = entry.match(/<updated>\s*([^<]+)\s*<\/updated>/i)?.[1]?.trim();
    if (!sha || title === undefined || (updated !== undefined && !validDate(updated))) {
      throw new Error('GitHub Atom feed has an invalid commit');
    }

    commits.push({
      fullSha: sha,
      sha: sha.slice(0, 7),
      message: decodeXmlText(title).replace(/\s+/g, ' ').trim().slice(0, MAX_CHANGE_MESSAGE_LENGTH),
      ...(updated ? { date: updated } : {}),
    });
  }

  if (commits.length === 0 || commits[0].message.length === 0) {
    throw new Error('GitHub Atom feed has no commits');
  }

  const latest = commits[0];
  const localIndex = commits.findIndex(commit => commit.fullSha === localSha);
  const status: CheckStatus = localIndex === 0
    ? 'current'
    : localIndex > 0
      ? 'available'
      : 'unknown';

  return {
    status,
    ...baseResult,
    remoteSha: latest.sha,
    remoteMessage: latest.message,
    ...(latest.date ? { remoteDate: latest.date } : {}),
    ...(status === 'available'
      ? { changes: commits.slice(0, localIndex).slice(0, MAX_CHANGES).map(({ fullSha: _fullSha, ...change }) => change) }
      : {}),
  };
}

export function createUpdateRouter(options: UpdateRouterOptions = {}): Router {
  const router = Router();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const execFile: ExecFile = options.execFile ?? ((file, args, execOptions) => (
    execFileAsync(file, args, execOptions)
  ));
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const appVersion = options.version ?? getAppVersion;
  const updateCheckDisabled = env.FREELLMAPI_UPDATE_CHECK?.trim().toLowerCase() === 'off';
  const githubToken = env.FREELLMAPI_UPDATE_GITHUB_TOKEN?.trim();

  let identity: Identity | undefined;
  let cache: CachedResult | null = null;
  let failedAt: number | null = null;
  let inFlight: Promise<CheckResult> | null = null;

  // Lazily resolved, and asynchronously: `git rev-parse` used to run through
  // execFileSync inside the request handler, which blocked the event loop for
  // every other in-flight request on the first open of Settings.
  async function resolveIdentity(): Promise<Identity> {
    if (identity) return identity;

    const environmentSha = validSha(env.FREELLMAPI_COMMIT_SHA);
    const installMethod = env.FREELLMAPI_INSTALL_METHOD;
    if (installMethod === 'docker' || installMethod === 'desktop') {
      // Deliberately before the SHA check: a self-built image without
      // --build-arg has no embedded SHA, and it is still a container install.
      identity = { sha: environmentSha, installation: installMethod };
      return identity;
    }

    try {
      const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
        cwd: options.cwd ?? process.cwd(),
        encoding: 'utf8',
        timeout: 5_000,
      });
      const gitSha = validSha(stdout.toString());
      if (gitSha) {
        identity = { sha: gitSha, installation: 'source' };
        return identity;
      }
    } catch {
      // A packaged or custom build may not have Git metadata.
    }

    identity = { sha: null, installation: 'unknown' };
    return identity;
  }

  async function performCheck(currentIdentity: Identity): Promise<CheckResult> {
    const checkedAtMs = now();
    const baseResult = {
      installation: currentIdentity.installation,
      localSha: currentIdentity.sha!.slice(0, 7),
      checkedAt: new Date(checkedAtMs).toISOString(),
      version: appVersion(),
    };
    const url = `https://api.github.com/repos/${REPOSITORY}/compare/${currentIdentity.sha}...main`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'freellmapi-update-checker',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) {
      return { status: 'unknown', ...baseResult };
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      const atomResponse = await fetchImpl(`https://github.com/${REPOSITORY}/commits/main.atom`, {
        headers: {
          Accept: 'application/atom+xml',
          'User-Agent': 'freellmapi-update-checker',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!atomResponse.ok) {
        throw new Error(`GitHub Atom request returned HTTP ${atomResponse.status}`);
      }
      return parseAtomFallback(
        await readCapped(atomResponse, MAX_ATOM_FEED_LENGTH),
        currentIdentity.sha!,
        baseResult,
      );
    }
    if (!response.ok) {
      throw new Error(`GitHub compare request returned HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error('GitHub compare response is not an object');
    const upstreamStatus = compareStatus(body.status);
    if (!upstreamStatus) throw new Error('GitHub compare response has an invalid status');

    return {
      status: mapCompareStatus(upstreamStatus),
      ...baseResult,
      ...parseRemoteMetadata(body, upstreamStatus, currentIdentity.sha!),
      ...(upstreamStatus === 'ahead' ? { changes: parseChanges(body, upstreamStatus) } : {}),
    };
  }

  function check(currentIdentity: Identity): Promise<CheckResult> {
    const currentTime = now();
    if (cache && currentTime - cache.cachedAt < CACHE_TTL_MS) {
      return Promise.resolve(cache.result);
    }
    if (failedAt !== null && currentTime - failedAt < FAILURE_TTL_MS) {
      return Promise.reject(new Error('GitHub update check failed recently'));
    }
    if (inFlight) return inFlight;

    const request = performCheck(currentIdentity)
      .then((result) => {
        cache = { result, cachedAt: now() };
        failedAt = null;
        return result;
      })
      .catch((error: unknown) => {
        failedAt = now();
        logger.error('[update] GitHub compare check failed', error);
        throw error;
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
      });
    inFlight = request;
    return request;
  }

  router.get('/check', async (_req: Request, res: Response) => {
    if (updateCheckDisabled) {
      return res.json({
        status: 'disabled',
        installation: 'unknown',
        localSha: null,
        checkedAt: new Date(now()).toISOString(),
        version: null,
      } satisfies CheckResult);
    }

    const currentIdentity = await resolveIdentity();
    if (!currentIdentity.sha) {
      return res.json({
        status: 'unsupported',
        installation: currentIdentity.installation,
        localSha: null,
        checkedAt: new Date(now()).toISOString(),
        version: appVersion(),
      } satisfies CheckResult);
    }

    try {
      return res.json(await check(currentIdentity));
    } catch {
      return res.status(502).json({
        error: {
          message: 'Unable to check for updates',
          type: 'upstream_error',
        },
      });
    }
  });

  router.get('/status', async (_req: Request, res: Response) => {
    if (updateCheckDisabled) {
      return res.json({
        status: 'disabled',
        installation: 'unknown',
        localSha: null,
        lastChecked: null,
        version: null,
      });
    }

    const currentIdentity = await resolveIdentity();
    res.json({
      status: currentIdentity.sha ? (cache?.result.status ?? 'idle') : 'unsupported',
      installation: currentIdentity.installation,
      localSha: currentIdentity.sha?.slice(0, 7) ?? null,
      lastChecked: cache?.result.checkedAt ?? null,
      version: appVersion(),
    });
  });

  return router;
}

export const updateRouter = createUpdateRouter();
