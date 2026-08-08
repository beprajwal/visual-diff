/**
 * `vdiff install <harness> [--dir <path>] [--force] [--dry-run]` (spec §9, "Claude Code
 * integration").
 *
 * The point of this command is that `npx visual-diff install claude-code` works with nothing
 * installed beforehand: it drops the `visual-diff` skill and the `/vdiff` and `/vdiff-review`
 * command files into the project so the harness can find them, and that is the entire first step
 * of adopting the tool.
 *
 * There is no adapter logic here. Which files exist, what they contain, and whether a file a human
 * edited may be replaced are all decisions of `src/adapters/`; this file resolves a directory,
 * validates the harness id against the registry, and renders the report. The registry is also what
 * the "unknown harness" message lists, so adding an adapter needs no change here.
 */

import { isAbsolute, resolve } from 'node:path';

import { EXIT } from '../../types.js';
import type { AdapterId } from '../../types.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { Invocation } from '../args.js';
import { configError } from '../error.js';
import type { InstallData } from '../shapes.js';

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
): Promise<CommandResult<InstallData>> {
  const harnesses = await ctx.ports.listAdapters();
  const match = harnesses.find((harness) => harness.id === invocation.harness);

  if (match === undefined) {
    const supported = harnesses.map((harness) => harness.id).join(', ');
    throw configError(
      'unknown-harness',
      `unknown harness '${invocation.harness}'`,
      { hint: `supported harnesses: ${supported}` },
    );
  }

  const root =
    invocation.dir === undefined
      ? ctx.cwd
      : isAbsolute(invocation.dir)
        ? resolve(invocation.dir)
        : resolve(ctx.cwd, invocation.dir);

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
