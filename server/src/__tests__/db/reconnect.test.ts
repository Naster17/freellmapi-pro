import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('getDb ping and reconnect', () => {
  it('ping is skipped for the first 30s after initDb', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.resetModules();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-reconnect-'));
    const dbPath = path.join(tmpDir, 'freeapi.db');

    const { initDb, getDb } = await import('../../db/index.js');
    initDb(dbPath);

    const db = getDb();
    const spy = vi.spyOn(db, 'prepare');
    getDb();
    getDb();
    getDb();
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws if getDb is called before initDb', async () => {
    vi.resetModules();
    const { getDb } = await import('../../db/index.js');
    expect(() => getDb()).toThrow(/not initialized/);
  });

  it('closeDb is safe to call when not initialized', async () => {
    vi.resetModules();
    const { closeDb } = await import('../../db/index.js');
    expect(() => closeDb()).not.toThrow();
  });
});
