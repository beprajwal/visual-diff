/**
 * Typed scenario failures (mocking spec §8).
 *
 * §8 splits into two tables and this class carries both, distinguished by `exitCode`/`kind`:
 *
 * - **spec problems** (`scenario-invalid`, exit 2) — an unparseable glob that reached the engine.
 *   Validation should have caught it first; the engine refuses to start rather than treat a broken
 *   pattern as one that matches nothing, because "matches nothing" is the exact failure mode the
 *   never-matched warning exists to make impossible.
 * - **run failures** (`scenario-failed`, exit 1) — a rule that matched a request with no recorded
 *   response, or patched a non-JSON body. Each **names the responsible rule**, which §8 requires:
 *   an unattributed "patch failed" leaves the user grepping a YAML file for which of six rules
 *   touched that URL.
 *
 * The class is local to this module rather than reusing `runner/errors.ts` so the overlay engine
 * stays free of the runner; the fields line up with `RunnerErrorInit`, so the runner re-throws it
 * as a `RunnerError` with no translation table.
 */

import { EXIT, type CliError, type ExitCode, type RunFailureKind } from '../types.js';

export type ScenarioErrorCode =
  /** A rule's `match.url` glob does not compile (§8, "unparseable glob"). */
  | 'scenario-invalid-glob'
  /** A `patch`/`patchOps` rule matched a request the recording has no response for (§8). */
  | 'scenario-no-recorded-response'
  /** The recorded response exists but carries no body to patch. */
  | 'scenario-empty-recorded-body'
  /** `patch`/`patchOps` against a non-JSON content type (§8). */
  | 'scenario-patch-non-json'
  /** The content type claims JSON but the recorded bytes do not parse. */
  | 'scenario-unparseable-body'
  /** An RFC 6902 operation could not be applied to this body. */
  | 'scenario-patch-op-failed'
  /** `patch`/`patchOps` reached run time in `mock` mode, which validation should have rejected. */
  | 'scenario-patch-in-mock';

export interface ScenarioErrorInit {
  code: ScenarioErrorCode;
  message: string;
  scenario: string;
  ruleId?: string;
  url?: string;
  hint?: string;
  exitCode?: ExitCode;
  kind?: RunFailureKind;
}

export class ScenarioError extends Error {
  readonly code: ScenarioErrorCode;
  readonly exitCode: ExitCode;
  /** Bucket recorded in `meta.json#failure.kind`. */
  readonly kind: RunFailureKind;
  readonly scenario: string;
  readonly ruleId: string | undefined;
  readonly url: string | undefined;
  readonly hint: string | undefined;

  constructor(init: ScenarioErrorInit) {
    super(init.message);
    this.name = 'ScenarioError';
    this.code = init.code;
    this.exitCode = init.exitCode ?? EXIT.RUN_FAILURE;
    this.kind = init.kind ?? 'scenario-failed';
    this.scenario = init.scenario;
    this.ruleId = init.ruleId;
    this.url = init.url;
    this.hint = init.hint;
  }

  toCliError(): CliError {
    const error: CliError = { code: this.code, message: this.message, exitCode: this.exitCode };
    if (this.hint !== undefined) error.hint = this.hint;
    return error;
  }

  static is(value: unknown): value is ScenarioError {
    return value instanceof ScenarioError;
  }
}

/** `scenario 'empty-forecast' rule 'forecast-empty'` — the prefix every run failure opens with. */
export function ruleLabel(scenario: string, ruleId: string): string {
  return `scenario '${scenario}' rule '${ruleId}'`;
}
