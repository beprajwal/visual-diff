/**
 * `vdiff run <flow> [--at <ref>] [--viewport ...] [--record|--no-net] [--continue-on-error]
 * [--no-scrub]` (spec §9).
 *
 * All the work belongs to the runner; this file maps flags to `RunOptions`, renders the step table
 * and picks the exit code. A run whose steps did not all replay is a replay failure — exit 1 —
 * even though the run directory was still written and is still diffable: `status: partial` exists
 * precisely so the evidence survives the failure.
 *
 * When the failure retained a log — §10's "dev server never ready → exit 1 with the last 50 lines
 * of server log", and the same for `install.log` — the tail is read back and travels on the error,
 * so the reason is in the output of the command that failed rather than in a file the reader has
 * to go and find.
 */

import {
  EXIT,
  DEFAULTS,
  SCENARIO_NONE,
  type CliError,
  type RunOptions,
  type RunResult,
  type RunWarning,
} from '../../types.js';
import type { CommandContext, CommandResult } from '../command.js';
import { durationToMs, type Invocation } from '../args.js';
import { configError } from '../error.js';
import { formatLogTail, readLogTail } from '../log.js';
import { table } from '../output.js';
import { identitySuffix, variantOf, VARIANT_NONE, type VariantName } from '../variant.js';

type RunInvocation = Extract<Invocation, { kind: 'run' }>;

/**
 * The two run options this slice adds (variants spec §5, §6).
 *
 * Declared as an intersection rather than assumed to be on `RunOptions`, so the CLI compiles
 * against the runner's published contract whether or not it has grown the fields yet — and remains
 * correct, unchanged, once it has.
 */
type VariantRunOptions = RunOptions & {
  /** Capture under this variant. Absent means `VARIANT_NONE`. */
  variant?: VariantName;
  /** Promote this variant run out of the variant bucket into the permanent timeline (D24). */
  keep?: boolean;
};

/**
 * One warning as a single line. `rules` is rendered alongside `steps` and `urls` because the
 * scenario and variant warnings are *about* rules: `scenario-rule-unmatched` naming no rule would
 * be the least useful line the tool could print, given the whole point is telling the user which
 * glob missed (mocking spec §8) — and the same holds for a variant rule that matched nothing or
 * whose effect was reverted before capture (variants spec §7, D22).
 */
function describeWarning(warning: RunWarning): string {
  const urls = warning.urls === undefined || warning.urls.length === 0 ? '' : ` ${warning.urls.join(', ')}`;
  const steps =
    warning.steps === undefined || warning.steps.length === 0 ? '' : ` [${warning.steps.join(', ')}]`;
  const rules =
    warning.rules === undefined || warning.rules.length === 0 ? '' : ` rules: ${warning.rules.join(', ')}`;
  return `${warning.kind}: ${warning.message}${rules}${steps}${urls}`;
}

/** An environment value that was set to something. `VDIFF_BASE_URL=` in a workflow is unset. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes)$/i.test(value.trim());
}

/** `VDIFF_STEP_TIMEOUT=90s` → ms. Unset or empty is unset; a malformed value is a config error. */
function envDuration(value: string | undefined): number | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) return undefined;
  const ms = durationToMs(raw);
  if (ms === null) {
    throw configError(
      'invalid-duration',
      `VDIFF_STEP_TIMEOUT '${raw}' needs a unit: 60s, 2m, 1500ms`,
    );
  }
  return ms;
}

