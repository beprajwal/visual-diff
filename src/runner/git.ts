/**
 * Read-only git access, plus the two detached-worktree commands the slow path needs (spec §7, §10).
 *
 * **Non-negotiable (spec §10):** the tool never touches the user's working tree, index, stashes or
 * HEAD. That is enforced here by an allowlist: every git invocation in the runner goes through
 * `git()`, which refuses any subcommand outside `ALLOWED_SUBCOMMANDS` and any `worktree` operation
 * other than `add --detach` / `remove` / `list` / `prune`. `GIT_OPTIONAL_LOCKS=0` additionally stops
 * read commands such as `status` from refreshing (and therefore rewriting) `.git/index`.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

import { EXIT, type Revision, type Sha256 } from '../types.js';
import { RunnerError } from './errors.js';

/** Subcommands that cannot mutate the working tree, the index, HEAD or the stash. */
const ALLOWED_SUBCOMMANDS = new Set([
  'rev-parse',
  'rev-list',
  'symbolic-ref',
  'status',
  'diff',
  'ls-files',
  'ls-tree',
  'show',
  'cat-file',
  'log',
  'var',
  'stash',
  'worktree',
]);

/** `worktree` operations that are permitted. `add` additionally requires `--detach`. */
const ALLOWED_WORKTREE_OPS = new Set(['add', 'remove', 'list', 'prune']);

/** Named for the error message and for `git.test.ts` to iterate over. */
export const FORBIDDEN_SUBCOMMANDS: readonly string[] = [
  'add',
  'am',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'config',
  'fetch',
  'gc',
  'init',
  'merge',
  'mv',
  'notes',
  'pull',
  'push',
  'rebase',
  'reflog',
  'reset',
  'restore',
  'rm',
  'sparse-checkout',
  'submodule',
  'switch',
  'tag',
  'update-index',
  'update-ref',
];

export interface GitCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether an argv is safe. Global options before the subcommand (`-C`, `-c`) are refused
 * outright so the allowlist cannot be side-stepped by moving the real command behind a flag.
 */
export function checkGitCommand(args: readonly string[]): GitCheck {
  const sub = args[0];
  if (sub === undefined) return { allowed: false, reason: 'empty git invocation' };
  if (sub.startsWith('-')) {
    return { allowed: false, reason: `global git option '${sub}' is not allowed before a subcommand` };
  }
  if (!ALLOWED_SUBCOMMANDS.has(sub)) {
    return { allowed: false, reason: `git '${sub}' is not on the runner's read-only allowlist` };
  }
  const rest = args.slice(1);
  if (sub === 'stash') {
    if (rest[0] !== 'list') return { allowed: false, reason: "only 'git stash list' is allowed" };
  }
  if (sub === 'symbolic-ref') {
    if (rest.includes('-d') || rest.includes('--delete')) {
      return { allowed: false, reason: 'symbolic-ref may not delete a ref' };
    }
    const operands = rest.filter((arg) => !arg.startsWith('-'));
    if (operands.length > 1) {
      return { allowed: false, reason: 'symbolic-ref may not write a ref' };
    }
  }
  if (sub === 'diff' && rest.some((arg) => arg.startsWith('--output'))) {
    return { allowed: false, reason: 'git diff --output writes a file' };
  }
  if (sub === 'ls-files' && rest.some((arg) => arg === '-d' || arg === '--delete')) {
    return { allowed: false, reason: 'ls-files may not delete' };
  }
  if (sub === 'worktree') {
    const op = rest[0];
    if (op === undefined || !ALLOWED_WORKTREE_OPS.has(op)) {
      return { allowed: false, reason: `git worktree '${op ?? ''}' is not allowed` };
    }
    if (op === 'add' && !rest.includes('--detach')) {
      return { allowed: false, reason: 'git worktree add requires --detach' };
    }
  }
  return { allowed: true };
}

export function isAllowedGitCommand(args: readonly string[]): boolean {
  return checkGitCommand(args).allowed;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitOptions {
  /** Return a non-zero result instead of throwing. */
  allowFailure?: boolean;
  timeoutMs?: number;
}

const MAX_BUFFER = 128 * 1024 * 1024;

/** Every git call in the runner funnels through here, so the allowlist has no bypass. */
export function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const check = checkGitCommand(args);
  if (!check.allowed) {
    return Promise.reject(
      new RunnerError({
        code: 'git-command-forbidden',
        message: `refusing to run 'git ${args.join(' ')}': ${check.reason ?? 'not allowed'}`,
        kind: 'internal',
      }),
    );
  }

  return new Promise<GitResult>((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs ?? 120_000,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout);
        const err = typeof stderr === 'string' ? stderr : String(stderr);
        if (error) {
          const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
          if (options.allowFailure) {
            resolve({ stdout: out, stderr: err, code });
            return;
          }
          reject(
            new RunnerError({
              code: 'git-failed',
              message: `git ${args.join(' ')} failed: ${err.trim() || error.message}`,
              kind: 'internal',
              cause: error,
            }),
          );
          return;
        }
        resolve({ stdout: out, stderr: err, code: 0 });
      },
    );
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  return result.code === 0 && result.stdout.trim() === 'true';
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (result.code !== 0) return null;
  const root = result.stdout.trim();
  return root.length > 0 ? root : null;
}

