#!/usr/bin/env node
/**
 * Bundles the report UI (spec §9): "serves a prebuilt static UI shipped inside the package — no
 * build step at install, no CDN, nothing external."
 *
 * In: src/report/ui/main.tsx and src/report/ui/index.html.
 * Out: dist/ui/report.js and dist/ui/index.html — the two files `report/server/assets.ts` looks
 * for, and the only two the page ever requests.
 *
 * Preact is bundled *in*, not externalised: the served page must make no external request, and the
 * server's CSP forbids one anyway. The stylesheet is a TypeScript string injected at mount, so
 * there is no companion CSS file and no CSS loader here.
 */

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = join(root, 'src/report/ui/main.tsx');
const shell = join(root, 'src/report/ui/index.html');
const outDir = join(root, 'dist/ui');
const outFile = join(outDir, 'report.js');

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function buildOnce() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const result = await build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    legalComments: 'none',
    // Nothing external: a single self-contained asset (spec §12).
    external: [],
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
    logLevel: 'warning',
    metafile: true,
  });

  await cp(shell, join(outDir, 'index.html'));

  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  process.stdout.write(`report UI → dist/ui/report.js (${(bytes / 1024).toFixed(1)} kB)\n`);
}

if (!(await exists(entry))) {
  process.stderr.write(`build-ui: no entry point at ${entry}\n`);
  process.exit(1);
}

await buildOnce();

if (watch) {
  const { watch: watchFs } = await import('node:fs');
  let queued = null;
  watchFs(join(root, 'src/report/ui'), { recursive: true }, () => {
    clearTimeout(queued);
    queued = setTimeout(() => {
      buildOnce().catch((error) => process.stderr.write(`${String(error)}\n`));
    }, 50);
  });
  process.stdout.write('watching src/report/ui…\n');
}
