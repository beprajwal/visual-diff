/**
 * Runner-local error type.
 *
 * Carries the `CliError` shape from `src/types.ts` so `cli/main.ts` can map a failure straight onto
 * an exit code (spec §9) without the runner ever calling `process.exit` itself. It also carries the
 * `RunFailureKind` that goes into `meta.json#failure` (spec §6) and, when a subprocess produced one,
 * the log text that §10 requires to be retained (`install.log`, `server.log`).
 */

import { EXIT, type CliError, type ExitCode, type RunFailureKind } from '../types.js';

export interface RunnerErrorInit {
  /** Stable machine code, e.g. "install-failed", "server-not-ready". */
  code: string;
  message: string;
  /** Defaults to EXIT.RUN_FAILURE. */
  exitCode?: ExitCode;
  /** Bucket recorded in meta.json#failure.kind. Defaults to 'internal'. */
  kind?: RunFailureKind;
  hint?: string;
  /** Subprocess output the caller should retain next to the run (spec §10). */
  log?: string;
  /** Suggested file name for `log`, e.g. "install.log". */
  logName?: string;
  cause?: unknown;
}

export class RunnerError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly kind: RunFailureKind;
  readonly hint: string | undefined;
  readonly log: string | undefined;
  readonly logName: string | undefined;
  /** Set by run.ts when a failed run was still appended to the store. */
  runId: string | undefined;

  constructor(init: RunnerErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'RunnerError';
    this.code = init.code;
    this.exitCode = init.exitCode ?? EXIT.RUN_FAILURE;
    this.kind = init.kind ?? 'internal';
    this.hint = init.hint;
    this.log = init.log;
    this.logName = init.logName;
    this.runId = undefined;
  }

  toCliError(): CliError {
    const err: CliError = { code: this.code, message: this.message, exitCode: this.exitCode };
    if (this.hint !== undefined) err.hint = this.hint;
    return err;
  }

  static is(value: unknown): value is RunnerError {
    return value instanceof RunnerError;
  }
}

/** Narrow an unknown thrown value to a message without losing a RunnerError's code. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function errorStack(value: unknown): string | undefined {
  return value instanceof Error ? value.stack : undefined;
}
