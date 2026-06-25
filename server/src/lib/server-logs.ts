import { inspect } from 'node:util';

export type ServerLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ServerLogEntry {
  id: number;
  timestamp: string;
  level: ServerLogLevel;
  message: string;
  provider?: string;
  model?: string;
  event?: string;
  requestId?: string;
}

const MAX_LOG_ENTRIES = 1000;
const MAX_MESSAGE_LENGTH = 6000;

const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]'],
  [/\b(api[_-]?key|access[_-]?token|token|secret|authorization)(\s*[:=]\s*)(["']?)[^"',\s}\]]+/gi, '$1$2$3[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  [/\bgsk_[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  [/\bfreellmapi-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-key]'],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]'],
];

let nextLogId = 1;
let installed = false;
const entries: ServerLogEntry[] = [];

function redact(message: string): string {
  let out = message;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.length > MAX_MESSAGE_LENGTH ? `${out.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : out;
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  return inspect(arg, { depth: 5, breakLength: 140, maxArrayLength: 80 });
}

export function appendServerLog(level: ServerLogLevel, args: unknown[], meta?: { provider?: string; model?: string; event?: string; requestId?: string }): ServerLogEntry {
  const entry: ServerLogEntry = {
    id: nextLogId++,
    timestamp: new Date().toISOString(),
    level,
    message: redact(args.map(formatArg).join(' ')),
    ...meta,
  };
  entries.push(entry);
  if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  return entry;
}

export interface ProviderLogOptions {
  level?: ServerLogLevel;
  provider: string;
  model?: string;
  event?: string;
  requestId?: string;
}

export function providerLog(message: string, opts: ProviderLogOptions): ServerLogEntry {
  const { level = 'info', provider, model, event, requestId } = opts;
  const meta = { provider, model, event, requestId };
  const entry = appendServerLog(level, [message], meta);
  return entry;
}

export function getServerLogs(options: { levels?: ServerLogLevel[]; q?: string; limit?: number; sinceId?: number; provider?: string } = {}) {
  const allowed = options.levels && options.levels.length > 0 ? new Set(options.levels) : null;
  const q = options.q?.trim().toLowerCase();
  const provider = options.provider?.trim().toLowerCase();
  const sinceId = Number.isFinite(options.sinceId) ? options.sinceId! : 0;
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 500);

  return entries
    .filter(entry => entry.id > sinceId)
    .filter(entry => !allowed || allowed.has(entry.level))
    .filter(entry => !q || entry.message.toLowerCase().includes(q) || entry.provider?.toLowerCase().includes(q))
    .filter(entry => !provider || entry.provider?.toLowerCase() === provider)
    .slice(-limit);
}

export function clearServerLogs(): void {
  entries.length = 0;
}

export function getServerLogMeta() {
  return {
    levels: ['debug', 'info', 'warn', 'error'] as ServerLogLevel[],
    maxEntries: MAX_LOG_ENTRIES,
    nextId: nextLogId,
  };
}

export function installServerLogCapture(): void {
  if (installed) return;
  installed = true;

  const originals = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.debug = (...args: unknown[]) => {
    appendServerLog('debug', args);
    originals.debug(...args);
  };
  console.info = (...args: unknown[]) => {
    appendServerLog('info', args);
    originals.info(...args);
  };
  console.log = (...args: unknown[]) => {
    appendServerLog('info', args);
    originals.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    appendServerLog('warn', args);
    originals.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    appendServerLog('error', args);
    originals.error(...args);
  };
}
