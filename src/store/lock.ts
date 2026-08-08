/**
 * store/lock — per-flow lockfile with stale-PID detection (spec §10, "Concurrent runs on one flow").
 *
 * `.visual-diff/.locks/<flow>.lock` holds a `LockInfo`. Acquisition is an exclusive `O_CREAT|O_EXCL`
 * create, so two processes racing cannot both win. A lock left behind by a crashed run is reclaimed
 * when its recorded pid is no longer alive *on this host* — a lock written by another machine (a
 * shared checkout on a network filesystem) is never stolen, because its pid means nothing here.
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';

import { StoreError, errnoCode } from './errors.js';
import { ensureDir, readJsonOrNull } from './internal/fs.js';
import { lockFile, locksDir } from './paths.js';
import type { LockInfo } from '../types.js';

export interface LockHandle {
  readonly info: LockInfo;
  readonly path: string;
  /** True once released; a second release is a no-op. */
  readonly released: boolean;
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  /** Reclaim a lock whose pid is dead on this host. Defaults to true. */
  reclaimStale?: boolean;
  /** Injected for tests; defaults to `process.pid`. */
  pid?: number;
  /** Injected for tests; defaults to `os.hostname()`. */
  host?: string;
  now?: Date;
}

/** `kill(pid, 0)`: ESRCH means gone, EPERM means alive but owned by another user. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === 'EPERM';
  }
}

export async function readLock(root: string, flow: string): Promise<LockInfo | null> {
  return readJsonOrNull<LockInfo>(lockFile(root, flow)).catch(() => null);
}

function isStale(info: LockInfo | null, host: string): boolean {
  // An unreadable or malformed lock cannot be trusted to describe a live process.
  if (info === null) return true;
  if (typeof info.pid !== 'number' || typeof info.host !== 'string') return true;
  if (info.host !== host) return false;
  return !isProcessAlive(info.pid);
}

export async function acquireLock(
  root: string,
  flow: string,
  options: AcquireLockOptions = {},
): Promise<LockHandle> {
  const reclaimStale = options.reclaimStale ?? true;
  const pid = options.pid ?? process.pid;
  const host = options.host ?? os.hostname();
  const startedAt = (options.now ?? new Date()).toISOString();
  const info: LockInfo = { flow, pid, host, startedAt };
  const target = lockFile(root, flow);
  await ensureDir(locksDir(root));
  const payload = `${JSON.stringify(info, null, 2)}\n`;

  // Two attempts: the second exists so that reclaiming a stale lock does not need its own code
  // path, and so a lost race against another reclaimer still reports `locked` rather than crashing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(target, 'wx');
      try {
        await handle.writeFile(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return makeHandle(target, info);
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err;
      let existing = await readLock(root, flow);
      if (existing === null) {
        // The holder creates the file exclusively and then writes it; re-read once so that a
        // lock caught mid-write is not mistaken for a crashed one.
        await new Promise((resolve) => setTimeout(resolve, 25));
        existing = await readLock(root, flow);
      }
      if (!reclaimStale || !isStale(existing, host)) {
        throw lockedError(flow, existing, target);
      }
      // Stale: remove and retry once.
      await fsp.rm(target, { force: true });
    }
  }
  throw lockedError(flow, await readLock(root, flow), target);
}

function lockedError(flow: string, info: LockInfo | null, target: string): StoreError {
  const who =
    info === null
      ? 'another process'
      : `pid ${info.pid} on ${info.host} (started ${info.startedAt})`;
  return new StoreError('locked', `flow "${flow}" is already being run by ${who}`, {
    hint: `Wait for it to finish, or remove ${target} if you are certain it is stale.`,
  });
}

function makeHandle(target: string, info: LockInfo): LockHandle {
  let released = false;
  return {
    info,
    path: target,
    get released() {
      return released;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Only remove the lock if it is still ours: a reclaimer may already own it.
      const current = await readJsonOrNull<LockInfo>(target).catch(() => null);
      if (current === null) return;
      if (current.pid === info.pid && current.startedAt === info.startedAt) {
        await fsp.rm(target, { force: true });
      }
    },
  };
}

/** Run `fn` while holding the flow lock, releasing it even when `fn` throws. */
export async function withLock<T>(
  root: string,
  flow: string,
  fn: (handle: LockHandle) => Promise<T>,
  options: AcquireLockOptions = {},
): Promise<T> {
  const handle = await acquireLock(root, flow, options);
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}
