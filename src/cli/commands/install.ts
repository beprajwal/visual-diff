/**
 * `vdiff install <harness> [--dir <path>] [--force] [--dry-run]` and `vdiff install --list`
 * (spec §9, "Claude Code integration").
 *
 * The point of this command is that `npx @beprajwal/visual-diff install claude-code` works with
 * nothing installed beforehand: it drops the three `visual-diff` skills and the `/vdiff` and
 * `/vdiff-review` command files into the project so the harness can find them, and that is the
 * entire first step of adopting the tool.
 *
 * There is no adapter logic here. Which files exist, what they contain, and whether a file a human
 * edited may be replaced are all decisions of `src/adapters/`; this file resolves a directory,
 * validates the harness id against the registry, and renders the report. The registry is also what
 * the "unknown harness" message lists, so adding an adapter needs no change here.
 *
 * `--list` is implemented as a dry-run install of every registered harness rather than as a second
 * code path, so what it prints is by construction what an install would write.
 */

import { isAbsolute, resolve } from 'node:path';

import { EXIT } from '../../types.js';
import type { AdapterId } from '../../types.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { Invocation } from '../args.js';
import { configError } from '../error.js';
import type { InstallData, InstallListData } from '../shapes.js';

type InstallInvocation = Extract<Invocation, { kind: 'install' }>;

/** `created`/`updated` are written; the other two explain why a path was left alone. */
const STATUS_LABEL: Record<string, string> = {
  created: 'created  ',
  updated: 'updated  ',
  unchanged: 'current  ',
  preserved: 'preserved',
};

export async function install(
  ctx: CommandContext,
  invocation: InstallInvocation,
): Promise<CommandResult<InstallData | InstallListData>> {
  const harnesses = await ctx.ports.listAdapters();

  if (invocation.list === true) return listHarnesses(ctx, harnesses);

  const match = harnesses.find((harness) => harness.id === invocation.harness);

  if (match === undefined) {
    const supported = harnesses.map((harness) => harness.id).join(', ');
    throw configError(
      'unknown-harness',
      `unknown harness '${invocation.harness}'`,
      { hint: `supported harnesses: ${supported}` },
    );
  }

  const root = resolveRoot(ctx.cwd, invocation.dir);

  const report = await ctx.ports.installAdapter(match.id, root, {
    force: invocation.force,
    dryRun: invocation.dryRun,
  });

  const human: string[] = [];
  if (invocation.dryRun) human.push(`dry run — nothing written (${match.label}, ${root})`);
  else human.push(`${match.label} → ${root}`);

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

  if (!invocation.dryRun) {
    human.push('');
    human.push('Next: `vdiff init` to scaffold .visual-diff/, then `vdiff run <flow>`.');
  }

  return {
    data: {
      harness: match.id as AdapterId,
      label: match.label,
      root,
      written: report.written,
      skipped: report.skipped,
      files: report.files,
      dryRun: invocation.dryRun,
    },
    human,
    exitCode: EXIT.OK,
  };
}

function resolveRoot(cwd: string, dir: string | undefined): string {
  if (dir === undefined) return cwd;
  return isAbsolute(dir) ? resolve(dir) : resolve(cwd, dir);
}

/**
 * `--list`: every registered harness and the exact paths it would write. A dry run against the
 * invocation directory, so the listing cannot drift from the install.
 */
async function listHarnesses(
  ctx: CommandContext,
  harnesses: ReadonlyArray<{ id: AdapterId; label: string }>,
): Promise<CommandResult<InstallListData>> {
  const root = ctx.cwd;
  const rows: InstallListData['harnesses'] = [];
  const human: string[] = [];

  for (const harness of harnesses) {
    const report = await ctx.ports.installAdapter(harness.id, root, { dryRun: true });
    const files = report.files.map((file) => file.path);
    rows.push({ id: harness.id, label: harness.label, files });

    human.push(`${harness.label} (${harness.id})`);
    for (const file of files) human.push(`  ${file}`);
    human.push('');
  }

  human.push('Install one with `vdiff install <harness>`.');

  return { data: { harnesses: rows }, human, exitCode: EXIT.OK };
}
