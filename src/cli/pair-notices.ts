/**
 * cli — what a selected pair is, said once (mocking spec §6, variants D24, e2e D27, CI spec §6).
 *
 * Three axes can make a pair something other than "this revision versus that revision": the
 * scenario it ran under, whether one side is a variant proposal, and whether one side was ingested
 * rather than replayed. Each has a sentence, each sentence has a severity, and `vdiff diff`,
 * `vdiff comment` and the exported bundle must all say the same one — a pull-request comment that
 * omitted "one side is a mock-only run" would present a fiction as a regression.
 *
 * So the composition lives here and the three surfaces render it. `diff` prints the lines with its
 * `!` markers, the comment quotes them, the bundle stores them in `summary.json`.
 */

import { SCENARIO_NONE, type DiffResult, type PairLabel, type PairScenarios } from '../types.js';
import { classifySourcePair, describeSourcePair, E2E_DEGRADED_SENTENCES } from './e2e.js';
import { classifyVariantPair, describeVariantPair } from './variant.js';

/** The labels this pair carries, in severity order. Empty for a same-scenario pair. */
export function pairLabels(scenarios: PairScenarios | undefined): PairLabel[] {
  if (scenarios === undefined) return [];
  const labels: PairLabel[] = [];
  if (scenarios.mockVsRecorded) labels.push('mock-vs-recorded');
  if (scenarios.crossScenario) labels.push('cross-scenario');
  return labels;
}

export const showScenario = (name: string): string =>
  name === SCENARIO_NONE ? 'no scenario' : name;

/**
 * The sentence each label prints. Both state what the tool does not know rather than refusing the
 * comparison (mocking spec §6): a cross-scenario pair is a legitimate question about two states,
 * and a mock-versus-recorded pair compares a fiction to a measurement.
 */
export function describeLabel(label: PairLabel, scenarios: PairScenarios): string {
  switch (label) {
    case 'cross-scenario':
      return (
        `cross-scenario: base ran '${showScenario(scenarios.base)}', head ran ` +
        `'${showScenario(scenarios.head)}' — this compares two states, not two revisions`
      );
    case 'mock-vs-recorded':
      return (
        'mock-vs-recorded: one side is a mock-only run with no recording behind it — ' +
        'this compares a fiction to a measurement'
      );
  }
}

/** One sentence about the pairing, plus whether it rises to a CLI warning. */
export interface PairNotice {
  /**
   * `true` when this is not the normal case for the pairing it describes and deserves the `!`
   * marker in human output and a place in `warnings`.
   *
   * `variant-proposal` and `e2e-pair` are deliberately unmarked: for a variant run and for an e2e
   * pair, that comparison *is* the question being asked, and a warning on the normal case is how a
   * channel that carries real warnings gets ignored.
   */
  marked: boolean;
  sentence: string;
}

export interface PairNotices {
  /** Every sentence, in the order the surfaces present them: scenario, variant, source. */
  notices: PairNotice[];
  /** Sentences that are also CLI warnings — the marked subset, in the same order. */
  warnings: string[];
  /**
   * The reduced-detail explanation for a pair with an ingested side (e2e §4), spelled out rather
   * than left to be discovered as a disappointment. Empty for a replay-vs-replay pair.
   */
  degraded: string[];
}

/**
 * Compose every sentence a stored diff's pairing deserves.
 *
 * Derived from the two runs' `meta.json` rather than from a field on the stored diff, so a pair
 * computed before variants or e2e mode existed classifies correctly instead of reading as "no
 * variant information".
 */
export function composePairNotices(result: DiffResult): PairNotices {
  const notices: PairNotice[] = [];

  const labels = pairLabels(result.scenarios);
  const scenarios = result.scenarios;
  if (scenarios !== undefined) {
    for (const label of labels) {
      // `mock-vs-recorded` is flagged at high severity (mocking spec §6); `cross-scenario` is a
      // label on a legitimate question and stays out of the warning channel.
      notices.push({ marked: true, sentence: describeLabel(label, scenarios) });
    }
  }

  const variantPair = classifyVariantPair(result.baseMeta, result.headMeta);
  const variantSentence = describeVariantPair(variantPair);
  if (variantSentence !== null) {
    notices.push({
      marked: variantPair.label !== 'variant-proposal',
      sentence: variantSentence,
    });
  }

  const sourcePair = classifySourcePair(result.baseMeta, result.headMeta);
  const sourceSentence = describeSourcePair(sourcePair);
  if (sourceSentence !== null) {
    notices.push({ marked: sourcePair.label === 'e2e-vs-replay', sentence: sourceSentence });
  }

  return {
    notices,
    // `cross-scenario` is in `notices` but not here: promoting it to a warning would train readers
    // to ignore the channel that carries `mock-vs-recorded`.
    warnings: notices
      .filter((notice) => notice.marked && !notice.sentence.startsWith('cross-scenario'))
      .map((notice) => notice.sentence),
    degraded: sourcePair.degraded ? [...E2E_DEGRADED_SENTENCES.slice(1)] : [],
  };
}

/** Every sentence as plain strings — what the comment renderer and `summary.json` take. */
export function pairNoticeSentences(result: DiffResult): string[] {
  const composed = composePairNotices(result);
  return [...composed.notices.map((notice) => notice.sentence), ...composed.degraded];
}
