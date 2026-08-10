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
 *
 * `--e2e` is the same shape one axis over (e2e spec §6, D27). An ingested run is on its own timeline
 * with its own retention bucket (§7) — ingesting a CI run's worth of traces must never evict replay
 * history — so the default listing excludes them, counts them, and names the flag that shows them.
 * Not a filter but a switch between timelines, which is why the count lives in the command rather
 * than in a second narrowed read the store could answer.
 */

import { SCENARIO_NONE, type RunSummary } from '../../types.js';
import type { Invocation } from '../args.js';
import type { CommandContext, CommandResult } from '../command.js';
import { isE2eRun, showSource, sourceOf } from '../e2e.js';
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
  const { flow, scenario, variants, e2e } = invocation;
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const store = await ctx.ports.openStore(config);

  // Only the scenario is a narrowing, and only it is pushed down as one. `--variants` and `--e2e`
  // are switches *between* timelines — regression history, proposals, and what a test suite
  // produced — and this command has to count what it is not showing in order to say so, which one
  // bucket-filtered read cannot answer. So it asks for every bucket and splits here.
  //
  // `include` is passed explicitly because the store excludes both buckets by default; without it
  // the hidden-run counts below would read zero on precisely the projects that have something to
  // hide. `findingsCount` is unaffected: the store measures it against the previous run of the same
  // identity as it walks the whole timeline, before any bucket filter applies.
  const filter: RunFilter = { variants: 'include', e2e: 'include' };
  if (scenario !== undefined) filter.scenario = scenario;
  const all = await store.listRuns(flow, filter);

  // Two exclusions, applied in the same pass because they compose: the default timeline is the
  // replay history minus the *ephemeral* variant runs. A promoted variant run is not hidden —
  // `--keep` is precisely the act of moving a proposal into the permanent timeline (D24), so
  // filtering it back out again would undo the only thing the flag does — and an ingested run is
  // always hidden from it, because it is not on that timeline at all (D27).
  const list = all.filter((summary) => {
    if (e2e) return isE2eRun(summary);
    if (isE2eRun(summary)) return false;
    return variants ? isVariantRun(summary) : !isEphemeralVariantRun(summary);
  });
  const hiddenVariantRuns =
    variants || e2e ? 0 : all.filter((s) => !isE2eRun(s) && isEphemeralVariantRun(s)).length;
  const hiddenE2eRuns = e2e ? 0 : all.filter(isE2eRun).length;

  const data: RunsData = { flow, runs: list };
  if (scenario !== undefined) data.scenario = scenario;
  if (variants) data.variants = true;
  if (e2e) data.e2e = true;

  // Both notes can appear at once, and in that order: a reader on the default timeline is told
  // about the proposals they cannot see and about the ingested runs they cannot see, separately,
  // because the two are reached by different flags.
  const hiddenNote: string[] = [];
  if (hiddenVariantRuns > 0) {
    hiddenNote.push(
      `${hiddenVariantRuns} variant ${hiddenVariantRuns === 1 ? 'run' : 'runs'} not shown` +
        ` — \`vdiff runs ${flow} --variants\``,
    );
  }
  if (hiddenE2eRuns > 0) {
    hiddenNote.push(
      `${hiddenE2eRuns} e2e ${hiddenE2eRuns === 1 ? 'run' : 'runs'} not shown` +
        ` — \`vdiff runs ${flow} --e2e\``,
    );
  }

  if (list.length === 0) {
    const human = e2e
      ? [`no e2e runs for flow '${flow}' — \`vdiff e2e --from trace <path>\``]
      : variants
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
  // variant every row would read `-`, and a column of dashes is furniture. SOURCE follows the same
  // rule, which is why it is absent from an ordinary listing: every row there is a replay.
  const showVariantColumn = variants || list.some(isVariantRun);
  const showSourceColumn = e2e || list.some(isE2eRun);
  const columns = ['RUN', 'REVISION', 'REF', 'SCENARIO'];
  if (showVariantColumn) columns.push('VARIANT');
  if (showSourceColumn) columns.push('SOURCE');
  columns.push('MODE', 'STATUS', 'FINDINGS', 'FLAGS', 'STARTED');

  const human = table(
    columns,
    list.map((summary) => {
      const row = [summary.runId, revisionCell(summary), summary.revision.ref ?? '-', scenarioCell(summary)];
      if (showVariantColumn) row.push(variantCell(summary));
      if (showSourceColumn) row.push(showSource(sourceOf(summary)));
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
