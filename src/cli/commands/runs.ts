/**
 * `vdiff runs <flow>` — the timeline: SHA, dirty, status, findings count (spec §9).
 *
 * Pruned runs stay in the list. Their blobs are gone but `meta.json` survives, so the timeline is
 * never truncated and a pruned point remains backfillable by replay (spec §6).
 */

import type { RunSummary } from '../../types.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { RunsData } from '../shapes.js';
import { table } from '../output.js';

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

export async function runs(ctx: CommandContext, flow: string): Promise<CommandResult<RunsData>> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const store = await ctx.ports.openStore(config);
  const list = await store.listRuns(flow);

  const human =
    list.length === 0
      ? [`no runs for flow '${flow}' yet — \`vdiff run ${flow}\``]
      : table(
          ['RUN', 'REVISION', 'REF', 'MODE', 'STATUS', 'FINDINGS', 'FLAGS', 'STARTED'],
          list.map((summary) => [
            summary.runId,
            revisionCell(summary),
            summary.revision.ref ?? '-',
            summary.mode,
            summary.status,
            summary.findingsCount === null ? '-' : String(summary.findingsCount),
            flagsCell(summary),
            summary.startedAt,
          ]),
        );

  return { data: { flow, runs: list }, human };
}
