import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  PROXY_TYPES,
  createProxy,
  updateProxy,
  deleteProxy,
  listProxies,
  getProxy,
  checkProxy,
  checkAllProxies,
  isCheckAllInFlight,
  getProxyActivity,
  type ProxyRow,
} from '../services/proxy-pool.js';

export const proxiesRouter = Router();

const addressSchema = z.string().trim().min(1).max(300);

const createSchema = z.object({
  type: z.enum(PROXY_TYPES),
  address: addressSchema,
  label: z.string().trim().max(100).optional(),
});

const updateSchema = z.object({
  label: z.string().trim().max(100).optional(),
  enabled: z.boolean().optional(),
  type: z.enum(PROXY_TYPES).optional(),
  address: addressSchema.optional(),
});

function toJson(row: ProxyRow) {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    host: row.host,
    port: row.port,
    address: row.host.includes(':') ? `[${row.host}]:${row.port}` : `${row.host}:${row.port}`,
    hasAuth: Boolean(row.username),
    enabled: row.enabled === 1,
    status: row.status,
    latencyMs: row.latency_ms,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
  };
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid proxy id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Proxy not found' } });
}

proxiesRouter.get('/', (_req: Request, res: Response) => {
  res.json({ proxies: listProxies().map(toJson) });
});

proxiesRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid proxy: type and address are required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const row = createProxy(parsed.data);
    res.status(201).json({ proxy: toJson(row) });
  } catch (err: any) {
    res.status(400).json({ error: { message: err?.message ?? 'Invalid proxy address', type: 'invalid_request_error' } });
  }
});

proxiesRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!getProxy(id)) return notFound(res);
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid proxy update', type: 'invalid_request_error' } });
    return;
  }
  try {
    const row = updateProxy(id, parsed.data);
    res.json({ proxy: toJson(row) });
  } catch (err: any) {
    res.status(400).json({ error: { message: err?.message ?? 'Invalid proxy address', type: 'invalid_request_error' } });
  }
});

proxiesRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!getProxy(id)) return notFound(res);
  deleteProxy(id);
  res.json({ success: true });
});

proxiesRouter.post('/check-all', (_req: Request, res: Response) => {
  const wasInFlight = isCheckAllInFlight();
  void checkAllProxies().catch(err => {
    console.error('[ProxyPool] check-all background error:', err);
  });
  res.status(202).json({ accepted: true, alreadyInFlight: wasInFlight });
});

proxiesRouter.post('/:id/check', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!getProxy(id)) return notFound(res);
  try {
    const result = await checkProxy(id);
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message ?? 'Proxy check failed' } });
  }
});

proxiesRouter.get('/activity', (_req: Request, res: Response) => {
  const snapshot = getProxyActivity();
  const assignments = snapshot.assignments.map(a => ({
    platform: a.platform,
    sinceMs: a.sinceMs,
    proxy: a.proxy ? toJson(a.proxy) : null,
    history: a.history,
  }));
  res.json({ assignments, events: snapshot.events });
});