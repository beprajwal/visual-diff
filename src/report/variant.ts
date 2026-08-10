/**
 * Variant attribution, as the report consumes it (variants spec §7).
 *
 * The runner writes `variant.json` next to the run: the proposal that was applied, one row per rule
 * with what it matched and whether it was still in force at capture, and one record per *element*
 * a rule changed — `{ variant, ruleId, verb }`, plus the step, the viewport and the node path.
 *
 * That is a per-element record, and one `style` rule can touch forty cards; rendering it raw would
 * bury the sentence that matters — "element modified by `denser-forecast` rule `tighter-cards`" —
 * under thirty-nine repetitions of itself. So this module does exactly what `attribution.ts` does
 * one axis over, and nothing else:
 *
 *  1. {@link summarizeVariantRun} folds the elements into one row per `(step, rule)`, counting the
 *     elements each accounted for and the viewports they were seen in. Pure, so it is unit-tested
 *     rather than eyeballed in a browser.
 *  2. {@link describeVariantHit} turns one of those rows into the sentence the report prints.
 *
 * What is deliberately *not* here: rules that matched nothing, and rules whose effect the
 * application re-rendered away before capture (D22). Those are properties of the whole run rather
 * than of a step, they are already run warnings carrying the offending rule ids, and the report
 * shows them in the warnings rail. Repeating them as a step annotation would put the same sentence
 * in two places and make neither authoritative — and a rule that matched nothing has, by
 * definition, no step to annotate.
 *
 * It lives above `server/` and `ui/` because both need it: the server folds, the page renders.
 *
 * The second half of the file is the *run identity* half (variants spec §5): how a run's variant is
 * read off a `meta.json` of any vintage, and what a selected pair is once variants are in play. The
 * CLI re-exports it from `cli/variant.ts` rather than keeping a second copy, because the sentence a
 * proposal pair prints is the same sentence in both front-ends and the rule for *what counts as the
 * same revision* is exactly the kind of thing that drifts when it is written down twice.
 */

import type { Revision, RunId, StepId, ViewportId } from '../types.js';
import { VARIANT_NONE, type VariantName, type VariantVerb } from '../variant/types.js';

export { VARIANT_NONE, type VariantName, type VariantVerb } from '../variant/types.js';

/** Viewports kept per row. Enough to say "only on mobile", not enough to be a matrix. */
export const MAX_ATTRIBUTION_VIEWPORTS = 4;

/**
 * One element a variant rule changed, exactly as `variant.json` records it (variants spec §7).
 *
 * Declared here rather than imported from the runner because this is a *file format* the report
 * reads off disk, and the on-disk store is the interface between modules (spec §5). A field the
 * runner adds later and this does not know about is ignored rather than fatal.
 */
export interface VariantElementRecord {
  step: StepId;
  viewport: ViewportId;
  /** Best-effort stable selector for the element, in the style of the diff engine's. */
  target: string;
  /**
   * The variant, repeated on every record by the runner. Optional to the *reader*: the fold takes
   * the name from the file header, so a record without it is still attributable to the right rule
   * rather than being dropped.
   */
  variant?: VariantName;
  ruleId: string;
  verb: VariantVerb;
}

/**
 * The verification pass's verdict for one rule (D22), as `variant.json` records it.
 *
 * `unmatched` is not the same as `matched === 0`: a selector can match forty cards and change none
 * of them, because the browser refused the declaration or the reference element the rule ordered
 * against was not there. Reading the count instead of the verdict would report those rules as
 * having worked.
 */
export type VariantRuleOutcome = 'applied' | 'reverted' | 'unmatched';

/** One rule's outcome for the whole run, as `variant.json` records it. */
export interface VariantRuleRecord {
  ruleId: string;
  verb: VariantVerb;
  outcome: VariantRuleOutcome;
  /** Elements the rule's selector matched. */
  matched: number;
  /** Elements it actually modified. */
  changed: number;
  /** Modified elements whose change was still present at verification time (D22). */
  verified: number;
  /** Why the outcome is what it is, in the sentence the run warning quotes. */
  detail?: string;
}