export async function run(
  ctx: CommandContext,
  invocation: RunInvocation,
): Promise<CommandResult<RunResult>> {
  const options: VariantRunOptions = {
    flow: invocation.flow,
    cwd: ctx.cwd,
    continueOnError: invocation.continueOnError,
    noScrub: invocation.noScrub,
    json: invocation.json,
  };
  if (invocation.at !== undefined) options.at = invocation.at;
  if (invocation.viewports !== undefined) options.viewports = invocation.viewports;
  if (invocation.network !== undefined) options.network = invocation.network;
  if (invocation.scenario !== undefined) options.scenario = invocation.scenario;
  if (invocation.variant !== undefined) options.variant = invocation.variant;
  // Only sent when asked for: `keep: false` on every ordinary run would read as a decision the
  // caller made about retention, and they made no such decision.
  if (invocation.keep) options.keep = true;

  // CI overrides (CI spec D41): the flag wins, the environment is the fallback, the file is the
  // default. Read from the environment because the composite action calls `vdiff run` with no
  // flags, and a runner that fronts the app on another origin sets these once for the whole job.
  const env = ctx.env ?? process.env;
  const baseUrl = invocation.baseUrl ?? nonEmpty(env['VDIFF_BASE_URL']);
  if (baseUrl !== undefined) options.baseUrl = baseUrl;
  const readyOn = invocation.readyOn ?? nonEmpty(env['VDIFF_READY_ON']);
  if (readyOn !== undefined) options.readyOn = readyOn;
  if (invocation.ignoreHttpsErrors === true || isTruthy(env['VDIFF_IGNORE_HTTPS_ERRORS'])) {
    options.ignoreHTTPSErrors = true;
  }
  const stepTimeout = invocation.stepTimeoutMs ?? envDuration(env['VDIFF_STEP_TIMEOUT']);
  if (stepTimeout !== undefined) options.stepTimeoutMs = stepTimeout;

  const result = await ctx.ports.runFlow(options);
  const { meta, steps } = result;
  const variant = variantOf(meta);

  const revision = `${meta.revision.sha.slice(0, 7)}${meta.revision.dirty ? '+dirty' : ''}`;
  // Scenario and variant are the third and fourth axes of run identity (D12, variants spec §5), so
  // they belong on the identifying line — but only when there is one, so a slice-1 run reads
  // exactly as it always did.
  const identity = identitySuffix(meta.scenario, variant);
  const human: string[] = [
    `run ${meta.runId}  flow ${meta.flow}  ${revision}${identity}  ${meta.mode}  network ${meta.network}`,
  ];

  human.push(
    ...table(
      ['STEP', 'STATUS', 'MS', 'SHOTS'],
      steps.map((step) => [
        step.id,
        step.status,
        String(step.durationMs),
        Object.keys(step.viewports).join(' '),
      ]),
    ),
  );

  const failed = steps.filter((step) => step.status === 'failed');
  const blocked = steps.filter((step) => step.status === 'blocked');

  // Why each step failed, right under the table. In CI this line is the whole diagnosis: the run
  // directory with the failure screenshot is on a runner nobody can open, and "autolog-upload
  // failed" alone sends the reader to download an artifact to learn it was a selector timeout.
  for (const step of failed) {
    const failure = step.failure;
    if (failure === undefined) continue;
    const where = failure.selector === undefined ? '' : ` (${failure.verb ?? 'step'} ${failure.selector})`;
    human.push(`  ${step.id} failed${where}: ${failure.message.split('\n')[0]}`);
    if (failure.screenshot !== undefined) human.push(`    screenshot: ${failure.screenshot}`);
  }
  // A mock-only run has no recording, so "har 0 hit" would be a true sentence that reads as a
  // failure. Report what the mode actually produces: rules served, requests missed (D13).
  // `harHits` is necessarily 0 under `mock` — nothing consulted a recording, because there is no
  // recording — so the count reported here is the one the mode actually produces: requests a rule
  // answered (`meta.scenarioServed`). Absent on a meta written before the field existed, which
  // reads back as 0 rather than as a crash.
  const network =
    meta.network === 'mock'
      ? `  mock ${meta.scenarioServed ?? 0} served / ${meta.harMisses} miss`
      : `  har ${meta.harHits} hit / ${meta.harMisses} miss`;
  human.push(
    `status ${meta.status}  ${steps.length} steps, ${failed.length} failed, ${blocked.length} blocked` +
      network,
  );
  if (meta.unstable) {
    human.push('warning: git state moved during the run — re-run to get a trustworthy comparison');
  }
  // A variant run is exploratory and lives in its own retention bucket, out of the regression
  // timeline (D24). Said here rather than left to be discovered when `vdiff runs` does not list it.
  if (variant !== VARIANT_NONE) {
    human.push(
      `variant run: kept apart from the regression timeline —` +
        ` \`vdiff runs ${meta.flow} --variants\` lists it`,
    );
  }
  human.push(`run directory: ${result.runDir}`);
  // The next command has to carry the scenario and the variant, or it pairs this run against a
  // differently-scoped one and reports the change of state, or of the proposal, as a regression
  // (mocking spec §6; variants spec §5).
  human.push(
    `next: vdiff diff ${meta.flow}${
      meta.scenario === SCENARIO_NONE ? '' : ` --scenario ${meta.scenario}`
    }${variant === VARIANT_NONE ? '' : ` --variant ${variant}`}`,
  );

  const warnings = meta.warnings.map(describeWarning);

  if (meta.status === 'ok') {
    return { data: result, human, warnings };
  }

  const failure = meta.failure;
  const message =
    failure?.message ??
    (failed.length > 0
      ? `run ${meta.runId} is ${meta.status}: ${failed.map((step) => step.id).join(', ')} failed`
      : `run ${meta.runId} is ${meta.status}`);

  const error: CliError = {
    code: failure === undefined ? `run-${meta.status}` : `run-${failure.kind}`,
    message,
    exitCode: EXIT.RUN_FAILURE,
  };

  if (failure?.logPath !== undefined) {
    const tail = await readLogTail(result.runDir, failure.logPath, DEFAULTS.serverLogTailLines);
    // A log that vanished must not replace the real failure with a filesystem one: name it instead.
    error.hint = tail === null ? `log: ${failure.logPath}` : formatLogTail(failure.logPath, tail);
  }

  return { data: result, human, warnings, error, exitCode: EXIT.RUN_FAILURE };
}
