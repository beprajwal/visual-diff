/**
 * store/internal — atomic writes (spec §10, "Crash mid-run").
 *
 * Two primitives:
 *
 * - `writeFileAtomic` — write to a sibling temp file, fsync it, rename over the target, fsync the
 *   directory. A reader never observes a half-written `meta.json`.
 * - `publishDirAtomic` — fsync every file and directory of a fully-built temp run directory, then
 *   rename it into place under its final name. The rename is the *only* step that makes the run
 *   visible, so a crash at any earlier point leaves nothing for the store or the report to see.
 *
 * Both rely on the temp path living on the same filesystem as the target, which is why temp run
 * directories are created inside `runs/<flow>/` rather than in the OS temp dir.
 */

import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

import { StoreError, errnoCode } from '../errors.js';
import { pathExists, walkFiles } from './fs.js';
import { stableStringify } from './json.js';

/** Directory fsync is unsupported on some platforms; those errors are not failures. */
const DIR_FSYNC_IGNORED = new Set(['EPERM', 'EISDIR', 'EACCES', 'EINVAL', 'ENOTSUP', 'ENOSYS']);

export function tempSuffix(): string {
  return `${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`;
}

export async function fsyncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await fsp.open(dir, 'r');
  } catch (err) {
    const code = errnoCode(err);
    if (code !== undefined && DIR_FSYNC_IGNORED.has(code)) return;
    if (code === 'ENOENT') return;
    throw err;
  }
  try {
    await handle.sync();
  } catch (err) {
    const code = errnoCode(err);
    if (code === undefined || !DIR_FSYNC_IGNORED.has(code)) throw err;
  } finally {
    await handle.close();
  }
}

export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${tempSuffix()}`);
  try {
    const handle = await fsp.open(tmp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await fsyncDir(dir);
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeFileAtomic(target, `${stableStringify(value)}\n`);
}

/** fsync every file under `dir`, then every directory, deepest first. */
export async function fsyncTree(dir: string): Promise<void> {
  const files = await walkFiles(dir);
  for (const rel of files) {
    const handle = await fsp.open(path.join(dir, rel), 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const dirs = new Set<string>(['']);
  for (const rel of files) {
    const parts = rel.split('/');
    parts.pop();
    let acc = '';
    for (const part of parts) {
      acc = acc === '' ? part : `${acc}/${part}`;
      dirs.add(acc);
    }
  }
  for (const rel of [...dirs].sort((a, b) => b.length - a.length)) {
    await fsyncDir(rel === '' ? dir : path.join(dir, rel));
  }
}

/**
 * Publish a fully-built temp directory under its final name. The final path must not already
 * exist: the run store is append-only (D3), so a collision is a bug, never an overwrite.
 */
export async function publishDirAtomic(tempDir: string, finalDir: string): Promise<void> {
  if (await pathExists(finalDir)) {
    throw new StoreError('already-exists', `${finalDir} already exists; refusing to overwrite`);
  }
  await fsyncTree(tempDir);
  const parent = path.dirname(finalDir);
  await fsp.mkdir(parent, { recursive: true });
  try {
    await fsp.rename(tempDir, finalDir);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      throw new StoreError('already-exists', `${finalDir} already exists; refusing to overwrite`, {
        cause: err,
      });
    }
    throw err;
  }
  await fsyncDir(parent);
}
