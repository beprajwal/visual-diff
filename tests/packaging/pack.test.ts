/**
 * What `npm publish` would actually ship.
 *
 * The package is distributed for `npx visual-diff <cmd>` with nothing installed beforehand, so the
 * tarball is a user-facing artifact, not a build by-product. Three properties of it are load-bearing
 * and none of them is visible from the source tree:
 *
 *  1. **The bin exists, is executable and has a shebang.** `npx` runs it through a `node_modules/.bin`
 *     link; without the mode bit or the `#!` line, every invocation dies in the shell with a message
 *     that explains nothing.
 *  2. **No sourcemaps.** `.js.map` and `.d.ts.map` point at `src/`, which is never published — they
 *     were roughly half the file count and a third of the bytes of every `npx` download.
 *  3. **`.d.ts` survives.** The package has a library export (`main`/`types`/`exports`), so the
 *     declarations are part of the contract even though the maps are not.
 *
 * This packs the real project with the real `npm pack` (which runs `prepack`, i.e. the real build)
 * into a temporary directory and inspects the extracted tree. Nothing is published, and no tarball
 * is left in the working tree.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

let workDir: string;
/** The extracted tarball root — npm always packs into a top-level `package/` directory. */
let pkgDir: string;
let manifest: {
  bin?: Record<string, string>;
  main?: string;
  types?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
let files: string[];

/** Every file in `dir`, as paths relative to `dir` with `/` separators. */
async function walk(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'vdiff-pack-'));

  const { stdout } = await run('npm', ['pack', '--pack-destination', workDir], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  const tarball = join(workDir, stdout.trim().split('\n').pop() ?? '');
  await stat(tarball);

  await run('tar', ['-xzf', tarball, '-C', workDir]);
  pkgDir = join(workDir, 'package');

  manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  files = await walk(pkgDir);
}, 180_000);

afterAll(async () => {
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

describe('the published tarball', () => {
  it('declares a bin and ships the file it points at', async () => {
    expect(manifest.bin).toEqual({ vdiff: './dist/cli/index.js' });

    const bin = resolve(pkgDir, manifest.bin?.['vdiff'] ?? '');
    const info = await stat(bin);
    expect(info.isFile()).toBe(true);
    expect(info.size).toBeGreaterThan(0);
  });

  it('ships the bin executable — `npx visual-diff` runs it through a .bin link', async () => {
    const bin = resolve(pkgDir, manifest.bin?.['vdiff'] ?? '');
    const mode = (await stat(bin)).mode & 0o777;
    // Owner, group and other must all be able to execute it: npm links the file, it is not copied.
    expect(mode & 0o111, `mode ${mode.toString(8)}`).toBe(0o111);
  });

  it('ships the bin with a node shebang', async () => {
    const bin = resolve(pkgDir, manifest.bin?.['vdiff'] ?? '');
    const source = await readFile(bin, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('contains no sourcemaps or declaration maps', () => {
    expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
  });

  it('still ships the declarations the library export promises', () => {
    expect(manifest.main).toBe('./dist/index.js');
    expect(manifest.types).toBe('./dist/index.d.ts');
    expect(files).toContain('dist/index.d.ts');
    expect(files.filter((file) => file.endsWith('.d.ts')).length).toBeGreaterThan(10);
  });

  it('ships the prebuilt report UI, so serving needs no build and no CDN', () => {
    expect(files).toContain('dist/ui/report.js');
    expect(files).toContain('dist/ui/index.html');
  });

  it('ships no sources, tests or config', () => {
    for (const file of files) {
      expect(file.startsWith('src/'), file).toBe(false);
      expect(file.startsWith('tests/'), file).toBe(false);
      expect(file.endsWith('.test.js'), file).toBe(false);
      expect(file.endsWith('.tsbuildinfo'), file).toBe(false);
    }
  });

  it('depends on playwright-core, never on playwright — npx must not pay for a browser download', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toContain('playwright-core');
    // `playwright` pulls a test runner this tool never uses and is the package that has carried a
    // browser-downloading install hook. It may stay a devDependency — a consumer never installs
    // those — but it must never be something `npx visual-diff --help` has to fetch first.
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('playwright');
    expect(Object.keys(manifest.devDependencies ?? {})).toContain('playwright');
  });
});
