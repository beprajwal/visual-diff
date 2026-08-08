/**
 * `vdiff pin <run>` and `vdiff prune <run>` (spec §6, §9).
 *
 * Run ids are per-flow, so a bare `vdiff pin 0007` has to be resolved against the store. When the
 * id exists in exactly one flow that is unambiguous and the command proceeds; when it exists in
 * several, the CLI refuses and prints the disambiguated form rather than guessing which timeline
 * the user meant. `vdiff pin <flow> <run>` always skips the search.
 */

import type { RunId, RunSummary } from '../../types.js';
import type { Invocation } from '../args.js';
import type { CommandContext, CommandResult } from '../command.js';
import { configError } from '../error.js';
import type { StorePort } from '../ports.js';
import type { PinData, PruneData } from '../shapes.js';

type PinInvocation = Extract<Invocation, { kind: 'pin' }>;
type PruneInvocation = Extract<Invocation, { kind: 'prune' }>;

async function resolveFlow(
  store: StorePort,
  command: 'pin' | 'prune',
  flow: string | undefined,
  runId: RunId,
): Promise<string> {
  if (flow !== undefined) {
    const list = await store.listRuns(flow);
    if (!list.some((summary) => summary.runId === runId)) {
      throw configError('run-not-found', `flow '${flow}' has no run ${runId}`, {
        hint: `vdiff runs ${flow}`,
      });
    }
    return flow;
  }

  const flows = await store.listFlows();
  const matches: string[] = [];
  for (const candidate of flows) {
    const list = await store.listRuns(candidate);
    if (list.some((summary) => summary.runId === runId)) matches.push(candidate);
  }

  const first = matches[0];
  if (first === undefined) {
    throw configError('run-not-found', `no flow has a run ${runId}`, {
      hint: 'vdiff runs <flow>',
    });
  }
  if (matches.length > 1) {
    throw configError(
      'run-ambiguous',
      `run ${runId} exists in ${matches.length} flows: ${matches.join(', ')}`,
      { hint: `vdiff ${command} ${first} ${runId}` },
    );
  }
  return first;
}

function describe(summary: RunSummary): string {
  const sha = summary.revision.sha === '' ? '-' : summary.revision.sha.slice(0, 7);
  return `${summary.flow} ${summary.runId}  ${sha}${summary.revision.dirty ? '+dirty' : ''}  ${summary.status}`;
}

export async function pin(
  ctx: CommandContext,
  invocation: PinInvocation,
): Promise<CommandResult<PinData>> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const store = await ctx.ports.openStore(config);
  const flow = await resolveFlow(store, 'pin', invocation.flow, invocation.runId);
  const summary = await store.pinRun(flow, invocation.runId);

  return {
    data: { flow, runId: invocation.runId, pinned: summary.pinned },
    human: [`pinned  ${describe(summary)}`, 'retention will not prune this run'],
  };
}

export async function prune(
  ctx: CommandContext,
  invocation: PruneInvocation,
): Promise<CommandResult<PruneData>> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const store = await ctx.ports.openStore(config);
  const flow = await resolveFlow(store, 'prune', invocation.flow, invocation.runId);
  const summary = await store.pruneRun(flow, invocation.runId);

  return {
    data: { flow, runId: invocation.runId, pruned: summary.pruned },
    human: [
      `pruned  ${describe(summary)}`,
      'blobs deleted; meta.json and flow.snapshot.yaml kept, so the timeline is intact',
      `backfill with: vdiff run ${flow} --at ${summary.revision.sha}`,
    ],
  };
}
