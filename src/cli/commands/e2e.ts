/**
 * `vdiff e2e --from trace <path|glob>` and `vdiff e2e list --from trace <path|glob>` (e2e spec §6).
 *
 * Both commands are one computation with the write at the end of one of them. `list` asks the
 * ingestion module for a plan and prints it; `e2e` asks for the same plan, checks the two things the
 * CLI is the right layer to check, and then ingests. That is what makes "show what would be
 * ingested, without writing" an honest promise rather than a second implementation that drifts.
 *
 * Three refusals live here, and each one is a decision:
 *
 *  1. **A pattern that named nothing is exit 2.** A glob that matched no archive is nearly always a
 *     wrong path — the shell already expanded it, or the suite wrote somewhere else — and an
 *     "ingested 0 runs, exit 0" would be indistinguishable from success in a CI log.
 *  2. **`--flow` over more than one archive is exit 2.** The flag overrides the name derived from
 *     the test title (D26). Applied to a glob it would collapse several distinct tests into one
 *     flow, where their steps interleave and every diff aligns on the wrong thing. Refusing names
 *     both the flag and the count, so the fix — ingest them one at a time, or drop the flag — is
 *     obvious from the message.
 *  3. **An archive with no screenshots is exit 2** (§8), refused before anything is written. A run
 *     with no shots is worse than no run: it occupies a timeline slot, pairs with its neighbours,
 *     and produces a diff that reports nothing changed.
 *
 * Everything else — expanding the glob, reading the archives, mapping titles to flows and steps to
 * ids, writing the runs — is the ingestion module's, and the CLI never opens a zip.
 */

import type { Invocation } from '../args.js';
import type { CommandContext, CommandResult } from '../command.js';
import { countArchives } from '../e2e.js';
import { configError } from '../error.js';
import { table } from '../output.js';
import type { E2eArchivePlan, E2eIngestPlan, E2eIngestRequest } from '../ports.js';
import type { E2eIngestData, E2eListData } from '../shapes.js';

type IngestInvocation = Extract<Invocation, { kind: 'e2e-ingest' }>;
type ListInvocation = Extract<Invocation, { kind: 'e2e-list' }>;

function toRequest(
  ctx: CommandContext,
  invocation: IngestInvocation | ListInvocation,
): E2eIngestRequest {
  const request: E2eIngestRequest = {
    from: invocation.from,
    pattern: invocation.pattern,
    cwd: ctx.cwd,
  };
  if (invocation.flow !== undefined) request.flow = invocation.flow;
  return request;
}

/** Exit 2 naming the pattern, rather than reporting a successful ingestion of nothing. */
function requireArchives(plan: E2eIngestPlan, command: string): void {
  if (plan.archives.length > 0) return;
  throw configError(
    'e2e-no-archives',
    `no ${plan.from} archives matched '${plan.pattern}'`,
    {
      hint:
        `quote the pattern so this tool expands it rather than the shell, and check the path` +
        ` — \`${command} --from ${plan.from} 'test-results/**/trace.zip'\``,
    },
  );
}

/**
 * The §8 refusal for an archive that recorded no screenshots.
 *
 * This is the default case for library-only tracing rather than an exotic one: `tracing.start()`
 * with no options records neither screenshots nor snapshots, so a suite that enabled tracing without
 * asking for images produces archives that look complete and contain nothing to diff. The message
 * therefore names the option that was missing, because "no screenshots" alone sends the reader
 * looking for a corrupt file.
 */
function requireShots(plan: E2eIngestPlan): void {
  const empty = plan.archives.filter((archive) => archive.shots === 0);
  if (empty.length === 0) return;
  const first = empty[0] as E2eArchivePlan;
  throw configError(
    'e2e-no-screenshots',
    `${first.path} contains no screenshots, so there is nothing to diff` +
      (empty.length === 1 ? '' : ` (and ${empty.length - 1} more)`),
    {
      hint:
        'Playwright records screenshots only when tracing is started with them:' +
        " `tracing.start({ screenshots: true, snapshots: true })`, or `use: { trace: 'on' }`" +
        ' under @playwright/test',
    },
  );
}

/**
 * `--flow` renames one archive's flow. Over several it would merge unrelated tests into one
 * timeline, so it is refused with the count that makes the mistake legible.
 */
function requireSingleArchiveForFlow(plan: E2eIngestPlan, flow: string | undefined): void {
  if (flow === undefined || plan.archives.length <= 1) return;
  throw configError(
    'e2e-flow-override-ambiguous',
    `--flow ${flow} names one flow, but '${plan.pattern}' matched ${countArchives(plan.archives.length)}`,
    {
      hint:
        'ingest them one at a time to rename each, or drop --flow and let each test title name its' +
        ' own flow',
    },
  );
}

