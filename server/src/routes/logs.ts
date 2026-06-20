import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  clearServerLogs,
  getServerLogMeta,
  getServerLogs,
  type ServerLogLevel,
} from '../lib/server-logs.js';

export const logsRouter = Router();

const SERVER_LOG_LEVELS = new Set<ServerLogLevel>(['debug', 'info', 'warn', 'error']);

function parseLevels(raw: unknown): ServerLogLevel[] | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const levels = raw
    .split(',')
    .map(level => level.trim().toLowerCase())
    .filter((level): level is ServerLogLevel => SERVER_LOG_LEVELS.has(level as ServerLogLevel));
  return levels.length > 0 ? levels : undefined;
}

function parseNumber(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

logsRouter.get('/', (req: Request, res: Response) => {
  const entries = getServerLogs({
    levels: parseLevels(req.query.levels),
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
    limit: parseNumber(req.query.limit),
    sinceId: parseNumber(req.query.sinceId),
  });
  res.json({ entries, ...getServerLogMeta() });
});

logsRouter.post('/clear', (_req: Request, res: Response) => {
  clearServerLogs();
  res.json({ ok: true, entries: [], ...getServerLogMeta() });
});
