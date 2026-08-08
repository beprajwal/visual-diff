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

import { EXIT, DEFAULTS, type CliError, type RunOptions, type RunResult, type RunWarning } from '../../types.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { Invocation } from '../args.js';
import { formatLogTail, readLogTail } from '../log.js';
import { table } from '../output.js';

type RunInvocation = Extract<Invocation, { kind: 'run' }>;

function describeWarning(warning: RunWarning): string {
  const urls = warning.urls === undefined || warning.urls.length === 0 ? '' : ` ${warning.urls.join(', ')}`;
  const steps =
    warning.steps === undefined || warning.steps.length === 0 ? '' : ` [${warning.steps.join(', ')}]`;
  return `${warning.kind}: ${warning.message}${steps}${urls}`;
}

export async function run(
  ctx: CommandContext,
  invocation: RunInvocation,
): Promise<CommandResult<RunResult>> {
  const options: RunOptions = {
    flow: invocation.flow,
    cwd: ctx.cwd,
    continueOnError: invocation.continueOnError,
    noScrub: invocation.noScrub,
    json: invocation.json,
  };
  if (invocation.at !== undefined) options.at = invocation.at;
  if (invocation.viewports !== undefined) options.viewports = invocation.viewports;
  if (invocation.network !== undefined) options.network = invocation.network;

  const result = await ctx.ports.runFlow(options);
  const { meta, steps } = result;

  const revision = `${meta.revision.sha.slice(0, 7)}${meta.revision.dirty ? '+dirty' : ''}`;
  const human: string[] = [
    `run ${meta.runId}  flow ${meta.flow}  ${revision}  ${meta.mode}  network ${meta.network}`,
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
  human.push(
    `status ${meta.status}  ${steps.length} steps, ${failed.length} failed, ${blocked.length} blocked` +
      `  har ${meta.harHits} hit / ${meta.harMisses} miss`,
  );
  if (meta.unstable) {
    human.push('warning: git state moved during the run — re-run to get a trustworthy comparison');
  }
  human.push(`run directory: ${result.runDir}`);
  human.push(`next: vdiff diff ${meta.flow}`);

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
