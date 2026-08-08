import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StoreError } from './errors.js';
import {
  computeDirtyHash,
  git,
  headRef,
  isGitRepo,
  readRevision,
  readWorkingTreeState,
  resolveRef,
  showFileAtRef,
  untrackedFiles,
} from './revision.js';

const execFileAsync = promisify(execFile);

const GIT_ENV = [
  '-c',
  'user.name=vdiff test',
  '-c',
  'user.email=vdiff@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

async function run(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', [...GIT_ENV, ...args], { cwd });
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

const hasGit = await gitAvailable();

describe('the read-only allowlist', () => {
  it('refuses any subcommand that could mutate the repository (spec §10)', async () => {
    for (const forbidden of ['commit', 'checkout', 'reset', 'stash', 'add', 'worktree', 'clean']) {
      await expect(git(process.cwd(), [forbidden])).rejects.toThrow(StoreError);
      await expect(git(process.cwd(), [forbidden])).rejects.toThrow(/read-only/);
    }
  });

  it('refuses an empty command', async () => {
    await expect(git(process.cwd(), [])).rejects.toThrow(StoreError);
  });
});

describe.skipIf(!hasGit)('revision reading', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-git-')));
    await run(repo, 'init', '--initial-branch=main');
    await fsp.writeFile(path.join(repo, 'app.js'), 'export const label = "Pay";\n');
    await fsp.mkdir(path.join(repo, '.visual-diff', 'flows'), { recursive: true });
    await fsp.writeFile(
      path.join(repo, '.visual-diff', 'flows', 'checkout.yaml'),
      'flow: checkout\nsteps:\n  - id: cart\n',
    );
    await run(repo, 'add', '.');
    await run(repo, 'commit', '-m', 'initial');
  });

  afterEach(async () => {
    // git leaves background work (index/pack writes) behind for a moment after the last command,
    // so a plain rm races it with ENOTEMPTY. Retry, and never fail a test on cleanup.
    await fsp
      .rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      .catch(() => undefined);
  });

  it('reads sha, branch and a clean tree', async () => {
    expect(await isGitRepo(repo)).toBe(true);
    const revision = await readRevision(repo);
    expect(revision.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(revision.ref).toBe('main');
    expect(revision.dirty).toBe(false);
    // A clean tree has no dirtyHash: there is nothing to distinguish.
    expect(revision.dirtyHash).toBeUndefined();
  });

  it('reports a detached HEAD as a null ref', async () => {
    const sha = (await readRevision(repo)).sha;
    await run(repo, 'checkout', '--detach', sha);
    expect(await headRef(repo)).toBeNull();
    expect((await readRevision(repo)).ref).toBeNull();
  });

  it('hashes tracked edits, so consecutive WIP runs are distinguishable', async () => {
    await fsp.writeFile(path.join(repo, 'app.js'), 'export const label = "Pay now";\n');
    const first = await readRevision(repo);
    expect(first.dirty).toBe(true);
    expect(first.dirtyHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    await fsp.writeFile(path.join(repo, 'app.js'), 'export const label = "Pay today";\n');
    const second = await readRevision(repo);

    // Same sha, same "dirty" flag — only dirtyHash tells iteration 3 from iteration 4 (spec §6).
    expect(second.sha).toBe(first.sha);
    expect(second.dirtyHash).not.toBe(first.dirtyHash);
  });

  it('hashes the untracked file list too', async () => {
    await fsp.writeFile(path.join(repo, 'app.js'), 'export const label = "Pay now";\n');
    const before = await computeDirtyHash(repo);
    await fsp.writeFile(path.join(repo, 'scratch.txt'), 'wip\n');
    const after = await computeDirtyHash(repo);
    expect(after).not.toBe(before);
    expect(await untrackedFiles(repo)).toEqual(['scratch.txt']);
  });

  it('is stable when nothing changed', async () => {
    await fsp.writeFile(path.join(repo, 'app.js'), 'export const label = "Pay now";\n');
    expect(await computeDirtyHash(repo)).toBe(await computeDirtyHash(repo));
  });

  it('honours .gitignore for untracked files', async () => {
    await fsp.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
    await fsp.writeFile(path.join(repo, 'ignored.txt'), 'noise\n');
    expect(await untrackedFiles(repo)).toEqual(['.gitignore']);
  });

  it('reads a flow spec out of history, and reports its absence cleanly', async () => {
    const sha = (await readRevision(repo)).sha;
    const source = await showFileAtRef(repo, sha, '.visual-diff/flows/checkout.yaml');
    expect(source).toContain('flow: checkout');
    // Spec §10: "flow did not exist at <sha>" is a clean rejection, not an empty run.
    expect(await showFileAtRef(repo, sha, '.visual-diff/flows/search.yaml')).toBeNull();
  });

  it('resolves refs and rejects unknown ones', async () => {
    expect(await resolveRef(repo, 'main')).toMatch(/^[0-9a-f]{40}$/);
    expect(await resolveRef(repo, 'no-such-ref')).toBeNull();
  });

  it('reading a revision never moves the working tree', async () => {
    await fsp.writeFile(path.join(repo, 'app.js'), 'dirty\n');
    await fsp.writeFile(path.join(repo, 'untracked.txt'), 'x\n');
    const before = await readWorkingTreeState(repo);

    await readRevision(repo);
    await computeDirtyHash(repo);
    await showFileAtRef(repo, 'HEAD', 'app.js');

    expect(await readWorkingTreeState(repo)).toEqual(before);
  });
});

describe.skipIf(!hasGit)('outside a repository', () => {
  it('reports plainly rather than guessing', async () => {
    const bare = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-nogit-'));
    try {
      // `git rev-parse` walks upward, so only assert the error when the temp dir really is outside
      // any repository.
      if (await isGitRepo(bare)) return;
      await expect(readRevision(bare)).rejects.toMatchObject({ code: 'not-a-git-repo' });
    } finally {
      await fsp.rm(bare, { recursive: true, force: true });
    }
  });
});
