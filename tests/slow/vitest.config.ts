/**
 * The slow suite's own vitest config (`npm run test:slow`).
 *
 * The default suite (`npm test`) must stay fast enough to run on every save, so the end-to-end
 * tests that install dependencies from the network, spawn a real dev server per revision and drive
 * headless Chromium seven times live behind a second config instead of behind a tag.
 *
 * Two mechanics keep the two suites disjoint without touching the root config:
 *
 *  - Slow specs are named `*.e2e.ts`, which the root config's `tests/**\/*.test.ts` glob does not
 *    match, so `vitest run` cannot pick them up by accident.
 *  - `root` is pinned at the repository root so the include glob, the source imports and the
 *    fixture paths all resolve exactly as they do for the fast suite.
 */

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/slow/**/*.e2e.ts'],
    exclude: ['node_modules/**', 'dist/**', 'fixtures/.tmp/**'],
    // A single revision costs a worktree, a dep-cache lookup, a Vite boot, a Chromium launch and a
    // full replay; there are seven of them plus six diffs, and the first run pays for `npm install`.
    testTimeout: 15 * 60_000,
    hookTimeout: 45 * 60_000,
    // Every spec here drives real ports, real worktrees and real browsers. Serial by construction.
    fileParallelism: false,
    reporters: 'default',
  },
});
