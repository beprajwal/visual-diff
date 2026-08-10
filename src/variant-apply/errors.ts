/**
 * Typed variant failures (variants spec §7).
 *
 * Modelled on `mocking/errors.ts#ScenarioError`, deliberately and line for line, because the two
 * subsystems answer the same question in the same shape: **which rule is responsible**. An
 * unattributed "clone failed" leaves the user grepping a YAML file for which of six rules touches
 * that selector.
 *
 * §7 splits the same two ways mocking's §8 does:
 *
 * - **spec problems** (`variant-invalid`, exit 2) — a rule carrying two verbs or none, `times` below
 *   1. Validation should have rejected these before the run started; reaching application means
 *   something bypassed the validator, and inventing a precedence order between two verbs would be
 *   worse than refusing to start.
 * - **run failures** (`variant-failed`, exit 1) — a clone whose source matched no element, or whose
 *   source was never resolved. Each names the rule.
 *
 * `kind` is a local union rather than `RunFailureKind` because the two buckets below are this
 * subsystem's additions to that type; the runner maps them across, as it does for scenarios.
 */

import { EXIT, type CliError, type ExitCode } from '../types.js';

export type VariantErrorCode =
  /** A rule reached application carrying no verb at all (§4, "exactly one verb per rule"). */
  | 'variant-rule-no-verb'
  /** A rule reached application carrying two verbs; §4 makes that a validation error. */
  | 'variant-rule-two-verbs'
  /** A non-clone rule reached application with no `match` (§7). */
  | 'variant-rule-no-match'
  /** `clone.times` below 1 (§7). */
  | 'variant-clone-times'
  /** A clone rule was applied without its source having been extracted first (D23). */
  | 'variant-clone-source-missing'
  /** The clone source selector matched no element in the source page (§7). */
  | 'variant-clone-source-empty';

/** The two `RunFailureKind` buckets this subsystem contributes, mirroring the scenario pair. */
export type VariantFailureKind = 'variant-invalid' | 'variant-failed';

export interface VariantErrorInit {
  code: VariantErrorCode;
  message: string;
  variant: string;
  ruleId?: string;
  hint?: string;
  exitCode?: ExitCode;
  kind?: VariantFailureKind;
}

export class VariantError extends Error {
  readonly code: VariantErrorCode;
  readonly exitCode: ExitCode;
  readonly kind: VariantFailureKind;
  readonly variant: string;
  readonly ruleId: string | undefined;
  readonly hint: string | undefined;

  constructor(init: VariantErrorInit) {
    super(init.message);
    this.name = 'VariantError';
    this.code = init.code;
    this.exitCode = init.exitCode ?? EXIT.RUN_FAILURE;
    this.kind = init.kind ?? 'variant-failed';
    this.variant = init.variant;
    this.ruleId = init.ruleId;
    this.hint = init.hint;
  }

  toCliError(): CliError {
    const error: CliError = { code: this.code, message: this.message, exitCode: this.exitCode };
    if (this.hint !== undefined) error.hint = this.hint;
    return error;
  }

  static is(value: unknown): value is VariantError {
    return value instanceof VariantError;
  }
}

/** `variant 'denser-forecast' rule 'tighter-cards'` — the prefix every variant failure opens with. */
export function variantRuleLabel(variant: string, ruleId: string): string {
  return `variant '${variant}' rule '${ruleId}'`;
}
