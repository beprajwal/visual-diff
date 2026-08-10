/**
 * How the two runs of a diff relate on the scenario and variant axes (mocking spec §6, variants §5).
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
 *
 * ### The variant axis, and why it is not a copy of the scenario one
 *
 * The variants spec deliberately breaks the symmetry (§5, D24). For a scenario the question is
 * regression — same scenario, two revisions — so *different scenarios* is the thing worth
 * labelling. For a variant the question is the proposal itself: **same revision, variant versus
 * none**. Applying the scenario rule unchanged would label precisely the comparison the user asked
 * for, and a warning printed on the one intended use of a feature trains people to ignore warnings.
 *
 * So the variant axis has one label with a hole cut in it:
 *
 * | pair | behaviour |
 * |---|---|
 * | same variant | the regression question on this axis, including two runs of a promoted variant — no flag |
 * | one side varied, same revision | **the proposal question** — recorded as `proposal`, no flag |
 * | any other crossing | permitted, labelled `cross-variant` |
 *
 * That last row is what catches the genuinely misleading pairs: two different proposals compared
 * against each other, and a proposal compared against the unmodified page *at another revision*,
 * where every difference is the sum of the proposal and the intervening code change and nothing
 * separates the two.
 *
 * ### The source axis, which is the scenario shape again rather than the variant one
 *
 * E2E adds a third axis: was each side captured by `vdiff run`, or ingested from a Playwright trace
 * (e2e spec §7, D27)? Here the scenario reasoning applies unchanged, because the question is the
 * same one: like-for-like is the regression question, and mixing the two capture paths compares a
 * trace's lossy, viewport-only, JPEG screencast frame against vdiff's own PNG under a frozen clock.
 *
 * | pair | behaviour |
 * |---|---|
 * | e2e vs e2e | the regression question on this axis, and the default pairing — no flag |
 * | replay vs replay | every pre-e2e pair — no flag |
 * | e2e vs replay | permitted, flagged `e2e-vs-replay` at **high** severity, "exactly as mock-versus-recorded is" (D27) |
 *
 * There is deliberately **no flag on an e2e/e2e pair**, which is the D24 lesson carried over: a
 * warning printed on the intended use of a feature teaches people to stop reading warnings. What an
 * e2e pair carries instead is {@link PairFidelity} — structured, unmissable, and not a warning.
 */

import {
  PAIR_LABELS,
  SCENARIO_NONE,
  type DiffResult,
  type PairLabel,
  type PairScenarios,
  type RunMeta,
  type Severity,
} from '../types.js';
import { scenarioOf } from '../store/internal/scenario.js';
import {
  VARIANT_NONE,
  describeRevision,
  describeVariant,
  sameRevision,
  variantOf,
} from '../store/internal/variant.js';
import type { VariantName } from '../store/internal/variant.js';
import { SOURCE_E2E, SOURCE_REPLAY, describeSource, sourceOf } from '../store/internal/e2e.js';
import type { MaybeE2e, RunSource } from '../store/internal/e2e.js';
import { fidelityOf } from './fidelity.js';
import type { PairFidelity } from './fidelity.js';

/**
 * Machine codes for the pairings the variant axis permits but refuses to let pass as ordinary
 * regressions. One code, because the proposal pair — the reason the feature exists — is explicitly
 * *not* one of them (variants spec §5, D24).
 */
export const VARIANT_PAIR_LABELS = ['cross-variant'] as const;
export type VariantPairLabel = (typeof VARIANT_PAIR_LABELS)[number];

/**
 * Machine codes for the pairings the source axis permits but refuses to let pass as ordinary
 * regressions (e2e spec §7, D27). One code: e2e-versus-e2e and replay-versus-replay are both the
 * regression question, one on each timeline.
 */
export const SOURCE_PAIR_LABELS = ['e2e-vs-replay'] as const;
export type SourcePairLabel = (typeof SOURCE_PAIR_LABELS)[number];

/** Every label a pair can carry, across all three identity axes. */
export type AnyPairLabel = PairLabel | VariantPairLabel | SourcePairLabel;

/**
 * How the two paired runs relate on the variant axis (variants spec §5).
 *
 * `proposal` is the positive statement the report needs and the scenario axis has no equivalent of:
 * this pair *is* the question "how would this rearrangement look", answered against the same code.
 * It is recorded rather than warned about, so the report can title the comparison correctly while
 * the warning list stays empty.
 */
export interface PairVariants {
  /** The variant each side ran, `VARIANT_NONE` when it ran none. */
  base: VariantName;
  head: VariantName;
  /** One side varied, the other not, at the same revision — the proposal question (D24). */
  proposal: boolean;
  /** The variants differ and the pair is not the proposal question. */
  crossVariant: boolean;
}

