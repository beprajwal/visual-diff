import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkGitCommand,
  currentRef,
  dirtyHash,
  FORBIDDEN_SUBCOMMANDS,
  git,
  isAllowedGitCommand,
  porcelainStatus,
  readGitState,
  resolveRef,
  sameGitState,
  showFileAtRev,
  toRevision,
} from './git.js';

/** Test-only raw git, deliberately *not* routed through the allowlisted wrapper. */
function rawGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

describe('git command allowlist', () => {
  it('permits the read-only commands the runner needs', () => {
    for (const args of [
      ['rev-parse', '--show-toplevel'],
      ['status', '--porcelain'],
      ['diff', 'HEAD'],
      ['ls-files', '--others', '--exclude-standard'],
      ['show', 'abc123:.visual-diff/flows/checkout.yaml'],
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      ['stash', 'list'],
      ['worktree', 'list', '--porcelain'],
      ['worktree', 'prune'],
      ['worktree', 'add', '--detach', '/tmp/wt', 'abc123'],
      ['worktree', 'remove', '--force', '/tmp/wt'],
    ]) {
      expect(isAllowedGitCommand(args), args.join(' ')).toBe(true);
    }
  });

  it('refuses every command that can touch the working tree, index, HEAD or stash', () => {
    for (const sub of FORBIDDEN_SUBCOMMANDS) {
      expect(isAllowedGitCommand([sub]), sub).toBe(false);
    }
    expect(isAllowedGitCommand(['stash'])).toBe(false);
    expect(isAllowedGitCommand(['stash', 'push'])).toBe(false);
    expect(isAllowedGitCommand(['stash', 'pop'])).toBe(false);
    expect(isAllowedGitCommand(['worktree', 'add', '/tmp/wt', 'abc123'])).toBe(false);
    expect(isAllowedGitCommand(['worktree', 'lock', '/tmp/wt'])).toBe(false);
    expect(isAllowedGitCommand(['symbolic-ref', 'HEAD', 'refs/heads/other'])).toBe(false);
    expect(isAllowedGitCommand(['symbolic-ref', '--delete', 'HEAD'])).toBe(false);
    expect(isAllowedGitCommand(['diff', '--output=/tmp/x.patch'])).toBe(false);
    expect(isAllowedGitCommand(['-C', '/somewhere', 'checkout', 'main'])).toBe(false);
    expect(isAllowedGitCommand(['-c', 'core.hooksPath=/tmp', 'status'])).toBe(false);
    expect(isAllowedGitCommand([])).toBe(false);
  });

  it('explains why a command was refused', () => {
    expect(checkGitCommand(['checkout', 'main']).reason).toMatch(/allowlist/);
    expect(checkGitCommand(['worktree', 'add', '/tmp/wt']).reason).toMatch(/--detach/);
  });

  it('rejects a forbidden command at call time instead of spawning it', async () => {
    await expect(git(process.cwd(), ['reset', '--hard'])).rejects.toThrow(/refusing to run/);
  });
});

describe('git state reading', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vdiff-git-'));
    rawGit(dir, ['init', '--initial-branch=main']);
    rawGit(dir, ['config', 'user.email', 'test@example.com']);
    rawGit(dir, ['config', 'user.name', 'vdiff test']);
    rawGit(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'app.txt'), 'one\n');
    writeFileSync(join(dir, '.visual-diff-flow.yaml'), 'flow: checkout\n');
    rawGit(dir, ['add', '.']);
    rawGit(dir, ['commit', '-m', 'first']);
  });

  afterAll(() => {
    // Retried: git may still be flushing pack/index files when the last test ends.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* a leftover temp directory is not a test failure */
    }
  });

  it('reads sha, ref and a clean status', async () => {
    const state = await readGitState(dir);
    expect(state.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(state.ref).toBe('main');
    expect(state.dirty).toBe(false);
    expect(state.dirtyHash).toBeUndefined();
    expect(await currentRef(dir)).toBe('main');
    expect(await porcelainStatus(dir)).toBe('');
  });

  it('produces a different dirtyHash for different working-tree content', async () => {
    writeFileSync(join(dir, 'app.txt'), 'two\n');
    const first = await dirtyHash(dir);
    writeFileSync(join(dir, 'app.txt'), 'three\n');
    const second = await dirtyHash(dir);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second).not.toBe(first);

    writeFileSync(join(dir, 'app.txt'), 'two\n');
    expect(await dirtyHash(dir)).toBe(first);
  });

  it('folds untracked files into the dirtyHash', async () => {
    const before = await dirtyHash(dir);
    writeFileSync(join(dir, 'scratch.txt'), 'wip\n');
    const after = await dirtyHash(dir);
    expect(after).not.toBe(before);
    rmSync(join(dir, 'scratch.txt'));
    expect(await dirtyHash(dir)).toBe(before);
  });

  it('reports dirty state and carries the hash into the Revision', async () => {
    const state = await readGitState(dir);
    expect(state.dirty).toBe(true);
    expect(state.dirtyHash).toBeDefined();
    const revision = toRevision(state);
    expect(revision.sha).toBe(state.sha);
    expect(revision.ref).toBe('main');
    expect(revision.dirty).toBe(true);
    expect(revision.dirtyHash).toBe(state.dirtyHash);
  });

  it('compares two states for the run-start/run-end stability guard', async () => {
    const a = await readGitState(dir);
    const b = await readGitState(dir);
    expect(sameGitState(a, b)).toBe(true);
    expect(sameGitState(a, { ...b, sha: 'moved' })).toBe(false);
    expect(sameGitState(a, { ...b, porcelain: ' M other.txt\n' })).toBe(false);
    expect(sameGitState(null, null)).toBe(true);
    expect(sameGitState(a, null)).toBe(false);
  });

  it('reads a file out of history and reports absence as null', async () => {
    const sha = (await readGitState(dir)).sha as string;
    expect(await showFileAtRev(dir, sha, '.visual-diff-flow.yaml')).toBe('flow: checkout\n');
    expect(await showFileAtRev(dir, sha, '.visual-diff/flows/nope.yaml')).toBeNull();
  });

  it('rejects an unknown ref with a config-level exit code', async () => {
    await expect(resolveRef(dir, 'no-such-ref')).rejects.toMatchObject({
      code: 'unknown-ref',
      exitCode: 2,
    });
    await expect(resolveRef(dir, 'HEAD')).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it('leaves the working tree byte-identical after every read', async () => {
    const before = rawGit(dir, ['status', '--porcelain']);
    const headBefore = rawGit(dir, ['rev-parse', 'HEAD']);
    await readGitState(dir);
    await dirtyHash(dir);
    await showFileAtRev(dir, headBefore.trim(), 'app.txt');
    expect(rawGit(dir, ['status', '--porcelain'])).toBe(before);
    expect(rawGit(dir, ['rev-parse', 'HEAD'])).toBe(headBefore);
  });
});
