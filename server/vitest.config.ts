import os from 'os';
import { defineConfig } from 'vitest/config';

import { TEST_DB_FIXTURE_ENV, TEST_DB_FIXTURE_PATH } from './vitest-fixture.js';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    env: {
      [TEST_DB_FIXTURE_ENV]: TEST_DB_FIXTURE_PATH,
    },
    pool: 'forks',
    fileParallelism: true,
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: Math.max(1, Math.min(os.availableParallelism() - 1, 8)),
      },
    },
    testTimeout: 30_000,
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
