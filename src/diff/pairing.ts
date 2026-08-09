/**
 * How the two runs of a diff relate on the scenario axis (mocking spec §6).
 *
 * Scenario is a dimension of *which* runs are compared, never of what a finding looks like: nothing
 * below changes a region, an attribution or a severity heuristic. What it does is state, on the
 * result itself, the two comparisons the tool permits but refuses to let pass as ordinary
 * regressions:
 *
 * | pair | behaviour |
 * |---|---|
 * | same scenario | the default and the regression question — neither flag |
 * | different scenarios | permitted, labelled `cross-scenario`: it compares two states, not two revisions |
 * | mock-only vs recorded | permitted, flagged `mock-vs-recorded` at high severity, both runs badged |
 *
 * The principle is the one behind `unstable` runs (spec §7): state what the tool does not know
 * rather than let the reader assume it. A cross-scenario diff of the empty state against the full
 * state will be full of findings, every one of them real and none of them a regression.
 */

import { PAIR_LABELS, SCENARIO_NONE, type PairLabel, type PairScenarios, type RunMeta, type Severity } from '../types.js';
import { scenarioOf } from '../store/internal/scenario.js';

/**
 * Severity per label, so the CLI, the report and this module cannot disagree about how loud each
 * one is.
 *
 * `mock-vs-recorded` is **high** because it compares a fiction against a measurement: the mock side
 * is only as faithful as the scenario that invented it, so every difference between the two runs is
 * of unknown provenance (mocking spec §6, D13). `cross-scenario` is **med**: the comparison is
 * deliberate and both sides are real captures, but the diff answers a different question than the
 * one the tool is usually asked, and reading it as a regression would be wrong.
 */
export const PAIR_LABEL_SEVERITY: Record<PairLabel, Severity> = {
  'cross-scenario': 'med',
  'mock-vs-recorded': 'high',
};

/** A run whose responses came entirely from a scenario, with no recording behind them (D13). */
export function isMockOnly(meta: Pick<RunMeta, 'network'>): boolean {
  return meta.network === 'mock';
}

/**
 * Scenario labelling for a pair.
 *
 * `mockVsRecorded` is decided by the network mode, not by the scenario name: a mock-only run is one
 * that ran with `network: mock`, and two mock-only runs of the same scenario are as comparable as
 * any other like-for-like pair — both are fictions produced by the same rules.
 */
export function pairScenarios(base: RunMeta, head: RunMeta): PairScenarios {
  return {
    base: scenarioOf(base),
    head: scenarioOf(head),
    crossScenario: scenarioOf(base) !== scenarioOf(head),
    mockVsRecorded: isMockOnly(base) !== isMockOnly(head),
  };
}

/** One label that applies to a pair, with the severity and the sentence that carry it. */
export interface PairFlag {
  label: PairLabel;
  severity: Severity;
  message: string;
}

export interface PairLabelling {
  scenarios: PairScenarios;
  /** Empty for a same-scenario, same-fidelity pair — the ordinary regression question. */
  flags: PairFlag[];
}

function describeScenario(name: string): string {
  return name === SCENARIO_NONE ? 'no scenario' : `scenario '${name}'`;
}

/** Scenario labelling plus the messages that go into `findings.json`, the CLI and the report. */
export function labelPair(base: RunMeta, head: RunMeta): PairLabelling {
  const scenarios = pairScenarios(base, head);
  const flags: PairFlag[] = [];

  if (scenarios.crossScenario) {
    flags.push({
      label: 'cross-scenario',
      severity: PAIR_LABEL_SEVERITY['cross-scenario'],
      message:
        `cross-scenario pair: base run ${base.runId} ran ${describeScenario(scenarios.base)}, ` +
        `head run ${head.runId} ran ${describeScenario(scenarios.head)} — ` +
        'this compares two states, not two revisions',
    });
  }

  if (scenarios.mockVsRecorded) {
    const mock = isMockOnly(head) ? head : base;
    const recorded = isMockOnly(head) ? base : head;
    flags.push({
      label: 'mock-vs-recorded',
      severity: PAIR_LABEL_SEVERITY['mock-vs-recorded'],
      message:
        `mock-vs-recorded pair: run ${mock.runId} is mock-only (${describeScenario(scenarioOf(mock))}) ` +
        `while run ${recorded.runId} ran against a recording — ` +
        'a fiction compared against a measurement',
    });
  }

  return { scenarios, flags };
}

/** The labels that apply to a pair, in `PAIR_LABELS` order. */
export function pairLabels(scenarios: PairScenarios): PairLabel[] {
  const applies: Record<PairLabel, boolean> = {
    'cross-scenario': scenarios.crossScenario,
    'mock-vs-recorded': scenarios.mockVsRecorded,
  };
  return PAIR_LABELS.filter((label) => applies[label]);
}