/**
 * The variant identity of a pair neither side of which ran a variant — every pre-variants pair, and
 * the default every entry point falls back to when a caller has nothing to say about variants.
 */
export const VARIANTLESS_PAIR: PairVariants = {
  base: VARIANT_NONE,
  head: VARIANT_NONE,
  proposal: false,
  crossVariant: false,
};

/**
 * How the two paired runs relate on the source axis (e2e spec §7, D27).
 *
 * `fidelity` sits here rather than being derived per consumer because it is a property of the
 * *pair*: an e2e/e2e pair is on its own timeline and perfectly comparable, and still cannot produce
 * a property-level finding, so "which runs were compared" and "what the comparison could see" are
 * two different questions with one answer between them (e2e spec §4).
 */
export interface PairSources {
  /** The source each side came from, `replay` when the run predates the axis. */
  base: RunSource;
  head: RunSource;
  /** Exactly one side was ingested: two capture paths, flagged `e2e-vs-replay` at high severity. */
  crossSource: boolean;
  /** What the layered diff could actually run for this pair. */
  fidelity: PairFidelity;
}

/**
 * The source identity of a pair neither side of which was ingested — every pre-e2e pair, and the
 * default every entry point falls back to when a caller has nothing to say about sources.
 */
export const REPLAY_PAIR: PairSources = {
  base: SOURCE_REPLAY,
  head: SOURCE_REPLAY,
  crossSource: false,
  fidelity: fidelityOf(SOURCE_REPLAY, SOURCE_REPLAY),
};

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
export const PAIR_LABEL_SEVERITY: Record<AnyPairLabel, Severity> = {
  'cross-scenario': 'med',
  'mock-vs-recorded': 'high',
  // Same reasoning as `cross-scenario`, one axis over: both sides are real captures of something,
  // the comparison is deliberate, and reading it as a regression would be wrong.
  'cross-variant': 'med',
  // **high**, and for the same reason `mock-vs-recorded` is: the two sides were produced by
  // different machinery. A trace frame is a lossy JPEG, viewport-only, downscaled to fit 800×800
  // with the device scale factor discarded, taken by a throttled screencast near — not at — the
  // step boundary; a replay shot is a full PNG at a known scale under a frozen clock. Every
  // difference between the two is of unknown provenance (e2e spec §4, D27).
  'e2e-vs-replay': 'high',
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

/**
 * Variant labelling for a pair.
 *
 * The hole in `crossVariant` is the whole decision: a variant paired against the unmodified page at
 * its own revision is the proposal question and carries no flag, because warning about it would be
 * warning about the only comparison the feature was built to produce (D24). `sameRevision` is what
 * decides "its own revision", so a dirty tree only matches a baseline of the same dirty tree.
 */
export function pairVariants(base: RunMeta, head: RunMeta): PairVariants {
  const baseVariant = variantOf(base);
  const headVariant = variantOf(head);
  if (baseVariant === headVariant) {
    return { base: baseVariant, head: headVariant, proposal: false, crossVariant: false };
  }
  const oneSideUnvaried = baseVariant === VARIANT_NONE || headVariant === VARIANT_NONE;
  const proposal = oneSideUnvaried && sameRevision(base.revision, head.revision);
  return { base: baseVariant, head: headVariant, proposal, crossVariant: !proposal };
}

/**
 * Source labelling for a pair.
 *
 * Deliberately the plain "do the two sides differ" rule of the scenario axis, not the variant
 * axis's rule with a hole in it: unlike a proposal, a cross-source pair is never the question the
 * user meant to ask, so there is nothing to exempt.
 */
export function pairSources(base: MaybeE2e, head: MaybeE2e): PairSources {
  const baseSource = sourceOf(base);
  const headSource = sourceOf(head);
  return {
    base: baseSource,
    head: headSource,
    crossSource: baseSource !== headSource,
    fidelity: fidelityOf(baseSource, headSource),
  };
}

/** One label that applies to a pair, with the severity and the sentence that carry it. */
export interface PairFlag {
  label: AnyPairLabel;
  severity: Severity;
  message: string;
}

export interface PairLabelling {
  scenarios: PairScenarios;
  variants: PairVariants;
  sources: PairSources;
  /**
   * Empty for a same-scenario, same-fidelity, same-variant, same-source pair — the ordinary
   * regression question — and equally empty for the proposal pair, which is the ordinary *variant*
   * question, and for an e2e/e2e pair, which is the ordinary question on its own timeline.
   */
  flags: PairFlag[];
}

function describeScenario(name: string): string {
  return name === SCENARIO_NONE ? 'no scenario' : `scenario '${name}'`;
}

/** Identity labelling plus the messages that go into `findings.json`, the CLI and the report. */
export function labelPair(base: RunMeta, head: RunMeta): PairLabelling {
  const scenarios = pairScenarios(base, head);
  const variants = pairVariants(base, head);
  const sources = pairSources(base, head);
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

  if (variants.crossVariant) {
    flags.push({
      label: 'cross-variant',
      severity: PAIR_LABEL_SEVERITY['cross-variant'],
      message: crossVariantMessage(base, head, variants),
    });
  }

  if (sources.crossSource) {
    const ingested = sources.head === SOURCE_E2E ? head : base;
    const captured = sources.head === SOURCE_E2E ? base : head;
    flags.push({
      label: 'e2e-vs-replay',
      severity: PAIR_LABEL_SEVERITY['e2e-vs-replay'],
      message:
        `e2e-vs-replay pair: run ${ingested.runId} is ${describeSource(SOURCE_E2E)} while run ` +
        `${captured.runId} is ${describeSource(SOURCE_REPLAY)} — two capture paths, so a ` +
        'difference between them may be the application or may be the machinery that recorded it',
    });
  }

  return { scenarios, variants, sources, flags };
}

/**
 * Two different crossings, two different sentences, because the reader has to do two different
 * things about them.
 *
 * Two proposals against each other is a real comparison of two designs and needs only to be told
 * apart from a regression. A proposal against a *different revision* is the dangerous one: the
 * differences are the proposal plus whatever the code did in between, mixed together with nothing
 * to separate them, so the message names both revisions and says what the pair is missing.
 */
function crossVariantMessage(base: RunMeta, head: RunMeta, variants: PairVariants): string {
  const bothVaried = variants.base !== VARIANT_NONE && variants.head !== VARIANT_NONE;
  if (bothVaried) {
    return (
      `cross-variant pair: base run ${base.runId} ran ${describeVariant(variants.base)}, ` +
      `head run ${head.runId} ran ${describeVariant(variants.head)} — ` +
      'this compares two proposals, not two revisions'
    );
  }
  return (
    `cross-variant pair: base run ${base.runId} ran ${describeVariant(variants.base)} at revision ` +
    `${describeRevision(base.revision)}, head run ${head.runId} ran ${describeVariant(variants.head)} ` +
    `at revision ${describeRevision(head.revision)} — a proposal compared against a different ` +
    'revision, not against the unmodified page it was proposed on'
  );
}

/** The labels that apply to a pair, in `PAIR_LABELS` order. */
export function pairLabels(scenarios: PairScenarios): PairLabel[] {
  const applies: Record<PairLabel, boolean> = {
    'cross-scenario': scenarios.crossScenario,
    'mock-vs-recorded': scenarios.mockVsRecorded,
  };
  return PAIR_LABELS.filter((label) => applies[label]);
}

/** The variant-axis labels that apply to a pair, in `VARIANT_PAIR_LABELS` order. */
export function variantPairLabels(variants: PairVariants): VariantPairLabel[] {
  const applies: Record<VariantPairLabel, boolean> = { 'cross-variant': variants.crossVariant };
  return VARIANT_PAIR_LABELS.filter((label) => applies[label]);
}

/** The source-axis labels that apply to a pair, in `SOURCE_PAIR_LABELS` order. */
export function sourcePairLabels(sources: PairSources): SourcePairLabel[] {
  const applies: Record<SourcePairLabel, boolean> = { 'e2e-vs-replay': sources.crossSource };
  return SOURCE_PAIR_LABELS.filter((label) => applies[label]);
}

/**
 * `DiffResult` with the variant block this slice adds.
 *
 * Structural, for the reason given in `store/internal/variant`: `src/types.ts` does not yet carry
 * the variant axis, and every consumer that only knows `DiffResult` keeps working because the block
 * is additive. `findings.json` is written by serializing the whole object, so it survives the round
 * trip untouched.
 */
export type VariantAwareDiffResult = DiffResult & { variants?: PairVariants };

/**
 * `DiffResult` with the source block this slice adds, on the same terms as the variant one:
 * additive, structural, and written straight through `findings.json` by serialization.
 *
 * `sources.fidelity` is what §4 means by "`findings.json` marks these runs so the report can
 * explain the reduced detail rather than appear to have missed something". Absent on every diff
 * stored before this slice, which were replay pairs by construction.
 */
export type SourceAwareDiffResult = VariantAwareDiffResult & { sources?: PairSources };
