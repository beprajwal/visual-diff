import { defineConfig } from 'vite';

/**
 * Preact through esbuild's automatic JSX runtime rather than through `@preact/preset-vite`.
 *
 * The preset would add a dependency (and its tree) to an install that the slow suite performs
 * inside a git worktree on every historical replay — api-mocking spec §9 calls install time "a
 * direct cost on every test run". Two lines of esbuild configuration buy the same thing, so the
 * whole fixture is `preact` plus `vite` and nothing else.
 *
 * The runner allocates a port and substitutes it into the `dev` command from
 * `.visual-diff/config.yaml`, so the only thing fixed here is the host: the driver and the report
 * both talk to 127.0.0.1, and binding a public interface would make the fixture behave differently
 * on CI than on a laptop.
 */
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    strictPort: true,
  },
  build: {
    // Named chunks and assets, so a built fixture diffs against itself across revisions instead of
    // reporting every file as renamed because its content hash moved.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
