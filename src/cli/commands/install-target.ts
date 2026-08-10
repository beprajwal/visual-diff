/**
 * Where an install lands (harness-packaging spec §3 D16, §5).
 *
 * One decision lives here, and it belongs to the CLI rather than to an adapter: a harness knows
 * the directory names it reads, but only the invocation says whether this means "beside this
 * project" or "for this user".
 *
 * - project-local is the default, rooted at the invocation directory;
 * - `--global` selects the user-level layout, rooted at the home directory;
 * - `--dir` overrides the *root* and leaves the layout alone, so `--global --dir /tmp/x` writes a
 *   user-level install somewhere inspectable — which is what makes the global path testable at all
 *   without writing into the machine running the suite.
 *
 * `--dir` overrides the root of *every* scope, which is what makes it usable with the two commands
 * that report on all scopes at once. `vdiff install <harness> --dir <tmp>` followed by
 * `vdiff install --check --dir <tmp>` has to look in the directory that was written; reporting the
 * real cwd and home there would say "not installed" about files that exist, which is the one answer
 * a drift check must never give.
 *
 * Every path an adapter produces is relative (`.claude/skills/…`, `AGENTS.md`), which is exactly
 * what lets one writer serve both scopes: a global install is the same relative paths under a
 * different root.
 *
 * Pure. Nothing here reads or writes a file.
 */

import { isAbsolute, resolve } from 'node:path';

import type { InstallScope } from '../../adapters/index.js';

/** Both scopes, project first. `--list` and `--check` walk this order. */
export const SCOPES: readonly InstallScope[] = ['project', 'global'];

export interface InstallTarget {
  /** Which target layout the adapter composes for. */
  scope: InstallScope;
  /** Absolute directory every composed path is relative to. */
  root: string;
}

/**
 * The absolute root a scope resolves to.
 *
 * `home` is passed in — it reaches the command as `CommandContext.home` — rather than read from
 * `os.homedir()` at the point of use, so that a test naming a global target names its own
 * directory and cannot install into the machine running it.
 *
 * A `dir` overrides the answer for every scope: it names a directory outright, and the standard
 * project and global roots have nothing to say about a directory the user named.
 */
export function scopeRoot(scope: InstallScope, cwd: string, home: string, dir?: string): string {
  if (dir !== undefined) return resolveDir(dir, cwd);
  return scope === 'global' ? resolve(home) : resolve(cwd);
}

/** Resolve `--global` and `--dir` against the invocation directory. */
export function resolveTarget(
  invocation: { dir?: string; global?: true },
  cwd: string,
  home: string,
): InstallTarget {
  const scope: InstallScope = invocation.global === true ? 'global' : 'project';
  if (invocation.dir === undefined) return { scope, root: scopeRoot(scope, cwd, home) };
  return { scope, root: resolveDir(invocation.dir, cwd) };
}

/** `--dir` is taken as given when absolute and resolved against the invocation directory when not. */
function resolveDir(dir: string, cwd: string): string {
  return isAbsolute(dir) ? resolve(dir) : resolve(cwd, dir);
}
