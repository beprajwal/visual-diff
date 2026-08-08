import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
    ],
    exclude: ['node_modules/**', 'dist/**', 'fixtures/**'],
    // Integration tests start dev servers and browsers (spec §11.1, §11.2); unit and golden
    // tests are fast. `npm run test:unit` (vitest run src) keeps the inner loop tight.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: 'default',
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
});
