/**
 * `vdiff install --check [<harness>]` — drift detection (harness-packaging spec §3 D16/D17, §5).
 *
 * An installed skill is a copy of prose that documents specific commands and flags, and a copy
 * that has drifted from the CLI is worse than no copy at all. This command answers one question —
 * "is what is on disk what this build would write?" — for every harness and both scopes, and then
 * stops. It never rewrites anything: auto-refreshing a committed directory is what D17 rejected,
 * and doing it under a flag named `--check` would be worse.
 *
 * Three consequences that look like bugs otherwise:
 *
 *  - **Exit 0 always.** Drift is information, exactly as `vdiff diff` exits 0 with findings. A
 *    non-zero exit here would turn "your skills are a version behind" into a broken pipeline.
 *  - **Both scopes are always reported**, installed or not. A copy in the other scope is precisely
 *    the file a user forgets exists, and which of the two a harness actually reads varies per
 *    harness — so the report states the duplication and lets each harness's own note say what it
 *    means (D16, corrected by the registry's `HARNESS_NOTES`).
 *  - **A malformed `AGENTS.md` block is reported, not thrown.** `--check` promises an exit code;
 *    the adapter's refusal to guess where the block ends arrives here as an `unreadable` scope
 *    carrying that message verbatim.
 *
 * The four statuses come out of a dry-run install, so they cannot disagree with what a real
 * install would do: `created` means missing, `unchanged` means current, `updated` means "ours, and
 * different" — stale — and `preserved` means a human edited it. The version *names* in a stale
 * report are read back off the installed file through the adapter, which knows both places a
 * stamp can live: frontmatter, and the `AGENTS.md` block comment.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EXIT } from '../../types.js';
import type { FileStatus, InstallScope, ManagedFile } from '../../adapters/index.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { HarnessInfo } from '../ports.js';
import type {
  InstallCheckData,
  InstallCheckFile,
  InstallCheckHarness,
  InstallCheckScope,
  InstallDriftStatus,
  InstallScopeStatus,
} from '../shapes.js';
import { SCOPES, scopeRoot } from './install-target.js';

/** Dry-run outcome → drift status. One-to-one, which is why `--check` cannot lie about a rewrite. */
const DRIFT_OF: Record<FileStatus, InstallDriftStatus> = {
  created: 'missing',
  unchanged: 'current',
  updated: 'stale',
  preserved: 'modified-locally',
};

/** Worst case first: a scope reports the first of these that any of its files has. */
const SEVERITY: readonly InstallDriftStatus[] = ['modified-locally', 'stale', 'missing', 'current'];

const STATUS_LABEL: Record<InstallScopeStatus, string> = {
  current: 'current',
  stale: 'stale',
  missing: 'not installed',
  'modified-locally': 'modified locally',
  unreadable: 'unreadable',
};

export function statusLabel(status: InstallScopeStatus): string {
  return STATUS_LABEL[status];
}

/** The one line a command prints when it notices a drifted install. It fixes nothing (D17). */
export function driftNotice(label: string, scope: InstallScope, status: InstallScopeStatus): string {
  return (
    `the ${scope} install of ${label} is ${STATUS_LABEL[status]} — ` +
    'run `vdiff install --check` to see what differs'
  );
}

/**
 * Compare one harness's files, in one scope, against `root`.
 *
 * Never throws. A root that cannot be read, or an `AGENTS.md` whose markers the adapter refuses to
 * interpret, is reported as an `unreadable` scope: the command's contract is exit 0, and one bad
 * home directory must not take the project report down with it.
 */
export async function checkScope(
  ctx: CommandContext,
  harnessId: string,
  scope: InstallScope,
  root: string,
): Promise<InstallCheckScope> {
  try {
    const composed = await ctx.ports.adapterFiles(harnessId, scope);
    const modes = new Map(composed.map((file) => [file.path, file.mode ?? 'file'] as const));
    const report = await ctx.ports.installAdapter(harnessId, root, {
      scope,
      version: ctx.version,
      dryRun: true,
    });

    const files: InstallCheckFile[] = [];
    for (const outcome of report.files) {
      files.push(
        await classify(ctx, root, outcome.path, outcome.status, modes.get(outcome.path) ?? 'file'),
      );
    }

    return { scope, root, status: rollUp(files), duplicate: false, error: null, files };
  } catch (cause) {
    return {
      scope,
      root,
      status: 'unreadable',
      duplicate: false,
      error: cause instanceof Error ? cause.message : String(cause),
      files: [],
    };
  }
}

/**
 * One file's drift, and the version its installed copy claims.
 *
 * The `block` case is the one that needs care. A user's `AGENTS.md` that has never been touched by
 * this tool still *exists*, so a dry run reports `updated` — the block would be appended. That is
 * not drift, it is an absent install, and reporting it as stale would tell a user their file is
 * out of date when the tool has never written to it. An absent stamp is what distinguishes the
 * two, and it is exactly the thing a real install writes.
 */
