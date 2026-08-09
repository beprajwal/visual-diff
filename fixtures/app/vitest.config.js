import { defineConfig } from 'vitest/config';

/**
 * The fixture's own suite.
 *
 * It is a separate config because the repository's root `vitest.config.ts` excludes `fixtures/**`
 * outright — the fixture tree is *input* to the integration tests there, and letting the root
 * runner walk into it would collect this suite twice. Run it with `npm test -w fixtures/app`.
 *
 * `tests/replay.e2e.test.ts` launches Chromium and a real Vite dev server, so the timeouts are
 * generous; everything else in here is pure and runs in milliseconds.
 */
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
