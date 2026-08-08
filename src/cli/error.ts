/**
 * cli — failures and their exit codes (spec §9, §10).
 *
 * Exit codes are a published contract: `0` success, `1` run or replay failure, `2` config or spec
 * error. Every module raises an error object that carries a `CliError` payload; this file is the
 * one place that turns *anything* thrown into that payload, so `main.ts` can map it to an exit
 * code without a translation table.
 *
 * Sibling modules (store, flow, runner, …) define their own error classes rather than importing
 * one from the CLI — the CLI sits at the top of the dependency graph, nothing may depend on it.
 * `toCliError` therefore recognises them structurally: any thrown value carrying a string `code`,
 * a string `message` and a valid `exitCode` is already a CLI error and is passed through intact.
 */

import { EXIT, type CliError, type ExitCode, type ValidationIssue } from '../types.js';

export interface CliFailureInit {
  code: string;
  message: string;
  exitCode: ExitCode;
  hint?: string;
  issues?: ValidationIssue[];
  cause?: unknown;
}

/** A failure raised by the CLI layer itself: a bad argument, a missing scaffold, a refused write. */
export class CliFailure extends Error implements CliError {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint?: string;
  readonly issues?: ValidationIssue[];

  constructor(init: CliFailureInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'CliFailure';
    this.code = init.code;
    this.exitCode = init.exitCode;
    if (init.hint !== undefined) this.hint = init.hint;
    if (init.issues !== undefined) this.issues = init.issues;
  }

  toCliError(): CliError {
    const out: CliError = { code: this.code, message: this.message, exitCode: this.exitCode };
    if (this.issues !== undefined) out.issues = this.issues;
    if (this.hint !== undefined) out.hint = this.hint;
    return out;
  }
}

/** Config or spec problem — exit 2. */
export function configError(
  code: string,
  message: string,
  options: { hint?: string; issues?: ValidationIssue[]; cause?: unknown } = {},
): CliFailure {
  return new CliFailure({ ...options, code, message, exitCode: EXIT.CONFIG_ERROR });
}

/** Run or replay problem — exit 1. */
export function runFailure(
  code: string,
  message: string,
  options: { hint?: string; issues?: ValidationIssue[]; cause?: unknown } = {},
): CliFailure {
  return new CliFailure({ ...options, code, message, exitCode: EXIT.RUN_FAILURE });
}

function isExitCode(value: unknown): value is ExitCode {
  return value === EXIT.OK || value === EXIT.RUN_FAILURE || value === EXIT.CONFIG_ERROR;
}

/**
 * True when a thrown value already carries a CLI error payload. Structural on purpose: it must
 * recognise `StoreError`, `VdiffError` and every other module's error class without importing
 * them, because nothing may depend on the CLI and the CLI must not depend on error internals.
 */
export function isCliErrorLike(value: unknown): value is CliError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown; exitCode?: unknown };
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    isExitCode(candidate.exitCode)
  );
}

/** Normalise anything thrown into the payload the `--json` envelope and the exit code need. */
export function toCliError(value: unknown): CliError {
  if (value instanceof CliFailure) return value.toCliError();

  if (isCliErrorLike(value)) {
    const source = value as CliError & { hint?: unknown; issues?: unknown };
    const out: CliError = {
      code: source.code,
      message: source.message,
      exitCode: source.exitCode,
    };
    if (Array.isArray(source.issues)) out.issues = source.issues as ValidationIssue[];
    if (typeof source.hint === 'string') out.hint = source.hint;
    return out;
  }

  const message = value instanceof Error ? value.message : String(value);
  return { code: 'internal', message, exitCode: EXIT.RUN_FAILURE };
}
