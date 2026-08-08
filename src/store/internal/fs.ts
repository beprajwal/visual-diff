/**
 * store/internal — filesystem helpers.
 *
 * Self-contained on purpose: the store is the on-disk interface between every other module
 * (spec §5), so it must not depend on any sibling module to read or write a byte.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { StoreError, errnoCode } from '../errors.js';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(target);
    return stat.isDirectory();
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
}

export async function ensureDir(target: string): Promise<void> {
  await fsp.mkdir(target, { recursive: true });
}

export async function readTextOrNull(target: string): Promise<string | null> {
  try {
    return await fsp.readFile(target, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    throw err;
  }
}

export async function readJsonOrNull<T>(target: string): Promise<T | null> {
  const text = await readTextOrNull(target);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new StoreError('corrupt-json', `${target} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

export async function readJson<T>(target: string): Promise<T> {
  const value = await readJsonOrNull<T>(target);
  if (value === null) {
    throw new StoreError('missing-file', `${target} does not exist`);
  }
  return value;
}

/** Newline-delimited JSON. Unparsable lines are returned verbatim so callers never lose data. */
export interface JsonlLine<T> {
  raw: string;
  value: T | null;
}

export async function readJsonl<T>(target: string): Promise<JsonlLine<T>[]> {
  const text = await readTextOrNull(target);
  if (text === null) return [];
  const out: JsonlLine<T>[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      out.push({ raw, value: JSON.parse(raw) as T });
    } catch {
      out.push({ raw, value: null });
    }
  }
  return out;
}

export async function rmrf(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true });
}

export async function listDirEntries(
  target: string,
): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>> {
  try {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
}

export async function listDirNames(target: string): Promise<string[]> {
  return (await listDirEntries(target)).map((entry) => entry.name);
}

export async function listSubdirectories(target: string): Promise<string[]> {
  return (await listDirEntries(target)).filter((e) => e.isDirectory).map((e) => e.name);
}

/** Recursive byte size, used to report what retention freed. Missing paths count as zero. */
export async function dirSize(target: string): Promise<number> {
  let total = 0;
  const stack: string[] = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') continue;
      throw err;
    }
    if (stat.isDirectory()) {
      for (const name of await listDirNames(current)) stack.push(path.join(current, name));
    } else {
      total += stat.size;
    }
  }
  return total;
}

/** Every file under `target`, as paths relative to it, in sorted order. */
export async function walkFiles(target: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await listDirEntries(target)) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory) {
      out.push(...(await walkFiles(path.join(target, entry.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}
