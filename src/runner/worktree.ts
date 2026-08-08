/**
 * Detached worktrees for the slow path (spec §7) under the non-negotiable safety rule of §10:
 * worktrees are created detached under `cache/worktrees/<sha>` and the tool never touches the
 * user's working tree, index, stashes or HEAD.
 *
 * Every path is asserted to live inside the cache directory before anything is created or deleted,
 * so a crafted sha can never make the runner remove something outside `.visual-diff/cache`.
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { RunnerError } from './errors.js';
import { git } from './git.js';

export interface Worktree {
  /** Absolute path of the detached checkout. */
  path: string;
  sha: string;
  remove(): Promise<void>;
}

export function assertInside(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new RunnerError({
      code: 'unsafe-path',
      message: `refusing to operate on '${child}': outside '${parent}'`,
      kind: 'internal',
    });
  }
}

export function worktreePathFor(worktreesDir: string, sha: string): string {
  if (!/^[0-9a-zA-Z._-]+$/.test(sha)) {
    throw new RunnerError({
      code: 'unsafe-path',
      message: `refusing to build a worktree path for '${sha}'`,
      kind: 'internal',
    });
  }
  return resolve(worktreesDir, sha);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Paths git currently has registered as worktrees of this repository. */
export async function listWorktrees(repoRoot: string): Promise<string[]> {
  const result = await git(repoRoot, ['worktree', 'list', '--porcelain'], { allowFailure: true });
  if (result.code !== 0) return [];
  const paths: string[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim());
  }
  // The first entry is the main working tree; it is never ours to touch.
  return paths.slice(1);
}

/** Unregister and delete one worktree. Safe to call on a directory git no longer knows about. */
export async function removeWorktreeAt(repoRoot: string, worktreesDir: string, path: string): Promise<void> {
  assertInside(worktreesDir, path);
  await git(repoRoot, ['worktree', 'remove', '--force', path], { allowFailure: true });
  if (await exists(path)) await rm(path, { recursive: true, force: true });
  await git(repoRoot, ['worktree', 'prune'], { allowFailure: true });
}

/**
 * Delete every worktree under the cache directory, registered or not. Called at the start of the
 * slow path so orphans left by a crash mid-run are reaped (spec §10).
 */
export async function reapWorktrees(repoRoot: string, worktreesDir: string): Promise<string[]> {
  const removed: string[] = [];
  const registered = await listWorktrees(repoRoot);
  for (const path of registered) {
    const rel = relative(resolve(worktreesDir), resolve(path));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    await removeWorktreeAt(repoRoot, worktreesDir, path);
    removed.push(resolve(path));
  }
  if (await exists(worktreesDir)) {
    for (const entry of await readdir(worktreesDir)) {
      const path = resolve(worktreesDir, entry);
      await removeWorktreeAt(repoRoot, worktreesDir, path);
      if (!removed.includes(path)) removed.push(path);
    }
  }
  await git(repoRoot, ['worktree', 'prune'], { allowFailure: true });
  return removed;
}

export interface AddWorktreeOptions {
  repoRoot: string;
  sha: string;
  worktreesDir: string;
}

export async function addWorktree(options: AddWorktreeOptions): Promise<Worktree> {
  const { repoRoot, sha, worktreesDir } = options;
  const path = worktreePathFor(worktreesDir, sha);
  await mkdir(worktreesDir, { recursive: true });
  await git(repoRoot, ['worktree', 'prune'], { allowFailure: true });
  if (await exists(path)) await removeWorktreeAt(repoRoot, worktreesDir, path);

  const result = await git(repoRoot, ['worktree', 'add', '--detach', path, sha], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    throw new RunnerError({
      code: 'worktree-failed',
      message: `could not materialize a detached worktree for ${sha}: ${result.stderr.trim()}`,
      kind: 'internal',
    });
  }

  return {
    path,
    sha,
    remove: () => removeWorktreeAt(repoRoot, worktreesDir, path),
  };
}

/** Add a worktree, run `fn`, and tear the worktree down even when `fn` throws. */
export async function withWorktree<T>(
  options: AddWorktreeOptions,
  fn: (worktree: Worktree) => Promise<T>,
): Promise<T> {
  const worktree = await addWorktree(options);
  try {
    return await fn(worktree);
  } finally {
    await worktree.remove();
  }
}
