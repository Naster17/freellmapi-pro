// Standalone vitest config so tests don't load vite.config.ts (whose React +
// Tailwind plugins are pointless for unit tests). Store/timer tests are plain
// TypeScript, so the default node environment is enough — no jsdom.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