/** The `e2e-map.yaml` entries that pinned a title no archive carries (§8), as a run warning. */
function mapWarnings(unmatched: readonly string[]): string[] {
  if (unmatched.length === 0) return [];
  return [
    `e2e-map.yaml pins ${unmatched.length === 1 ? 'a title' : `${unmatched.length} titles`} no` +
      ` trace in this batch carries: ${unmatched.join(', ')}` +
      ' — the pinned step ids are not being applied',
  ];
}

export async function e2eList(
  ctx: CommandContext,
  invocation: ListInvocation,
): Promise<CommandResult<E2eListData>> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const plan = await ctx.ports.planE2eIngest(config, toRequest(ctx, invocation));
  requireArchives(plan, 'vdiff e2e list');
  requireSingleArchiveForFlow(plan, invocation.flow);

  const human: string[] = [
    `${countArchives(plan.archives.length)} matched '${plan.pattern}'` +
      ' — nothing written, this is a preview',
  ];

  human.push('');
  human.push(
    ...table(
      ['FLOW', 'STEPS', 'SHOTS', 'TRACE', 'STATE', 'ARCHIVE'],
      plan.archives.map((archive) => [
        archive.flow,
        String(archive.steps.length),
        // Zero shots is the §8 refusal, and `list` is where a reader gets to see it coming rather
        // than meeting it as an error halfway through a batch.
        archive.shots === 0 ? '0 — nothing to diff' : String(archive.shots),
        `v${archive.traceVersion}`,
        archive.alreadyIngested ? `ingested as ${archive.runId ?? '?'}` : 'new',
        archive.path,
      ]),
    ),
  );

  const notices = plan.archives.flatMap((archive) =>
    archive.notices.map((notice) => `${archive.flow}: ${notice}`),
  );
  if (notices.length > 0) {
    human.push('');
    human.push(...notices);
  }

  const alreadyIngested = plan.archives.filter((archive) => archive.alreadyIngested).length;
  if (alreadyIngested > 0) {
    human.push('');
    human.push(
      `${alreadyIngested} of ${plan.archives.length} already ingested — ingestion is keyed by the` +
        " archive's content hash, so re-running writes nothing for them",
    );
  }

  return { data: plan, human, warnings: [...plan.warnings, ...mapWarnings(plan.unmatchedMapEntries)] };
}

export async function e2eIngest(
  ctx: CommandContext,
  invocation: IngestInvocation,
): Promise<CommandResult<E2eIngestData>> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const request = toRequest(ctx, invocation);

  // Planned first, so every refusal below happens before a single run directory exists. An
  // ingestion that wrote three runs and then rejected the fourth would leave the store in a state
  // nobody asked for and no command undoes.
  const plan = await ctx.ports.planE2eIngest(config, request);
  requireArchives(plan, 'vdiff e2e');
  requireSingleArchiveForFlow(plan, invocation.flow);
  requireShots(plan);

  const report = await ctx.ports.ingestE2eTraces(config, request);
  const reused = report.runs.filter((run) => run.reused).length;
  const written = report.runs.length - reused;

  const human: string[] = [
    `ingested ${countArchives(report.runs.length)}: ${written} new,` +
      ` ${reused} already present`,
  ];

  if (report.runs.length > 0) {
    human.push('');
    human.push(
      ...table(
        ['FLOW', 'RUN', 'STEPS', 'SHOTS', 'STATE', 'ARCHIVE'],
        report.runs.map((run) => [
          run.flow,
          run.runId,
          String(run.steps.length),
          String(run.shots),
          run.reused ? 'reused' : 'ingested',
          run.path,
        ]),
      ),
    );
  }

  const notices = report.runs.flatMap((run) =>
    run.notices.map((notice) => `${run.flow} ${run.runId}: ${notice}`),
  );
  if (notices.length > 0) {
    human.push('');
    human.push(...notices);
  }

  // Every ingested run is on the e2e timeline, which the default `vdiff runs` deliberately hides
  // (D27), so the command that shows what was just written is named rather than left to be guessed.
  const flows = [...new Set(report.runs.map((run) => run.flow))];
  if (flows.length > 0) {
    human.push('');
    human.push(
      flows.length === 1
        ? `\`vdiff runs ${flows[0] as string} --e2e\``
        : `\`vdiff runs <flow> --e2e\` — ${flows.length} flows: ${flows.join(', ')}`,
    );
  }

  const data: E2eIngestData = { ...report, reused };
  return {
    data,
    human,
    warnings: [...report.warnings, ...mapWarnings(report.unmatchedMapEntries)],
  };
}
