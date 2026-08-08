/**
 * cli — dispatch and exit-code mapping (spec §9, §10).
 *
 * `runCli` is the whole CLI as one function: argv and a context in, an exit code out, everything
 * written through an injected writer. It never calls `process.exit`, which is what lets the
 * `--json` contract tests (spec §11.6) exercise the real parser, the real dispatch and the real
 * envelope in-process. `main()` is the thin wrapper the binary uses.
 *
 * Exit-code rules, in one place:
 *   0  success — including `diff` with findings, which is a spec decision, not an accident
 *   1  run or replay failure (a partial run counts: a step did not replay)
 *   2  config or spec error (also: an unknown command, flag or argument)
 */

import { EXIT, type CliEnvelope, type CliError, type ExitCode } from '../types.js';

import { commandLabel, parseArgs, wantsJson, type Invocation } from './args.js';
import type { CommandContext, CommandResult } from './command.js';
import { createPorts } from './deps.js';
import { toCliError } from './error.js';
import { help, version as versionCommand } from './help.js';
import {
  createWriter,
  failureEnvelope,
  formatError,
  successEnvelope,
  writeEnvelope,
  writeLines,
  type Writer,
} from './output.js';
import { spawnCapture, waitForShutdown } from './process.js';
import { readVersion } from './version.js';

import { diff } from './commands/diff.js';
import { feedback } from './commands/feedback.js';
import { flowCheck, flowNew } from './commands/flow.js';
import { init } from './commands/init.js';
import { install } from './commands/install.js';
import { installBrowser } from './commands/install-browser.js';
import { pin, prune } from './commands/pin.js';
import { run } from './commands/run.js';
import { runs } from './commands/runs.js';
import { serve } from './commands/serve.js';

export interface CliRuntime extends CommandContext {
  writer: Writer;
}

async function dispatch(
  invocation: Invocation,
  ctx: CommandContext,
): Promise<CommandResult<unknown>> {
  switch (invocation.kind) {
    case 'help':
      return help(invocation.topic);
    case 'version':
      return versionCommand(ctx.version);
    case 'init':
      return init(ctx);
    case 'flow-new':
      return flowNew(ctx, invocation.name);
    case 'flow-check':
      return flowCheck(ctx, invocation.name);
    case 'run':
      return run(ctx, invocation);
    case 'runs':
      return runs(ctx, invocation.flow);
    case 'diff':
      return diff(ctx, invocation);
    case 'serve':
      return serve(ctx, invocation);
    case 'feedback':
      return feedback(ctx, invocation);
    case 'pin':
      return pin(ctx, invocation);
    case 'prune':
      return prune(ctx, invocation);
    case 'install':
      return install(ctx, invocation);
    case 'install-browser':
      return installBrowser(ctx);
  }
}

export async function runCli(argv: readonly string[], ctx: CliRuntime): Promise<ExitCode> {
  const json = wantsJson(argv);
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    emitError(ctx.writer, parsed.command, ctx.version, parsed.error, json);
    return parsed.error.exitCode;
  }

  const invocation = parsed.value;
  const command = commandLabel(invocation);

  let result: CommandResult<unknown>;
  try {
    result = await dispatch(invocation, ctx);
  } catch (thrown) {
    const error = toCliError(thrown);
    emitError(ctx.writer, command, ctx.version, error, invocation.json);
    return error.exitCode;
  }

  const exitCode = result.exitCode ?? EXIT.OK;

  if (invocation.json) {
    const envelope: CliEnvelope<unknown> =
      result.error === undefined
        ? successEnvelope(command, ctx.version, result.data, result.warnings)
        : failureEnvelope(command, ctx.version, result.error, result.data, result.warnings);
    writeEnvelope(ctx.writer, envelope);
  } else {
    writeLines(ctx.writer, result.human, 'out');
    writeLines(
      ctx.writer,
      (result.warnings ?? []).map((warning) => `warning: ${warning}`),
      'err',
    );
    if (result.error !== undefined) writeLines(ctx.writer, formatError(result.error), 'err');
  }

  if (result.after !== undefined) await result.after();

  return exitCode;
}

function emitError(
  writer: Writer,
  command: string,
  version: string,
  error: CliError,
  json: boolean,
): void {
  if (json) writeEnvelope(writer, failureEnvelope(command, version, error));
  else writeLines(writer, formatError(error), 'err');
}

/** Binary entry point. The only place in the package that ends the process. */
export async function main(argv: readonly string[]): Promise<void> {
  const code = await runCli(argv, {
    cwd: process.cwd(),
    ports: createPorts(),
    version: await readVersion(),
    spawn: spawnCapture,
    waitForShutdown,
    writer: createWriter(),
  });

  process.exitCode = code;
  if (code !== EXIT.OK) process.exit(code);
}
