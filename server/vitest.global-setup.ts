import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

import { runMigrationsSync } from './src/db/migrate/runner.js';
import type { Db } from './src/db/types.js';
import { sweepStaleFixtureDirs, TEST_DB_FIXTURE_PATH } from './vitest-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_FILES = [
  path.join(__dirname, 'src/db/migrate/defaults.ts'),
  path.join(__dirname, 'src/db/migrate/runner.ts'),
  ...fs
    .readdirSync(path.join(__dirname, 'src/db/migrations'))
    .filter((filename) => filename.endsWith('.ts'))
    .map((filename) => path.join(__dirname, 'src/db/migrations', filename)),
];

export default function setup(): () => void {
  sweepStaleFixtureDirs();

  if (isFixtureCurrent()) return () => sweepStaleFixtureDirs();

  const raw = new Database(':memory:');
  const db = raw as unknown as Db;
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrationsSync(db, 'up');
  const bytes = raw.serialize();
  raw.close();

  fs.writeFileSync(TEST_DB_FIXTURE_PATH, bytes);
  console.log(`[test] migrated DB fixture ready at ${TEST_DB_FIXTURE_PATH}`);
  return () => sweepStaleFixtureDirs();
}

function isFixtureCurrent(): boolean {
  try {
    const fixtureStat = fs.statSync(TEST_DB_FIXTURE_PATH);
    if (fixtureStat.size === 0) return false;
    const newestSource = SOURCE_FILES.reduce(
      (newest, file) => Math.max(newest, fs.statSync(file).mtimeMs),
      0,
    );
    return fixtureStat.mtimeMs > newestSource;
  } catch {
    return false;
  }
}