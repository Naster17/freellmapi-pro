import fs from 'fs';
import os from 'os';
import path from 'path';

export const TEST_DB_FIXTURE_PATH = path.join(os.tmpdir(), 'freellmapi-server-test-fixture.db');
export const TEST_DB_FIXTURE_ENV = 'FREEAPI_TEST_DB_FIXTURE';

const FIXTURE_DIR_PREFIX = 'freellmapi-test-';
const STALE_AFTER_MS = 3600_000;

export function sweepStaleFixtureDirs(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(FIXTURE_DIR_PREFIX)) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      const pidMatch = /^freellmapi-test-(\d+)-/.exec(name);
      const pid = pidMatch ? Number(pidMatch[1]) : NaN;
      const pidAlive = Number.isInteger(pid) && isPidAlive(pid);
      if (pidAlive && Date.now() - stat.mtimeMs < STALE_AFTER_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}