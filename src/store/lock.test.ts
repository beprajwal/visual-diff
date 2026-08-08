import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StoreError } from './errors.js';
import { acquireLock, isProcessAlive, readLock, withLock } from './lock.js';
import { lockFile } from './paths.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-lock-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** A pid that is certainly not running: exceeds every platform's pid_max. */
const DEAD_PID = 4_194_303;

describe('acquireLock', () => {
  it('writes the documented LockInfo', async () => {
    const handle = await acquireLock(tmp, 'checkout', { now: new Date('2026-08-08T10:00:00Z') });
    expect(handle.path).toBe(lockFile(tmp, 'checkout'));
    expect(await readLock(tmp, 'checkout')).toEqual({
      flow: 'checkout',
      pid: process.pid,
      host: os.hostname(),
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    await handle.release();
  });

  it('refuses a second acquire while the first holder is alive', async () => {
    const first = await acquireLock(tmp, 'checkout');
    await expect(acquireLock(tmp, 'checkout')).rejects.toThrow(StoreError);
    await expect(acquireLock(tmp, 'checkout')).rejects.toThrow(/already being run/);
    await first.release();
    // Released: the next acquire succeeds.
    const second = await acquireLock(tmp, 'checkout');
    await second.release();
  });

  it('locks per flow, not globally', async () => {
    const checkout = await acquireLock(tmp, 'checkout');
    const search = await acquireLock(tmp, 'search');
    expect(search.info.flow).toBe('search');
    await checkout.release();
    await search.release();
  });

  it('reclaims a lock whose pid is dead on this host', async () => {
    await acquireLock(tmp, 'checkout', { pid: DEAD_PID });
    const handle = await acquireLock(tmp, 'checkout');
    expect(handle.info.pid).toBe(process.pid);
    await handle.release();
  });

  it('never steals a lock written by another host, where a pid means nothing', async () => {
    await acquireLock(tmp, 'checkout', { pid: DEAD_PID, host: 'some-other-machine' });
    await expect(acquireLock(tmp, 'checkout')).rejects.toThrow(/some-other-machine/);
  });

  it('reclaims an unreadable lock', async () => {
    await fsp.mkdir(path.dirname(lockFile(tmp, 'checkout')), { recursive: true });
    await fsp.writeFile(lockFile(tmp, 'checkout'), 'not json at all');
    const handle = await acquireLock(tmp, 'checkout');
    expect(handle.info.pid).toBe(process.pid);
    await handle.release();
  });

  it('honours reclaimStale: false', async () => {
    await acquireLock(tmp, 'checkout', { pid: DEAD_PID });
    await expect(acquireLock(tmp, 'checkout', { reclaimStale: false })).rejects.toThrow(
      StoreError,
    );
  });

  it('carries a hint naming the lock file', async () => {
    await acquireLock(tmp, 'checkout');
    await expect(acquireLock(tmp, 'checkout')).rejects.toMatchObject({
      code: 'locked',
      hint: expect.stringContaining(lockFile(tmp, 'checkout')),
    });
  });
});

describe('release', () => {
  it('removes the lock file and is idempotent', async () => {
    const handle = await acquireLock(tmp, 'checkout');
    await handle.release();
    expect(await readLock(tmp, 'checkout')).toBeNull();
    await handle.release();
    expect(handle.released).toBe(true);
  });

  it('does not delete a lock that was reclaimed by someone else', async () => {
    const stale = await acquireLock(tmp, 'checkout', { pid: DEAD_PID });
    const reclaimed = await acquireLock(tmp, 'checkout');
    await stale.release();
    // The reclaimer still owns it.
    expect((await readLock(tmp, 'checkout'))?.pid).toBe(process.pid);
    await reclaimed.release();
  });
});

describe('withLock', () => {
  it('releases even when the body throws', async () => {
    await expect(
      withLock(tmp, 'checkout', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await readLock(tmp, 'checkout')).toBeNull();
  });

  it('returns the body result', async () => {
    expect(await withLock(tmp, 'checkout', async () => 42)).toBe(42);
  });
});

describe('isProcessAlive', () => {
  it('sees this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('rejects impossible pids', () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
