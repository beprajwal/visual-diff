/**
 * Working-tree safety (spec §10, §11.8).
 *
 * "A visual diff tool that can lose uncommitted work is worse than no tool. This is enforced by a
 * test asserting `git status --porcelain` is byte-identical before and after every historical
 * replay." This file owns that assertion for the git-touching half of the runner: worktree
 * materialization, the replay body running inside the worktree, and teardown — including the case
 * where the replay throws.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addWorktree, assertInside, reapWorktrees, withWorktree, worktreePathFor } from './worktree.js';

function rawGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  });
}

interface TreeSnapshot {
  porcelain: string;
  head: string;
  stashes: string;
  indexHash: string;
  fileContents: string;
}

function snapshot(repo: string): TreeSnapshot {
  return {
    porcelain: rawGit(repo, ['status', '--porcelain']),
    head: rawGit(repo, ['rev-parse', 'HEAD']),
    stashes: rawGit(repo, ['stash', 'list']),
    indexHash: createHash('sha256').update(readFileSync(join(repo, '.git', 'index'))).digest('hex'),
    fileContents: readFileSync(join(repo, 'app.txt'), 'utf8') + readFileSync(join(repo, 'wip.txt'), 'utf8'),
  };
}

describe('worktree safety', () => {
  let repo: string;
  let cache: string;
  let worktreesDir: string;
  let oldSha: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vdiff-wt-repo-'));
    rawGit(repo, ['init', '--initial-branch=main']);
    rawGit(repo, ['config', 'user.email', 'test@example.com']);
    rawGit(repo, ['config', 'user.name', 'vdiff test']);
    rawGit(repo, ['config', 'commit.gpgsign', 'false']);

    writeFileSync(join(repo, 'app.txt'), 'v1\n');
    mkdirSync(join(repo, '.visual-diff', 'flows'), { recursive: true });
    writeFileSync(join(repo, '.visual-diff', 'flows', 'checkout.yaml'), 'version: 1\nflow: checkout\n');
    // The §6 git boundary: only config.yaml and flows/ are committed, so the cache never shows up
    // in `git status --porcelain`.
    writeFileSync(
      join(repo, '.gitignore'),
      '.visual-diff/*\n!.visual-diff/config.yaml\n!.visual-diff/flows/\n',
    );
    rawGit(repo, ['add', '.']);
    rawGit(repo, ['commit', '-m', 'v1']);
    oldSha = rawGit(repo, ['rev-parse', 'HEAD']).trim();

    writeFileSync(join(repo, 'app.txt'), 'v2\n');
    rawGit(repo, ['commit', '-am', 'v2']);

    // A stash entry, a tracked modification and an untracked file: everything §10 forbids losing.
    writeFileSync(join(repo, 'app.txt'), 'stashed\n');
    rawGit(repo, ['stash', 'push', '-m', 'precious']);
    writeFileSync(join(repo, 'app.txt'), 'dirty local edit\n');
    writeFileSync(join(repo, 'wip.txt'), 'untracked work\n');

    cache = join(repo, '.visual-diff', 'cache');
    worktreesDir = join(cache, 'worktrees');
  });

  afterEach(() => {
    // Retried: git may still be flushing pack/index files when the test ends.
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* a leftover temp directory is not a test failure */
    }
  });

  it('leaves status, HEAD, stashes and the index byte-identical across a historical replay', async () => {
    const before = snapshot(repo);
    expect(before.porcelain).not.toBe('');
    expect(before.stashes).toContain('precious');

    const seen = await withWorktree({ repoRoot: repo, sha: oldSha, worktreesDir }, async (worktree) => {
      // Stand in for the replay: read the revision's flow spec, then write build output into the
      // worktree exactly as an install and a dev server would.
      const flow = readFileSync(join(worktree.path, '.visual-diff', 'flows', 'checkout.yaml'), 'utf8');
      writeFileSync(join(worktree.path, 'build-output.txt'), 'artifact\n');
      mkdirSync(join(worktree.path, 'node_modules'), { recursive: true });
      return { flow, app: readFileSync(join(worktree.path, 'app.txt'), 'utf8') };
    });

    expect(seen.app).toBe('v1\n');
    expect(seen.flow).toContain('flow: checkout');

    const after = snapshot(repo);
    expect(after.porcelain).toBe(before.porcelain);
    expect(after.head).toBe(before.head);
    expect(after.stashes).toBe(before.stashes);
    expect(after.indexHash).toBe(before.indexHash);
    expect(after.fileContents).toBe(before.fileContents);
    expect(readdirSync(worktreesDir)).toEqual([]);
  });

  it('tears the worktree down and preserves the tree when the replay throws mid-step', async () => {
    const before = snapshot(repo);

    await expect(
      withWorktree({ repoRoot: repo, sha: oldSha, worktreesDir }, async () => {
        throw new Error('step pay-click failed');
      }),
    ).rejects.toThrow('step pay-click failed');

    const after = snapshot(repo);
    expect(after.porcelain).toBe(before.porcelain);
    expect(after.head).toBe(before.head);
    expect(after.stashes).toBe(before.stashes);
    expect(after.indexHash).toBe(before.indexHash);
    expect(readdirSync(worktreesDir)).toEqual([]);
  });

  it('checks out the requested revision detached, never moving the user HEAD', async () => {
    const worktree = await addWorktree({ repoRoot: repo, sha: oldSha, worktreesDir });
    expect(rawGit(worktree.path, ['rev-parse', 'HEAD']).trim()).toBe(oldSha);
    // A detached HEAD has no symbolic ref, which is what `--detach` bought us.
    expect(() => rawGit(worktree.path, ['symbolic-ref', '--short', 'HEAD'])).toThrow();
    expect(rawGit(repo, ['rev-parse', 'HEAD']).trim()).not.toBe(oldSha);
    expect(rawGit(repo, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('main');
    await worktree.remove();
    expect(existsSync(worktree.path)).toBe(false);
  });

  it('reaps orphan worktrees left behind by a crash', async () => {
    const worktree = await addWorktree({ repoRoot: repo, sha: oldSha, worktreesDir });
    expect(existsSync(worktree.path)).toBe(true);

    // A crash leaves the checkout on disk and registered with git.
    const removed = await reapWorktrees(repo, worktreesDir);
    expect(removed).toContain(worktree.path);
    expect(readdirSync(worktreesDir)).toEqual([]);
    expect(rawGit(repo, ['worktree', 'list', '--porcelain'])).not.toContain(worktreesDir);
  });

  it('reaps a directory git no longer knows about', async () => {
    mkdirSync(join(worktreesDir, 'deadbeef'), { recursive: true });
    writeFileSync(join(worktreesDir, 'deadbeef', 'stale.txt'), 'x');
    await reapWorktrees(repo, worktreesDir);
    expect(readdirSync(worktreesDir)).toEqual([]);
  });

  it('refuses paths outside the cache directory', () => {
    expect(() => assertInside('/a/b', '/a/c')).toThrow(/outside/);
    expect(() => assertInside('/a/b', '/a/b')).toThrow(/outside/);
    expect(() => assertInside('/a/b', '/a/b/c')).not.toThrow();
    expect(() => worktreePathFor('/cache/worktrees', '../../etc')).toThrow(/refusing/);
    expect(() => worktreePathFor('/cache/worktrees', 'deadbeef')).not.toThrow();
  });
});
