/**
 * `vdiff runs <flow> [--scenario <name>] [--variants]` — the timeline: SHA, dirty, scenario,
 * variant, status, findings count (spec §9; mocking spec §7; variants spec §5, §6).
 *
 * Pruned runs stay in the list. Their blobs are gone but `meta.json` survives, so the timeline is
 * never truncated and a pruned point remains backfillable by replay (spec §6).
 *
 * Run ids stay monotonic per flow regardless of scenario (mocking spec §6), so the unfiltered
 * timeline is one honest sequence of what was captured, in order, and `--scenario` is a *filter*
 * over it rather than a different numbering. That is why the ids in a filtered listing have gaps:
 * the gaps are other scenarios, and hiding them by renumbering would make `0007` ambiguous.
 *
 * Variants are the one dimension that changes the *default*. Variant runs are exploratory and live
 * in their own retention bucket precisely so that trying five arrangements never evicts the capture
 * history regressions depend on (D24), so the regression timeline excludes them and `--variants`
 * lists them instead. Excluding them silently would be the wrong kind of quiet, so a hidden variant
 * run is counted and named in a trailing line: the reader is told what they are not being shown.
 */

import { SCENARIO_NONE, type RunSummary } from '../../types.js';
import type { Invocation } from '../args.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { RunFilter } from '../ports.js';
import type { RunsData } from '../shapes.js';
import { table } from '../output.js';
import { isEphemeralVariantRun, isKept, isVariantRun, variantOf, VARIANT_NONE } from '../variant.js';

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
  // `kept` is why a variant run appears on the regression timeline at all, so it is named there
  // rather than left to be inferred from a row that "should not" be present.
  if (isKept(summary)) flags.push('kept');
  return flags.join(',');
}

/**
 * A slice-1 `meta.json` has no `scenario`; the store defaults it to `SCENARIO_NONE` on read, and
 * this renders that as `-` so the column reads as "no scenario" rather than as a scenario called
 * "none". `variantCell` does the same for the variant column.
 */
function scenarioCell(summary: RunSummary): string {
  return summary.scenario === SCENARIO_NONE ? '-' : summary.scenario;
}

function variantCell(summary: RunSummary): string {
  const variant = variantOf(summary);
  return variant === VARIANT_NONE ? '-' : variant;
}

export async function runs(
  ctx: CommandContext,
  invocation: RunsInvocation,
): Promise<CommandResult<RunsData>> {
  const { flow, scenario, variants } = invocation;
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const store = await ctx.ports.openStore(config);

  // Only the scenario is pushed down to the store. `--variants` is not a narrowing of the timeline
  // but a switch between two of them — the regression history and the proposals — and the command
  // has to count what it is *not* showing in order to say so, which one filtered read cannot
  // answer. So the split happens here, over the whole scenario-narrowed timeline.
  const filter: RunFilter = {};
  if (scenario !== undefined) filter.scenario = scenario;
  const all = await store.listRuns(flow, filter);

  // What the default timeline hides is the *ephemeral* variant run. A promoted one is not hidden:
  // `--keep` is precisely the act of moving a proposal into the permanent timeline (D24), so
  // filtering it back out again would undo the only thing the flag does.
  const list = all.filter((summary) =>
    variants ? isVariantRun(summary) : !isEphemeralVariantRun(summary),
  );
  const hiddenVariantRuns = variants ? 0 : all.filter(isEphemeralVariantRun).length;

  const data: RunsData = { flow, runs: list };
  if (scenario !== undefined) data.scenario = scenario;
  if (variants) data.variants = true;

  const hiddenNote =
    hiddenVariantRuns === 0
      ? []
      : [
          `${hiddenVariantRuns} variant ${hiddenVariantRuns === 1 ? 'run' : 'runs'} not shown` +
            ` — \`vdiff runs ${flow} --variants\``,
        ];

  if (list.length === 0) {
    const human = variants
      ? [`no variant runs for flow '${flow}' — \`vdiff run ${flow} --variant <name>\``]
      : scenario === undefined
        ? [`no runs for flow '${flow}' yet — \`vdiff run ${flow}\``]
        : scenario === SCENARIO_NONE
          ? [`no runs for flow '${flow}' captured without a scenario`]
          : [
              `no runs for flow '${flow}' under scenario '${scenario}'` +
                ` — \`vdiff run ${flow} --scenario ${scenario}\``,
            ];
    return { data, human: [...human, ...hiddenNote] };
  }

  // The VARIANT column appears only when it would say something: under `--variants`, or on a
  // regression timeline that a promoted run has joined. On a project that has never written a
  // variant every row would read `-`, and a column of dashes is furniture.
  const showVariantColumn = variants || list.some(isVariantRun);
  const columns = ['RUN', 'REVISION', 'REF', 'SCENARIO'];
  if (showVariantColumn) columns.push('VARIANT');
  columns.push('MODE', 'STATUS', 'FINDINGS', 'FLAGS', 'STARTED');

  const human = table(
    columns,
    list.map((summary) => {
      const row = [summary.runId, revisionCell(summary), summary.revision.ref ?? '-', scenarioCell(summary)];
      if (showVariantColumn) row.push(variantCell(summary));
      row.push(
        summary.mode,
        summary.status,
        summary.findingsCount === null ? '-' : String(summary.findingsCount),
        flagsCell(summary),
        summary.startedAt,
      );
      return row;
    }),
  );

  return { data, human: [...human, ...hiddenNote] };
}
