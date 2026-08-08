/**
 * store/revision — read-only git queries backing `RunMeta.revision` (spec §6).
 *
 * `dirtyHash` is the load-bearing field: without it, ten consecutive WIP runs are all
 * "9f8e7d6 dirty" and indistinguishable, which destroys the ability to tell iteration 3 from
 * iteration 4 — the core use case. It hashes `git diff HEAD` plus the untracked file list.
 *
 * **Non-negotiable (spec §10):** nothing here may touch the user's working tree, index, stashes or
 * HEAD. Every invocation goes through `git()`, which refuses any subcommand outside
 * `READ_ONLY_SUBCOMMANDS`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { StoreError, errnoCode } from './errors.js';
import { sha256 } from './internal/hash.js';
import type { Revision, Sha256 } from '../types.js';

const execFileAsync = promisify(execFile);

/** Allowlist. A mutating subcommand cannot reach `git` even by accident. */
export const READ_ONLY_SUBCOMMANDS = new Set([
  'rev-parse',
  'symbolic-ref',
  'status',
  'diff',
  'ls-files',
  'show',
  'cat-file',
  'log',
  'rev-list',
  'describe',
]);

const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a read-only git command. Non-zero exit is returned, not thrown, so callers can branch. */
export async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  const sub = args[0];
  if (sub === undefined || !READ_ONLY_SUBCOMMANDS.has(sub)) {
    throw new StoreError(
      'git-not-allowed',
      `refusing to run "git ${String(sub)}": only read-only subcommands are permitted`,
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync('git', [...args], {
      cwd,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      throw new StoreError('git-missing', 'git is not installed or not on PATH');
    }
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    const code = typeof e.code === 'number' ? e.code : 1;
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code };
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.code === 0 && result.stdout.trim() === 'true';
}

/** Absolute path of the repository root, or null when `cwd` is not inside a repository. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--show-toplevel']);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function headSha(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Branch name, or null when HEAD is detached. */
export async function headRef(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (result.code !== 0) return null;
  const ref = result.stdout.trim();
  return ref === '' ? null : ref;
}

export async function statusPorcelain(cwd: string): Promise<string> {
  const result = await git(cwd, ['status', '--porcelain']);
  if (result.code !== 0) {
    throw new StoreError('git-failed', `git status failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await statusPorcelain(cwd)).trim() !== '';
}

/** Untracked paths, honouring .gitignore, sorted so the hash does not depend on listing order. */
export async function untrackedFiles(cwd: string): Promise<string[]> {
  const result = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (result.code !== 0) {
    throw new StoreError('git-failed', `git ls-files failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split('\0')
    .filter((entry) => entry !== '')
    .sort();
}

/**
 * sha256 of `git diff HEAD` plus the untracked file list (spec §6). Tracked edits move the hash
 * through the diff text; a new untracked file moves it through the list.
 */
export async function computeDirtyHash(cwd: string): Promise<Sha256> {
  const diff = await git(cwd, ['diff', 'HEAD']);
  if (diff.code !== 0) {
    throw new StoreError('git-failed', `git diff HEAD failed: ${diff.stderr.trim()}`);
  }
  const untracked = await untrackedFiles(cwd);
  return sha256(`${diff.stdout}\n--untracked--\n${untracked.join('\n')}\n`);
}

/** Read `RunMeta.revision` for the working tree at `cwd`. */
export async function readRevision(cwd: string): Promise<Revision> {
  if (!(await isGitRepo(cwd))) {
    throw new StoreError('not-a-git-repo', `${cwd} is not inside a git repository`, {
      hint: 'visual-diff anchors every run to a revision (spec D3); initialise a repository first.',
    });
  }
  const sha = await headSha(cwd);
  if (sha === null) {
    throw new StoreError('git-no-head', `${cwd} has no commits yet, so there is no HEAD to anchor to`, {
      hint: 'Make an initial commit, then run again.',
    });
  }
  const ref = await headRef(cwd);
  const dirty = await isDirty(cwd);
  const revision: Revision = { sha, ref, dirty };
  if (dirty) revision.dirtyHash = await computeDirtyHash(cwd);
  return revision;
}

/** Resolve any ref (branch, tag, short sha) to a full sha, or null when it does not exist. */
export async function resolveRef(cwd: string, ref: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  return result.code === 0 && sha !== '' ? sha : null;
}

/**
 * `git show <ref>:<path>`. Returns null when the file does not exist at that revision, which is
 * what lets the runner reject "flow did not exist at <sha>" cleanly instead of producing an empty
 * run (spec §10).
 */
export async function showFileAtRef(
  cwd: string,
  ref: string,
  repoRelativePath: string,
): Promise<string | null> {
  const result = await git(cwd, ['show', `${ref}:${repoRelativePath}`]);
  return result.code === 0 ? result.stdout : null;
}

/**
 * Snapshot of everything a replay must leave untouched (spec §10 / §11.8). Compared before and
 * after a historical replay by the working-tree safety test.
 */
export interface WorkingTreeState {
  head: string;
  status: string;
  stash: string;
  index: string;
}

export async function readWorkingTreeState(cwd: string): Promise<WorkingTreeState> {
  const [head, status, stash, index] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['rev-list', '--walk-reflogs', '--format=%H', 'refs/stash']),
    git(cwd, ['diff', '--cached', '--binary']),
  ]);
  return {
    head: head.stdout,
    status: status.stdout,
    stash: stash.code === 0 ? stash.stdout : '',
    index: index.stdout,
  };
}
