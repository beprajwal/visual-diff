#!/usr/bin/env node
/**
 * Empties the build output directory before a build writes into it.
 *
 * `tsc` only ever *adds* to `outDir`. When a source module is deleted or renamed, its compiled
 * `.js`/`.d.ts` stay behind forever, and `package.json#files` ships whatever is in `dist/` — so a
 * module that no longer exists in `src/` still reaches every consumer, still resolves through a
 * stale relative import, and still gets executed. That is not a tidiness problem, it is a
 * correctness one: the published tree stops being a function of the source tree.
 *
 * So the first step of `npm run build` is to make `dist/` empty, which makes the output a pure
 * function of the input again. `tests/packaging/pack.test.ts` holds the other end of this: every
 * compiled file in the tarball must have a source file behind it.
 *
 * Usage: `node scripts/clean.mjs [--dir <path>]`. `--dir` exists so the behaviour is testable
 * against a scratch directory instead of the real `dist/`.
 */

import { rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Read `--dir <path>`, defaulting to the `outDir` this project compiles into. */
function targetFromArgv(argv) {
  const flag = argv.indexOf('--dir');
  if (flag === -1) return resolve(root, 'dist');

  const value = argv[flag + 1];
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write('clean: --dir needs a path\n');
    process.exit(1);
  }
  return resolve(process.cwd(), value);
}

const target = targetFromArgv(process.argv.slice(2));

/**
 * `rm -rf` on a path computed from argv deserves one guard: never delete a directory that contains
 * the repository. That rejects the repo root itself, `/`, and every ancestor in between — a
 * mistyped `--dir` cannot take the working tree with it — while still allowing a scratch directory
 * somewhere else on disk, which is how this script is tested.
 *
 * `relative(target, root)` is `''` when the two are the same path, and contains no `..` segment
 * when `root` sits underneath `target`; both mean `target` is an ancestor.
 */
const rootFromTarget = relative(target, root);
if (rootFromTarget === '' || !rootFromTarget.startsWith('..')) {
  process.stderr.write(`clean: refusing to remove ${target}, which contains the repository\n`);
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
process.stdout.write(`clean → ${target}\n`);