/** Resolve any ref (branch, tag, sha, `HEAD~3`) to a full commit sha. */
export async function resolveRef(cwd: string, ref: string): Promise<string> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    allowFailure: true,
  });
  const sha = result.stdout.trim();
  if (result.code !== 0 || sha.length === 0) {
    throw new RunnerError({
      code: 'unknown-ref',
      message: `unknown git ref '${ref}'`,
      exitCode: EXIT.CONFIG_ERROR,
      kind: 'flow-missing',
      hint: 'pass a ref that exists in this repository, e.g. a branch name or a commit sha',
    });
  }
  return sha;
}

export async function headSha(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
  const sha = result.stdout.trim();
  return result.code === 0 && sha.length > 0 ? sha : null;
}

/** Current branch name, or null when HEAD is detached. */
export async function currentRef(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
  const ref = result.stdout.trim();
  return result.code === 0 && ref.length > 0 ? ref : null;
}

export async function porcelainStatus(cwd: string): Promise<string> {
  const result = await git(cwd, ['status', '--porcelain'], { allowFailure: true });
  return result.stdout;
}

/**
 * `dirtyHash` hashes `git diff HEAD` plus the untracked file list (spec §6). Without it, ten
 * consecutive WIP runs are all "9f8e7d6 dirty" and indistinguishable, which destroys the ability to
 * tell iteration 3 from iteration 4.
 */
export async function dirtyHash(cwd: string): Promise<Sha256> {
  const head = await headSha(cwd);
  const diff = await git(cwd, head ? ['diff', 'HEAD'] : ['diff'], { allowFailure: true });
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard'], {
    allowFailure: true,
  });
  const files = untracked.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
  const hash = createHash('sha256');
  hash.update(diff.stdout, 'utf8');
  hash.update('\0untracked\0', 'utf8');
  hash.update(files.join('\n'), 'utf8');
  return `sha256:${hash.digest('hex')}`;
}

export interface GitState {
  sha: string | null;
  ref: string | null;
  dirty: boolean;
  dirtyHash?: Sha256;
  /** Raw `git status --porcelain`, compared verbatim by the run-start/run-end guard (spec §7). */
  porcelain: string;
}

/** Snapshot of everything the attach-mode stability guard compares. */
export async function readGitState(cwd: string): Promise<GitState> {
  const [sha, ref, porcelain] = await Promise.all([headSha(cwd), currentRef(cwd), porcelainStatus(cwd)]);
  const dirty = porcelain.trim().length > 0;
  const state: GitState = { sha, ref, dirty, porcelain };
  if (dirty) state.dirtyHash = await dirtyHash(cwd);
  return state;
}

/** Null when `cwd` is not inside a git work tree, so a non-git project still runs in attach mode. */
export async function readGitStateSafe(cwd: string): Promise<GitState | null> {
  if (!(await isGitRepo(cwd))) return null;
  return readGitState(cwd);
}

/** True when nothing the guard watches moved between run start and run end (spec §7). */
export function sameGitState(a: GitState | null, b: GitState | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.sha === b.sha &&
    a.ref === b.ref &&
    a.dirty === b.dirty &&
    a.porcelain === b.porcelain &&
    (a.dirtyHash ?? null) === (b.dirtyHash ?? null)
  );
}

export function toRevision(state: GitState | null, overrides: Partial<Revision> = {}): Revision {
  const revision: Revision = {
    sha: overrides.sha ?? state?.sha ?? '',
    ref: overrides.ref ?? state?.ref ?? null,
    dirty: overrides.dirty ?? state?.dirty ?? false,
  };
  const hash = overrides.dirtyHash ?? state?.dirtyHash;
  if (revision.dirty && hash !== undefined) revision.dirtyHash = hash;
  return revision;
}

/**
 * Read a file out of git history (D4: each revision replays with its contemporaneous flow spec).
 * Returns null when the path did not exist at that revision, which run.ts turns into the clean
 * "flow did not exist at <sha>" rejection required by §10 — never an empty run.
 */
export async function showFileAtRev(cwd: string, sha: string, path: string): Promise<string | null> {
  const result = await git(cwd, ['show', `${sha}:${path}`], { allowFailure: true });
  if (result.code !== 0) return null;
  return result.stdout;
}
