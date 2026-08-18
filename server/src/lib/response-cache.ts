import type { NextFunction, Request, Response } from 'express';

type CacheEntry = { value: unknown; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 256;
const ENABLED = process.env.VITEST !== 'true';

export function cachedRoute(ttlMs: number, keyOf: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!ENABLED || req.method !== 'GET') {
      next();
      return;
    }
    const key = keyOf(req);
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      res.json(hit.value);
      return;
    }
    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode === 200) {
        cache.set(key, { value: body, expiresAt: Date.now() + ttlMs });
        if (cache.size > MAX_ENTRIES) {
          const cutoff = Date.now();
          for (const [entryKey, entry] of cache) {
            if (entry.expiresAt <= cutoff) cache.delete(entryKey);
          }
        }
      }
      return sendJson(body);
    }) as typeof res.json;
    next();
  };
}
