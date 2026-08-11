/**
 * ci/gate — the opt-in threshold (CI spec D30).
 *
 * `vdiff diff` exits 0 with findings and always will: findings are information, not a gate (spec
 * §9). A pull-request job sometimes wants the other thing, so this is where "sometimes" is spelled
 * out — as a level nobody gets by default, evaluated in one pure function, reported as a verdict
 * with the sentence that explains it.
 *
 * The tripped exit code is 3, not 1. Everywhere else in this CLI exit 1 means "the run or replay
 * failed", and a button that moved four pixels is not a broken run; a consumer that cannot tell the
 * two apart has to treat every UI change as an infrastructure failure or every infrastructure
 * failure as a UI change.
 */

import type { DiffSummary } from '../types.js';

export const GATE_LEVELS = ['none', 'high', 'any'] as const;
export type GateLevel = (typeof GATE_LEVELS)[number];

/** The default, and the one this tool ships pointing at: never gate. */
export const GATE_NONE: GateLevel = 'none';

export function isGateLevel(value: string): value is GateLevel {
  return (GATE_LEVELS as readonly string[]).includes(value);
}

export interface GateVerdict {
  level: GateLevel;
  tripped: boolean;
  /**
   * Why it tripped, or why it could not. Never null: a verdict that says "false" and nothing else
   * is indistinguishable from a gate that was never evaluated, and both appear in `--json`.
   */
  reason: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Evaluate one level against a stored diff's summary.
 *
 * `high` counts only high-severity findings; `any` counts every finding, including the collapsed
 * "N smaller changes" entry, because that entry *is* one finding as far as the summary is concerned
 * and inventing a second rule here would make the number in the comment disagree with the gate.
 */
export function evaluateGate(summary: DiffSummary, level: GateLevel = GATE_NONE): GateVerdict {
  if (level === 'none') {
    return {
      level,
      tripped: false,
      reason: 'no gate: findings are reported, never enforced',
    };
  }

  if (level === 'high') {
    const high = summary.bySeverity.high;
    return {
      level,
      tripped: high > 0,
      reason:
        high > 0
          ? `${plural(high, 'high-severity finding')} (gate: high)`
          : 'no high-severity findings (gate: high)',
    };
  }

  const total = summary.totalFindings;
  return {
    level,
    tripped: total > 0,
    reason: total > 0 ? `${plural(total, 'finding')} (gate: any)` : 'no findings (gate: any)',
  };
}
