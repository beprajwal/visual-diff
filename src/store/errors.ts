/**
 * store — error type.
 *
 * Every failure the store raises carries a `CliError` payload (spec §10), so `cli/main.ts` can map
 * it straight to an exit code without a translation table.
 */

import { EXIT, type CliError, type ExitCode, type ValidationIssue } from '../types.js';

export class StoreError extends Error implements CliError {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint?: string;
  readonly issues?: ValidationIssue[];

  constructor(
    code: string,
    message: string,
    options: { exitCode?: ExitCode; hint?: string; issues?: ValidationIssue[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StoreError';
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT.RUN_FAILURE;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.issues !== undefined) this.issues = options.issues;
  }

  toCliError(): CliError {
    const out: CliError = { code: this.code, message: this.message, exitCode: this.exitCode };
    if (this.hint !== undefined) out.hint = this.hint;
    if (this.issues !== undefined) out.issues = this.issues;
    return out;
  }
}

/** A config or flow-spec problem: exit 2 (spec §9). */
export function configError(
  code: string,
  message: string,
  options: { hint?: string; issues?: ValidationIssue[] } = {},
): StoreError {
  return new StoreError(code, message, { ...options, exitCode: EXIT.CONFIG_ERROR });
}

export function isStoreError(value: unknown): value is StoreError {
  return value instanceof StoreError;
}

/** Node fs/child_process errors carry a string `code`; narrow without `any`. */
export function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