/** `variant.json`, as written next to a run. */
export interface VariantReportFile {
  variant: VariantName;
  /** Where the spec was read from — a path, or `<repo path>@<sha7>` on historical replay. */
  file: string;
  rules: VariantRuleRecord[];
  /** `<style>` elements carried over from clone sources into the captured pages (§4). */
  stylesInjected?: number;
  elements: VariantElementRecord[];
}

/** Everything one rule did to one step. */
export interface VariantRuleHit {
  variant: VariantName;
  ruleId: string;
  verb: VariantVerb;
  /** Elements this rule changed in this step. Never zero: an unmatched rule has no row. */
  elements: number;
  /** Distinct viewports it was seen in, capped at {@link MAX_ATTRIBUTION_VIEWPORTS}. */
  viewports: ViewportId[];
}

/** One step's worth of variant attribution. */
export interface StepVariantAttribution {
  step: StepId;
  /** Rules that changed something here, in the order their first element appeared. */
  rules: VariantRuleHit[];
}

/** `GET /api/variant/:flow/:runId`. */
export interface RunVariantAttribution {
  flow: string;
  runId: RunId;
  /** The variant the run was captured under, or `none`. */
  variant: VariantName;
  /** One entry per step at least one rule changed something in. */
  steps: StepVariantAttribution[];
  /**
   * Rules that changed nothing anywhere, and rules whose effect was gone by capture (D22).
   *
   * Carried so the page can say *which* of the two silent failures happened without re-deriving it
   * from warning text, and so a client that has the attribution but not the run's meta still knows.
   * The reader-facing warning still comes from `meta.warnings`, which is where run-level warnings
   * live for every other subsystem.
   */
  unmatchedRules: string[];
  revertedRules: string[];
}

/** True when this run has anything to attribute at all. */
export function hasVariantAttribution(attribution: RunVariantAttribution | null): boolean {
  if (attribution === null) return false;
  return attribution.variant !== VARIANT_NONE;
}

function isElementRecord(value: unknown): value is VariantElementRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<VariantElementRecord>;
  return typeof record.step === 'string' && typeof record.ruleId === 'string';
}

/**
 * Fold a run's `variant.json` into per-step rows.
 *
 * Tolerant of a file that is missing or malformed: a run with no variant has no `variant.json` at
 * all, which is the ordinary case and not an error, and the report must still render. What it never
 * does is *invent* a row — an element record with no rule id is dropped rather than attributed to
 * something, because a wrong attribution is worse than a missing one.
 */
export function summarizeVariantRun(
  flow: string,
  runId: RunId,
  variant: VariantName,
  report: VariantReportFile | null,
): RunVariantAttribution {
  const attribution: RunVariantAttribution = {
    flow,
    runId,
    variant,
    steps: [],
    unmatchedRules: [],
    revertedRules: [],
  };
  if (report === null) return attribution;

  const rules = Array.isArray(report.rules) ? report.rules : [];
  for (const rule of rules) {
    if (typeof rule?.ruleId !== 'string') continue;
    if (rule.outcome === 'reverted') attribution.revertedRules.push(rule.ruleId);
    else if (rule.outcome === 'unmatched') attribution.unmatchedRules.push(rule.ruleId);
  }

  const byStep = new Map<StepId, Map<string, VariantRuleHit>>();
  const order: StepId[] = [];
  const elements = Array.isArray(report.elements) ? report.elements : [];

  for (const element of elements) {
    if (!isElementRecord(element)) continue;
    let hits = byStep.get(element.step);
    if (hits === undefined) {
      hits = new Map<string, VariantRuleHit>();
      byStep.set(element.step, hits);
      order.push(element.step);
    }
    // Keyed by rule *and* verb, exactly as the scenario fold is keyed by rule and action: a report
    // that said "hidden" about an element that was in fact restyled would be the tool lying about
    // its own work.
    const key = `${element.ruleId} ${element.verb}`;
    let hit = hits.get(key);
    if (hit === undefined) {
      hit = {
        variant: report.variant ?? variant,
        ruleId: element.ruleId,
        verb: element.verb,
        elements: 0,
        viewports: [],
      };
      hits.set(key, hit);
    }
    hit.elements += 1;
    if (
      typeof element.viewport === 'string' &&
      hit.viewports.length < MAX_ATTRIBUTION_VIEWPORTS &&
      !hit.viewports.includes(element.viewport)
    ) {
      hit.viewports.push(element.viewport);
    }
  }

  attribution.steps = order.map((step) => ({
    step,
    rules: [...(byStep.get(step)?.values() ?? [])],
  }));
  return attribution;
}

