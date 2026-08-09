/**
 * Typed scenario-spec failure (mocking spec §8).
 *
 * "Exit 2, with file, line and offending key." The scenario module never calls `process.exit`; it
 * throws a `ScenarioSpecError` carrying every issue, and the CLI maps `exitCode` to the process
 * exit code — structurally, via `isCliErrorLike`, without importing anything from this module.
 *
 * `code` is `scenario-invalid` when there is no issue to take a code from, which is the
 * `RunFailureKind` the mocking spec names for a scenario that failed validation.
 */

import { EXIT, type CliError, type ValidationIssue, type ValidationResult } from '../types.js';

/** `empty-forecast.yaml:12:5: unknown key 'patchOp' [unknown-rule-key] (rules[1].patchOp)` */
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

export class ScenarioSpecError extends Error {
  /** Machine code of the first issue, or `scenario-invalid` when there is none. */
  readonly code: string;
  /** Always `EXIT.CONFIG_ERROR` (2) — a spec problem is never a run failure. */
  readonly exitCode = EXIT.CONFIG_ERROR;
  readonly file: string;
  readonly issues: ValidationIssue[];
  readonly hint: string | undefined;

  constructor(file: string, issues: readonly ValidationIssue[], hint?: string) {
    super(buildMessage(file, issues));
    this.name = 'ScenarioSpecError';
    this.file = file;
    this.issues = [...issues];
    this.code = issues[0]?.code ?? 'scenario-invalid';
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
    throw new ScenarioSpecError(file, result.issues, hint);
  }
}

export function isScenarioSpecError(error: unknown): error is ScenarioSpecError {
  return error instanceof ScenarioSpecError;
}

function buildMessage(file: string, issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) return `invalid scenario spec: ${file}`;
  const head =
    issues.length === 1
      ? `invalid scenario spec: ${file}`
      : `invalid scenario spec: ${file} (${issues.length} problems)`;
  return `${head}\n${formatIssues(issues)}`;
}
