/**
 * `vdiff install <harness> [--global] [--dir <path>] [--force] [--dry-run]`,
 * `vdiff install --list` and `vdiff install --check [<harness>]`
 * (harness-packaging spec §5, §6).
 *
 * The point of this command is that `npx @beprajwal/visual-diff install claude-code` works with
 * nothing installed beforehand: it drops the shipped `visual-diff` skills, the command files and
 * the `AGENTS.md` block into the places that harness reads, and that is the entire first step of
 * adopting the tool.
 *
 * There is no adapter logic here. Which files exist, where they land and what they contain are all
 * decisions of `src/adapters/`; this file resolves a scope to a root (D16), hands the adapter the
 * running version to stamp (D17), maps a refused write to exit 2, and renders the report. The
 * registry is also what the "unknown harness" message lists, so adding a harness needs no change
 * in this file.
 *
 * Output names the real directories rather than the harness id, because `vdiff install codex`
 * writing files into something not called "codex" is otherwise baffling (D18) — and a harness with
 * no skill mechanism says so rather than silently writing fewer files (D15).
 */

import { homedir } from 'node:os';

import { EXIT } from '../../types.js';
import type { HarnessTargets, InstallScope } from '../../adapters/index.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { Invocation } from '../args.js';
import { configError, isCliErrorLike } from '../error.js';
import type { HarnessInfo } from '../ports.js';
import type {
  InstallCheckData,
  InstallData,
  InstallListData,
  InstallListScope,
} from '../shapes.js';
import { checkScope, driftNotice, installCheck, isInstalled } from './install-check.js';
import { SCOPES, resolveTarget, scopeRoot } from './install-target.js';

type InstallInvocation = Extract<Invocation, { kind: 'install' }>;

/** `created`/`updated` are written; the other two explain why a path was left alone. */
const STATUS_LABEL: Record<string, string> = {
  created: 'created  ',
  updated: 'updated  ',
  unchanged: 'current  ',
  preserved: 'preserved',
};

/** Filesystem errors that mean "this path is not yours to write" rather than "the disk broke". */
const NOT_WRITABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOTDIR', 'EISDIR']);

/** The three kinds of target a harness may have, in install order. */
const TARGET_KINDS: ReadonlyArray<['skills' | 'commands' | 'instructions', string]> = [
  ['skills', 'skills'],
  ['commands', 'commands'],
  ['instructions', 'instructions'],
];

export async function install(
  ctx: CommandContext,
  invocation: InstallInvocation,
): Promise<CommandResult<InstallData | InstallListData | InstallCheckData>> {
  const harnesses = await ctx.ports.listAdapters();
  const home = homeOf(ctx);

  if (invocation.list === true) return listHarnesses(ctx, harnesses, home, invocation.dir);

  if (invocation.check === true) {
    const selected =
      invocation.harness === undefined ? harnesses : [requireHarness(harnesses, invocation.harness)];
    return installCheck(ctx, selected, home, invocation.dir);
  }

  return installHarness(ctx, invocation, harnesses, home);
}

/** The adapter for an id, or exit 2 listing the ones this build actually registers (§6). */
function requireHarness(harnesses: readonly HarnessInfo[], id: string | undefined): HarnessInfo {
  const match = harnesses.find((harness) => harness.id === id);
  if (match !== undefined) return match;
  const supported = harnesses.map((harness) => harness.id).join(', ');
  throw configError('unknown-harness', `unknown harness '${id ?? ''}'`, {
    hint: `supported harnesses: ${supported}`,
  });
}

async function installHarness(
  ctx: CommandContext,
  invocation: InstallInvocation,
  harnesses: readonly HarnessInfo[],
  home: string,
): Promise<CommandResult<InstallData>> {
  const match = requireHarness(harnesses, invocation.harness);
  const target = resolveTarget(invocation, ctx.cwd, home);
  const targets = await ctx.ports.adapterTargets(match.id, target.scope);

  let report;
  try {
    report = await ctx.ports.installAdapter(match.id, target.root, {
      scope: target.scope,
      version: ctx.version,
      force: invocation.force,
      dryRun: invocation.dryRun,
    });
  } catch (cause) {
    throw writeFailure(match.label, target.root, cause);
  }

  const human: string[] = [];
  human.push(
    invocation.dryRun
      ? `dry run — nothing written (${match.label}, ${target.scope}: ${target.root})`
      : `${match.label} → ${target.root} (${target.scope})`,
  );
  for (const line of targetLines(match.label, targets)) human.push(line);
  human.push('');

  for (const file of report.files) {
    human.push(`  ${STATUS_LABEL[file.status] ?? file.status}  ${file.path}`);
  }

  const preserved = report.files.filter((file) => file.status === 'preserved');
  if (preserved.length > 0) {
    human.push('');
    human.push(
      `${preserved.length} file(s) were edited after this tool wrote them and were left alone.`,
    );
    for (const file of preserved) human.push(`  ${file.path}`);
    human.push('Re-run with --force to overwrite them.');
  }

  if (match.notes.length > 0) {
    human.push('');
    for (const note of match.notes) human.push(`note: ${note}`);
  }

  if (!invocation.dryRun) {
    human.push('');
    human.push('Next: `vdiff init` to scaffold .visual-diff/, then `vdiff run <flow>`.');
  }

  const data: InstallData = {
    harness: match.id,
    label: match.label,
    scope: target.scope,
    root: target.root,
    version: ctx.version,
    targets,
    written: report.written,
    skipped: report.skipped,
    files: report.files,
    dryRun: invocation.dryRun,
    notes: match.notes,
  };

  // `--dir` names a directory outright; precedence between the standard project and global roots
  // has nothing to say about it, so the notice is skipped rather than invented.
  const warnings =
    invocation.dir === undefined
      ? await otherScopeWarnings(ctx, match, target.scope, home)
      : [];

  return warnings.length === 0
    ? { data, human, exitCode: EXIT.OK }
    : { data, human, warnings, exitCode: EXIT.OK };
}