/**
 * The sentence the report prints for one rule (variants spec §7).
 *
 * The spec fixes the wording — "element modified by `denser-forecast` rule `tighter-cards`" — and
 * it is used for every verb rather than conjugated per verb, so the sentence a reader learns to
 * scan for is the same one whatever the rule did. Which verb it was is carried on the row and
 * rendered as a tag beside it, where it informs without changing the shape of the line.
 */
export function describeVariantHit(hit: VariantRuleHit): string {
  const subject = hit.elements === 1 ? 'element' : `${hit.elements} elements`;
  return `${subject} modified by ${hit.variant} rule ${hit.ruleId}`;
}

/* ------------------------------------------------------------------ run warnings (§7) */

/**
 * The three run-warning kinds a variant run can carry (variants spec §7).
 *
 * Declared here as strings rather than imported from the runner's warning union, because the report
 * reads `meta.json` off disk: it has to recognise the kind a *stored* run carries, which is a fact
 * about a file rather than about the union this build happens to compile against.
 *
 * All three mean the same dangerous thing and are therefore all high severity, exactly as
 * `scenario-rule-unmatched` is (mocking spec §8): a screenshot was produced, and it is not what its
 * label says it is. A rule that matched nothing leaves that part of the page unmodified; a rule
 * reverted before capture leaves *all* of it unmodified (D22); an unstyled clone renders something
 * a decision can be made from that does not look like what it will look like.
 */
export const VARIANT_WARNING_KINDS = [
  'variant-rule-unmatched',
  'variant-rule-reverted',
  'variant-clone-unstyled',
] as const;

export type VariantWarningKind = (typeof VARIANT_WARNING_KINDS)[number];

/** True for a run warning that says the capture is not the proposal it is labelled as (§7). */
export function isVariantWarningKind(kind: string): kind is VariantWarningKind {
  return (VARIANT_WARNING_KINDS as readonly string[]).includes(kind);
}

/* ------------------------------------------------------------------ run identity (§5) */

/**
 * The variant a run was captured under.
 *
 * Read tolerantly rather than as a required field, because `meta.json` files written before this
 * slice have no `variant` key at all — and a run captured without a variant genuinely had none,
 * which is a fact rather than a fault. Takes `object` rather than `{ variant?: … }` so a plain
 * `RunMeta` or a timeline row is an acceptable argument today and stays one when the field is
 * promoted into `src/types.ts`.
 */
export function variantOf(run: object | null | undefined): VariantName {
  const raw = (run as { variant?: unknown } | null | undefined)?.variant;
  if (typeof raw !== 'string') return VARIANT_NONE;
  const trimmed = raw.trim();
  return trimmed === '' ? VARIANT_NONE : trimmed;
}

/** True when this run was captured under a variant at all. */
export function isVariantRun(run: object | null | undefined): boolean {
  return variantOf(run) !== VARIANT_NONE;
}

/** True when `--keep` promoted this variant run into the permanent timeline (D24). */
export function isKept(run: object | null | undefined): boolean {
  return (run as { kept?: unknown } | null | undefined)?.kept === true;
}

/**
 * A variant run that has *not* been promoted: the exploratory capture D24 keeps out of the
 * regression timeline and in its own retention bucket. This — not "ran a variant" — is what the
 * default `vdiff runs <flow>` hides, because promotion is precisely the act of asking for the
 * opposite.
 */
export function isEphemeralVariantRun(run: object | null | undefined): boolean {
  return isVariantRun(run) && !isKept(run);
}

