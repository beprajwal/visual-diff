/**
 * `vdiff select` — the flows a change reaches, for CI to replay those alone (selection spec §4).
 *
 * The command gathers the changed files and hands them to the selector; it decides nothing itself.
 * `--base <rev>` asks git for the files changed since the merge-base with that revision — the
 * working tree against it, so an uncommitted edit counts locally and a pull request's merge commit
 * counts in CI — plus whatever is untracked. `--changed <file>` takes a list instead, one path per
 * line, for a caller that already has one. The two combine.
 *
 * Exit 0 always, even when nothing is selected: an empty selection is an answer, not a failure,
 * and the action reads `data.mode` to decide what to do with it.
 */

import { readFileSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';

import { summarizeSelection } from '../../select/index.js';
import type { Invocation } from '../args.js';
import type { CommandContext, CommandResult } from '../command.js';
import { configError, runFailure } from '../error.js';
import type { SelectData } from '../shapes.js';

type SelectInvocation = Extract<Invocation, { kind: 'select' }>;

async function git(ctx: CommandContext, cwd: string, args: string[]): Promise<string> {
  const result = await ctx.spawn('git', args, { cwd });
  if (result.code !== 0) {
    throw runFailure('git-failed', `git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

async function changedSince(
  ctx: CommandContext,
  root: string,
  base: string,
): Promise<{ mergeBase: string; changed: string[] }> {
  const probe = await ctx.spawn('git', ['merge-base', base, 'HEAD'], { cwd: root });
  if (probe.code !== 0) {
    throw configError('base-unknown', `no merge-base between '${base}' and HEAD`, {
      hint: 'fetch the base branch first; in a shallow clone, check out with fetch-depth: 0',
    });
  }
  const mergeBase = probe.stdout.trim();
  const diff = await git(ctx, root, ['diff', '--name-only', '--no-renames', mergeBase]);
  const untracked = await git(ctx, root, ['ls-files', '--others', '--exclude-standard']);
  return { mergeBase, changed: [...lines(diff), ...lines(untracked)] };
}

export async function select(
  ctx: CommandContext,
  invocation: SelectInvocation,
): Promise<CommandResult<SelectData>> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const changed: string[] = [];
  let base: string | undefined;

  if (invocation.changed !== undefined) {
    const text =
      invocation.changed === '-'
        ? readFileSync(0, 'utf8')
        : await readFile(invocation.changed, 'utf8').catch(() => {
            throw configError('changed-unreadable', `cannot read ${invocation.changed}`);
          });
    changed.push(...lines(text));
  }
  if (invocation.base !== undefined) {
    const since = await changedSince(ctx, config.root, invocation.base);
    base = since.mergeBase;
    changed.push(...since.changed);
  }

  const request: Parameters<typeof ctx.ports.selectFlows>[1] = { changed };
  if (invocation.all !== undefined) request.all = invocation.all;
  const selection = await ctx.ports.selectFlows(config, request);

  const human = summarizeSelection(selection);
  if (invocation.summary !== undefined) {
    await appendFile(invocation.summary, `${human.join('\n')}\n`, 'utf8');
  }

  const data: SelectData = { ...selection, changed };
  if (base !== undefined) data.base = base;
  return { data, human, warnings: selection.warnings };
}
