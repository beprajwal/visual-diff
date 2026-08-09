/**
 * `vdiff runs <flow> [--scenario <name>]` — the timeline: SHA, dirty, scenario, status, findings
 * count (spec §9; mocking spec §7).
 *
 * Pruned runs stay in the list. Their blobs are gone but `meta.json` survives, so the timeline is
 * never truncated and a pruned point remains backfillable by replay (spec §6).
 *
 * Run ids stay monotonic per flow regardless of scenario (mocking spec §6), so the unfiltered
 * timeline is one honest sequence of what was captured, in order, and `--scenario` is a *filter*
 * over it rather than a different numbering. That is why the ids in a filtered listing have gaps:
 * the gaps are other scenarios, and hiding them by renumbering would make `0007` ambiguous.
 */

import { SCENARIO_NONE, type RunSummary } from '../../types.js';
import type { Invocation } from '../args.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { RunsData } from '../shapes.js';
import { table } from '../output.js';

type RunsInvocation = Extract<Invocation, { kind: 'runs' }>;

function revisionCell(summary: RunSummary): string {
  const sha = summary.revision.sha === '' ? '-' : summary.revision.sha.slice(0, 7);
  return summary.revision.dirty ? `${sha}+dirty` : sha;
}

function flagsCell(summary: RunSummary): string {
  const flags: string[] = [];
  if (summary.pinned) flags.push('pinned');
  if (summary.pruned) flags.push('pruned');
  if (summary.unstable) flags.push('unstable');
  return flags.join(',');
}

/**
 * A slice-1 `meta.json` has no `scenario`; the store defaults it to `SCENARIO_NONE` on read, and
 * this renders that as `-` so the column reads as "no scenario" rather than as a scenario called
 * "none".
 */
function scenarioCell(summary: RunSummary): string {
  return summary.scenario === SCENARIO_NONE ? '-' : summary.scenario;
}

export async function runs(
  ctx: CommandContext,
  invocation: RunsInvocation,
): Promise<CommandResult<RunsData>> {
  const { flow, scenario } = invocation;
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const store = await ctx.ports.openStore(config);
  const list = await store.listRuns(flow, scenario);

  const data: RunsData = { flow, runs: list };
  if (scenario !== undefined) data.scenario = scenario;

  if (list.length === 0) {
    const human =
      scenario === undefined
        ? [`no runs for flow '${flow}' yet — \`vdiff run ${flow}\``]
        : scenario === SCENARIO_NONE
          ? [`no runs for flow '${flow}' captured without a scenario`]
          : [
              `no runs for flow '${flow}' under scenario '${scenario}'` +
                ` — \`vdiff run ${flow} --scenario ${scenario}\``,
            ];
    return { data, human };
  }

  const human = table(
    ['RUN', 'REVISION', 'REF', 'SCENARIO', 'MODE', 'STATUS', 'FINDINGS', 'FLAGS', 'STARTED'],
    list.map((summary) => [
      summary.runId,
      revisionCell(summary),
      summary.revision.ref ?? '-',
      scenarioCell(summary),
      summary.mode,
      summary.status,
      summary.findingsCount === null ? '-' : String(summary.findingsCount),
      flagsCell(summary),
      summary.startedAt,
    ]),
  );

  return { data, human };
}
