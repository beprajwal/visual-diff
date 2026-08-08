/**
 * Typed spec failure (spec §10, row 1).
 *
 * "Config or spec invalid → Exit 2 with file, line, and offending key." The flow module never calls
 * `process.exit`; it throws a `SpecError` carrying every issue, and the CLI maps `exitCode` onto the
 * process exit code via `EXIT.CONFIG_ERROR`.
 */

import { EXIT, type CliError, type ValidationIssue, type ValidationResult } from '../types.js';

/** `checkout.yaml:12:5: unknown step verb 'blink' [unknown-verb] (steps[2].blink)` */
export function formatIssue(issue: ValidationIssue): string {
  const { file, line, column, key } = issue.at;
  let where = file;
  if (line !== undefined) {
    where += `:${line}`;
    if (column !== undefined) where += `:${column}`;
  }
  const at = key ? ` (${key})` : '';
  return `${where}: ${issue.message} [${issue.code}]${at}`;
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map(formatIssue).join('\n');
}

export class SpecError extends Error {
  /** Machine code of the first issue, or `spec-invalid` when there is none. */
  readonly code: string;
  /** Always `EXIT.CONFIG_ERROR` (2) — a spec problem is never a run failure. */
  readonly exitCode = EXIT.CONFIG_ERROR;
  readonly file: string;
  readonly issues: ValidationIssue[];
  readonly hint: string | undefined;

  constructor(file: string, issues: readonly ValidationIssue[], hint?: string) {
    super(buildMessage(file, issues));
    this.name = 'SpecError';
    this.file = file;
    this.issues = [...issues];
    this.code = issues[0]?.code ?? 'spec-invalid';
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

  /** Returns the value of a successful result, throwing a `SpecError` for a failed one. */
  static unwrap<T>(file: string, result: ValidationResult<T>, hint?: string): T {
    if (result.ok) return result.value;
    throw new SpecError(file, result.issues, hint);
  }
}

export function isSpecError(error: unknown): error is SpecError {
  return error instanceof SpecError;
}

function buildMessage(file: string, issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) return `invalid flow spec: ${file}`;
  const head =
    issues.length === 1
      ? `invalid flow spec: ${file}`
      : `invalid flow spec: ${file} (${issues.length} problems)`;
  return `${head}\n${formatIssues(issues)}`;
}