/** `skills → .claude/skills`, and a plain statement for a mechanism the harness does not have. */
function targetLines(label: string, targets: HarnessTargets): string[] {
  const lines: string[] = [];
  for (const [key, name] of TARGET_KINDS) {
    const path = targets[key];
    lines.push(
      path === null
        ? `  ${name.padEnd(12)}  — ${label} has none; nothing written for it`
        : `  ${name.padEnd(12)}  ${path}`,
    );
  }
  return lines;
}

/**
 * The other scope's copy, noticed and named — never touched (D17).
 *
 * Installing into one scope while a copy sits in the other is the case D16 is about. What happens
 * next is harness-specific (a personal copy overrides the project one in Claude Code, shadows it
 * in pi, and sits beside it in Codex), so this reports the fact and points at `--check`. One line,
 * and nothing rewritten: refreshing a directory the user did not name is precisely what D17
 * rejected.
 */
async function otherScopeWarnings(
  ctx: CommandContext,
  harness: HarnessInfo,
  installed: InstallScope,
  home: string,
): Promise<string[]> {
  const other: InstallScope = installed === 'project' ? 'global' : 'project';
  const scope = await checkScope(ctx, harness.id, other, scopeRoot(other, ctx.cwd, home));
  if (!isInstalled(scope)) return [];
  if (scope.status === 'current') {
    return [
      `${harness.label} is also installed in the ${other} scope (${scope.root}); ` +
        'run `vdiff install --check` to see both',
    ];
  }
  return [driftNotice(harness.label, other, scope.status)];
}

/**
 * A refused write is exit 2 (§6), and the message has to name the path: "permission denied" with
 * no path is the most reliable way for a CLI to waste someone's afternoon.
 *
 * An error that already carries a CLI payload is passed through untouched. The one that matters is
 * the adapter's refusal to guess where a malformed `AGENTS.md` block ends: its message names the
 * file and the markers, so it is given its own code and otherwise repeated verbatim — nothing this
 * layer could compose would be more specific. It is recognised by name rather than by `instanceof`
 * because the CLI sits at the top of the dependency graph and imports no module statically.
 */
function writeFailure(label: string, root: string, cause: unknown): unknown {
  if (isCliErrorLike(cause)) return cause;

  const code = (cause as NodeJS.ErrnoException | null)?.code;
  const message = cause instanceof Error ? cause.message : String(cause);

  if (cause instanceof Error && cause.name === 'MalformedBlockError') {
    return configError('malformed-agents-block', message, {
      hint: 'fix or remove the vdiff markers in that file, then re-run',
      cause,
    });
  }

  if (typeof code === 'string' && NOT_WRITABLE.has(code)) {
    return configError('target-not-writable', `cannot write into ${root}: ${message}`, {
      hint: 'point --dir at a writable directory, or fix the permissions on that path',
      cause,
    });
  }

  return configError('install-failed', `installing ${label} into ${root} failed: ${message}`, {
    cause,
  });
}

/**
 * `--list`: every registered harness, both of its targets, and the exact files it would write.
 *
 * Composed rather than dry-run-installed, so this branch provably touches no directory — and the
 * paths it prints come from the same composition an install writes, so the listing cannot drift
 * from it.
 */
async function listHarnesses(
  ctx: CommandContext,
  harnesses: readonly HarnessInfo[],
  home: string,
  dir?: string,
): Promise<CommandResult<InstallListData>> {
  const rows: InstallListData['harnesses'] = [];
  const human: string[] = [];

  for (const harness of harnesses) {
    const scopes: InstallListScope[] = [];
    for (const scope of SCOPES) {
      const files = await ctx.ports.adapterFiles(harness.id, scope);
      scopes.push({
        scope,
        root: scopeRoot(scope, ctx.cwd, home, dir),
        targets: await ctx.ports.adapterTargets(harness.id, scope),
        files: files.map((file) => file.path),
      });
    }
    rows.push({ id: harness.id, label: harness.label, scopes, notes: harness.notes });

    human.push(`${harness.label} (${harness.id})`);
    for (const scope of scopes) {
      human.push(`  ${scope.scope}: ${scope.root}`);
      for (const file of scope.files) human.push(`    ${file}`);
      if (scope.files.length === 0) {
        human.push(`    — nothing to write in this scope`);
      }
    }
    for (const note of harness.notes) human.push(`  note: ${note}`);
    human.push('');
  }

  human.push('Install one with `vdiff install <harness>`; add --global for the user-level target.');

  return { data: { harnesses: rows }, human, exitCode: EXIT.OK };
}

/**
 * The home directory a `--global` install writes under.
 *
 * `main()` always supplies it; the fallback covers a context built without one. It is read through
 * `CommandContext` rather than called at the point of use so that a test naming a global target
 * names its own directory and cannot install into the machine running the suite.
 */
function homeOf(ctx: CommandContext): string {
  return ctx.home !== undefined && ctx.home.length > 0 ? ctx.home : homedir();
}
