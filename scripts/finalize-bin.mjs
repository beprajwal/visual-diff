#!/usr/bin/env node
/**
 * Makes the emitted binary executable.
 *
 * `tsc` writes `dist/cli/index.js` with mode 0644, and npm only fixes the mode of a `bin` entry
 * when it links the package into a `node_modules/.bin` directory. `npx @beprajwal/visual-diff …` on a
 * freshly extracted tarball runs the file through that link, but anyone who unpacks the tarball
 * and invokes `dist/cli/index.js` directly — a Docker image layer, a vendored copy, a smoke test —
 * gets `permission denied`. Setting the bit at build time makes the artifact correct on its own.
 *
 * It also asserts the shebang survived compilation, because a bin without one is a file the shell
 * hands to `sh`, and the failure ("syntax error near unexpected token") explains nothing.
 */

import { chmod, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Read the `bin` map from the manifest so this never drifts from what npm links. */
async function binTargets() {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const bin = manifest.bin ?? {};
  const entries = typeof bin === 'string' ? [[manifest.name, bin]] : Object.entries(bin);
  return entries.map(([name, path]) => ({ name, path: resolve(root, path) }));
}

const MODE = 0o755;

let failed = false;

for (const target of await binTargets()) {
  try {
    await stat(target.path);
  } catch {
    process.stderr.write(`finalize-bin: ${target.name} → ${target.path} does not exist\n`);
    failed = true;
    continue;
  }

  const source = await readFile(target.path, 'utf8');
  if (!source.startsWith('#!')) {
    process.stderr.write(`finalize-bin: ${target.path} has no shebang\n`);
    failed = true;
    continue;
  }

  await chmod(target.path, MODE);
  process.stdout.write(`bin ${target.name} → ${target.path} (0${MODE.toString(8)})\n`);
}

if (failed) process.exit(1);