/**
 * Same revision in the sense the proposal question needs: the same commit, and the same working
 * tree. `ref` is not compared — one commit reached from two branch names is one commit — but
 * `dirty` and `dirtyHash` are: a variant rendered over uncommitted work only answers the proposal
 * question against a baseline of that same uncommitted work.
 */
export function sameRevision(base: Revision, head: Revision): boolean {
  if (base.sha !== head.sha || base.dirty !== head.dirty) return false;
  return (base.dirtyHash ?? null) === (head.dirtyHash ?? null);
}

/**
 * What a pair is, once variants are in play.
 *
 * - `variant-proposal` — one side ran a variant, the other did not, at the same revision. This is
 *   the *default* variant comparison (D24) and therefore the normal case: it is stated, never
 *   warned about. Applying scenario pairing semantics unchanged would flag precisely the thing the
 *   user is trying to do.
 * - `cross-variant` — two different variants. A legitimate question about two proposals, labelled
 *   so its findings are not read as a regression, exactly as `cross-scenario` is.
 * - `variant-across-revisions` — a variant on one side only, at two different revisions. Permitted,
 *   because a promoted variant is an ordinary run, but the findings then mix the proposal with the
 *   code change and the reader has to be told which they are looking at.
 *
 * `null` covers the two pairs that need no comment at all: neither side had a variant, and both
 * sides ran the *same* variant — the latter being the same-identity pair D24 says behaves like any
 * other.
 */
export type VariantPairLabel = 'variant-proposal' | 'cross-variant' | 'variant-across-revisions';

export interface VariantPair {
  base: VariantName;
  head: VariantName;
  sameRevision: boolean;
  label: VariantPairLabel | null;
}

/**
 * Just enough of a run to classify the pair it is half of. `variant` is optional because a
 * `meta.json` written before this slice does not carry one, which {@link variantOf} reads as
 * `none` — the pre-variant world, correctly described.
 */
export interface VariantPairSide {
  revision: Revision;
  variant?: VariantName;
}

/** Classifies a pair from the two runs' meta. Pure; the wording is {@link describeVariantPair}. */
export function classifyVariantPair(base: VariantPairSide, head: VariantPairSide): VariantPair {
  const baseVariant = variantOf(base);
  const headVariant = variantOf(head);
  const same = sameRevision(base.revision, head.revision);
  const pair: VariantPair = {
    base: baseVariant,
    head: headVariant,
    sameRevision: same,
    label: null,
  };

  if (baseVariant === headVariant) return pair;
  if (baseVariant !== VARIANT_NONE && headVariant !== VARIANT_NONE) {
    return { ...pair, label: 'cross-variant' };
  }
  return { ...pair, label: same ? 'variant-proposal' : 'variant-across-revisions' };
}

/** The variant named by a pair in which exactly one side had one. */
function lonelyVariant(pair: VariantPair): VariantName {
  return pair.head === VARIANT_NONE ? pair.base : pair.head;
}

/**
 * The sentence each classification prints, in the CLI and in the report alike.
 *
 * The proposal wording states what was compared and stops there. It carries no "this is not a
 * regression" caveat because for a variant run that comparison *is* the question (D24), and a
 * caveat on the normal case trains readers to ignore the channel that carries the real ones.
 */
export function describeVariantPair(pair: VariantPair): string | null {
  switch (pair.label) {
    case 'variant-proposal':
      return (
        `proposal: variant '${lonelyVariant(pair)}' against the unmodified page` +
        ' at the same revision'
      );
    case 'cross-variant':
      return (
        `cross-variant: base ran '${pair.base}', head ran '${pair.head}' —` +
        ' this compares two proposals, not two revisions'
      );
    case 'variant-across-revisions':
      return (
        `variant '${lonelyVariant(pair)}' ran on one side only, and the two runs are at` +
        ' different revisions — this mixes the proposal with the code change between them'
      );
    case null:
    default:
      return null;
  }
}

/**
 * How a variant name reads in output: the reserved `none` is an absence, not a name.
 * Mirrors the scenario treatment so the two axes read alike.
 */
export function showVariant(name: VariantName): string {
  return name === VARIANT_NONE ? 'no variant' : name;
}