async function classify(
  ctx: CommandContext,
  root: string,
  path: string,
  status: FileStatus,
  mode: NonNullable<ManagedFile['mode']>,
): Promise<InstallCheckFile> {
  const drift = DRIFT_OF[status];
  if (drift === 'missing') return { path, status: 'missing', installedVersion: null };

  const content = await readIfPresent(join(root, path));
  const installedVersion =
    content === null ? null : await ctx.ports.readInstalledVersion(content);

  if (mode === 'block' && installedVersion === null) {
    return { path, status: 'missing', installedVersion: null };
  }

  // A stamp naming another version while the bytes match cannot happen for a file this build
  // wrote — the stamp is part of those bytes — but it can once a harness or a human has rewritten
  // the frontmatter around it. Believe the stamp: comparing it is what `--check` is for.
  const resolved: InstallDriftStatus =
    drift === 'current' && installedVersion !== null && installedVersion !== ctx.version
      ? 'stale'
      : drift;

  return { path, status: resolved, installedVersion };
}

/** True when this scope holds at least one file this tool has written. */
export function isInstalled(scope: InstallCheckScope): boolean {
  return scope.files.some((file) => file.status !== 'missing');
}

export async function checkHarness(
  ctx: CommandContext,
  harness: HarnessInfo,
  cwd: string,
  home: string,
  dir?: string,
): Promise<InstallCheckHarness> {
  const scopes: InstallCheckScope[] = [];
  for (const scope of SCOPES) {
    // Only the scopes this target has. Both, for every harness (D16); `project` alone for the
    // GitHub Actions target, because `.github/workflows` is per repository — and a row saying
    // "not installed" about a location that cannot exist is worse than no row (CI spec §7).
    if (!harness.scopes.includes(scope)) continue;
    scopes.push(await checkScope(ctx, harness.id, scope, scopeRoot(scope, cwd, home, dir)));
  }

  // Flagged on both entries, not just the global one: "there are two copies" is the fact, and
  // which of them the harness reads is what `notes` explains.
  //
  // Distinct roots are part of that fact. A `--dir` points every scope at one directory, and two
  // scope rows reading the same files off the same path is one install described twice — calling
  // that a duplicate would send a user looking for a second copy that does not exist.
  const roots = new Set(scopes.map((scope) => scope.root));
  if (scopes.length > 1 && roots.size === scopes.length && scopes.every(isInstalled)) {
    for (const scope of scopes) scope.duplicate = true;
  }

  return { id: harness.id, label: harness.label, scopes, notes: harness.notes };
}

export async function installCheck(
  ctx: CommandContext,
  harnesses: readonly HarnessInfo[],
  home: string,
  dir?: string,
): Promise<CommandResult<InstallCheckData>> {
  const rows: InstallCheckHarness[] = [];
  for (const harness of harnesses) {
    rows.push(await checkHarness(ctx, harness, ctx.cwd, home, dir));
  }

  const drift = rows.some((row) =>
    row.scopes.some((scope) => scope.status === 'stale' || scope.status === 'modified-locally'),
  );

  return {
    data: { version: ctx.version, harnesses: rows, drift },
    human: renderCheck(rows, ctx.version, drift),
    exitCode: EXIT.OK,
  };
}

function renderCheck(
  rows: readonly InstallCheckHarness[],
  version: string,
  drift: boolean,
): string[] {
  const human: string[] = [`installed files, compared against vdiff ${version}`, ''];

  for (const row of rows) {
    human.push(`${row.label} (${row.id})`);
    for (const scope of row.scopes) {
      human.push(`  ${scope.scope.padEnd(7)}  ${STATUS_LABEL[scope.status]}  ${scope.root}`);
      if (scope.error !== null) human.push(`    ${scope.error}`);
      for (const file of scope.files) {
        if (file.status === 'current') continue;
        human.push(
          `    ${STATUS_LABEL[file.status].padEnd(16)}  ${file.path}${versionNote(file, version)}`,
        );
      }
    }
    if (row.scopes.some((scope) => scope.duplicate)) {
      human.push('  installed in both scopes:');
      for (const note of row.notes) human.push(`    - ${note}`);
    }
    human.push('');
  }

  human.push(
    drift
      ? 'Refresh a harness with `vdiff install <harness>`; add --force to replace files edited locally.'
      : 'Nothing has drifted.',
  );
  human.push('Nothing was written: --check reports, it never rewrites (D17).');
  return human;
}

function versionNote(file: InstallCheckFile, version: string): string {
  if (file.status !== 'stale') return '';
  return `  (${file.installedVersion ?? 'unstamped'} → ${version})`;
}

function rollUp(files: readonly InstallCheckFile[]): InstallDriftStatus {
  if (files.length === 0) return 'missing';
  for (const candidate of SEVERITY) {
    if (files.some((file) => file.status === candidate)) return candidate;
  }
  return 'current';
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // The dry run has already classified this file; a read that fails now costs only the version
    // name in the report, which is a strictly better outcome than failing the whole check.
    return null;
  }
}
