/**
 * Typed variant-spec failure (variants spec §7).
 *
 * "Exit 2, with file, line and offending key." The variant module never calls `process.exit`; it
 * throws a `VariantSpecError` carrying every issue, and the CLI maps `exitCode` to the process exit
 * code — structurally, via `isCliErrorLike`, without importing anything from this module. This is
 * `ScenarioSpecError` with the nouns changed, deliberately: two spec formats that fail differently
 * would be two things for an agent to learn.
 *
 * `code` is `variant-invalid` when there is no issue to take a code from, matching the shape of the
 * `scenario-invalid` run-failure kind.
 */

import { formatIssues } from '../scenario/index.js';
import { EXIT, type CliError, type ValidationIssue, type ValidationResult } from '../types.js';

export class VariantSpecError extends Error {
  /** Machine code of the first issue, or `variant-invalid` when there is none. */
  readonly code: string;
  /** Always `EXIT.CONFIG_ERROR` (2) — a spec problem is never a run failure. */
  readonly exitCode = EXIT.CONFIG_ERROR;
  readonly file: string;
  readonly issues: ValidationIssue[];
  readonly hint: string | undefined;

  constructor(file: string, issues: readonly ValidationIssue[], hint?: string) {
    super(buildMessage(file, issues));
    this.name = 'VariantSpecError';
    this.file = file;
    this.issues = [...issues];
    this.code = issues[0]?.code ?? 'variant-invalid';
    this.hint = hint;
  }

  /** The CLI edge shape (`CliEnvelope.error`). */
  toCliError(): CliError {
    const error: CliError = {
      code: this.code,
      message: this.message,
      exitCode: this.exitCode,
      issues: this.issues,
    };
    if (this.hint !== undefined) error.hint = this.hint;
    return error;
  }

  /** Returns the value of a successful result, throwing for a failed one. */
  static unwrap<T>(file: string, result: ValidationResult<T>, hint?: string): T {
    if (result.ok) return result.value;
    throw new VariantSpecError(file, result.issues, hint);
  }
}

export function isVariantSpecError(error: unknown): error is VariantSpecError {
  return error instanceof VariantSpecError;
}

function buildMessage(file: string, issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) return `invalid variant spec: ${file}`;
  const head =
    issues.length === 1
      ? `invalid variant spec: ${file}`
      : `invalid variant spec: ${file} (${issues.length} problems)`;
  return `${head}\n${formatIssues(issues)}`;
}
