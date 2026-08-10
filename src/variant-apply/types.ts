/**
 * The vocabulary of variant application (variants spec §4, §7, §9).
 *
 * The variant *language* — verbs, rules, specs, names — belongs to `variant/` and is imported from
 * its module edge rather than restated here. What this file adds is the three shapes application
 * needs, and the boundary between them is the point of it:
 *
 * 1. **Rules as application sees them** ({@link ApplicableRule}) — structurally what `VariantRule`
 *    already is, with `clone.position` and `clone.times` optional because the parser materializes
 *    them and a hand-built rule should not have to. Every `VariantRule` is an `ApplicableRule`;
 *    `types.test.ts` holds the compiler to that.
 * 2. **Args** ({@link VariantApplyArgs}) — plain JSON that crosses into the page. Every clone source
 *    is already extracted here (D23: resolved before capture, so a missing source fails fast rather
 *    than mid-run), every CSS property name is already in the dashed form `setProperty` wants, and
 *    nothing needs a lookup the page cannot do.
 * 3. **Report** ({@link VariantApplyReport}) — plain JSON coming back out, one entry per rule with
 *    the D22 verdict (`applied` | `reverted` | `unmatched`) plus the per-element attribution the
 *    report annotates steps with.
 *
 * Args and report are JSON on purpose: they cross a process boundary, exactly as `CollectArgs` and
 * `CollectResult` do for the DOM collector.
 */

import type {
  ClonePosition,
  CloneSource,
  OrderSpec,
  VariantAttribution,
  VariantVerb,
} from '../variant/index.js';

/**
 * The D22 verdict for one rule, decided by the verification pass.
 *
 * - `applied` — the rule matched, changed what it said it would, and the change was still present
 *   immediately before the screenshot.
 * - `reverted` — the change was made and was gone by capture time. The dangerous case: the
 *   screenshot shows the *unvaried* UI while claiming to be a proposal.
 * - `unmatched` — the rule's selector matched nothing, so nothing was ever changed.
 */
export type RuleOutcome = 'applied' | 'reverted' | 'unmatched';

/* ------------------------------------------------------------------ attribution markers */

/**
 * Attributes stamped on every element a variant modified (§7). Read by the report, which turns them
 * into "element modified by `denser-forecast` rule `tighter-cards`".
 *
 * Values are comma-separated lists, because two rules may legitimately touch one element and the
 * second must not erase the first's attribution.
 *
 * These strings are duplicated as literals inside `applyVariantInPage`, which closes over nothing;
 * the golden tests assert the two agree.
 */
export const VARIANT_ATTRS = {
  variant: 'data-vdiff-variant',
  rule: 'data-vdiff-rule',
  verb: 'data-vdiff-verb',
} as const;

/** Marks a `<style>` element carried over from a clone source page (§4). */
export const VARIANT_STYLE_ATTR = 'data-vdiff-variant-style';

/** Marks an inserted clone, so a clone is distinguishable from the element it descends from. */
export const VARIANT_CLONE_ATTR = 'data-vdiff-clone';

/* ------------------------------------------------------------------ rules, as application sees them */

/** `clone`, with the two fields the parser materializes left optional (see the header). */
export interface ApplicableClone {
  from: CloneSource;
  into: string;
  position?: ClonePosition;
  times?: number;
}

/**
 * One rule, structurally.
 *
 * Every verb is optional here, where `VariantRule` makes "exactly one" a type error — because a
 * rule reaching application has come from YAML, and the type system stopped guarding it the moment
 * it did. `plan.ts` re-checks the invariant at run time rather than inventing a precedence between
 * two verbs while a user is looking at a picture and deciding whether to build something.
 *
 * `style` values admit numbers because YAML reads `opacity: 0.5` as one.
 */
export interface ApplicableRule {
  id: string;
  match?: string;
  style?: Readonly<Record<string, string | number>>;
  text?: string;
  hide?: boolean;
  order?: OrderSpec;
  clone?: ApplicableClone;
}

/* ------------------------------------------------------------------ args (crosses into the page) */

/** A resolved `style` declaration: dashed property name, value already a string. */
export interface ResolvedDeclaration {
  name: string;
  value: string;
}

/** Where `order` puts the element among its siblings. */
export type OrderPlacement =
  | { at: 'first' }
  | { at: 'last' }
  | { at: 'before'; selector: string }
  | { at: 'after'; selector: string };

/** Where `clone` puts its copies inside the target. */
export type ClonePlacement =
  | { at: 'prepend' }
  | { at: 'append' }
  | { at: 'before'; selector: string }
  | { at: 'after'; selector: string };

/**
 * A clone's source element, already extracted from the page it lives on (D23) — the payload, as
 * distinct from `CloneSource`, which is the `from:` descriptor saying where to go and get it.
 *
 * `styles` carries the source page's injected `<style>` elements because CSS-in-JS libraries inject
 * their rules at mount time, and a component cloned onto a page where it never mounts would
 * otherwise render unstyled — **a misleading preview, not a failed one** (§4).
 *
 * `computed` is the source element's computed style subset, kept so the same subset can be read
 * again at the destination and any material difference reported (§7).
 */
export interface ExtractedClone {
  /** Human-readable provenance for messages: `step 'pricing'` or the URL (D23). */
  origin: string;
  /** The selector that produced this element at the source. */
  match: string;
  html: string;
  styles: readonly string[];
  computed: Readonly<Record<string, string>>;
}

export interface ResolvedClone {
  into: string;
  position: ClonePlacement;
  times: number;
  source: ExtractedClone;
}

export type AppliedRule =
  | { id: string; verb: 'style'; match: string; style: readonly ResolvedDeclaration[] }
  | { id: string; verb: 'text'; match: string; text: string }
  | { id: string; verb: 'hide'; match: string }
  | { id: string; verb: 'order'; match: string; order: OrderPlacement }
  | { id: string; verb: 'clone'; clone: ResolvedClone };

/** Everything the in-page pass needs, as one JSON argument. */
export interface VariantApplyArgs {
  variant: string;
  rules: readonly AppliedRule[];
  /**
   * Dashed CSS properties compared between a clone's source and its destination (§4). Layout-context
   * properties are deliberately absent — see `CLONE_STYLE_IGNORED` in `plan.ts`.
   */
  cloneStyleProps: readonly string[];
}

/* ------------------------------------------------------------------ report (comes back out) */

/**
 * One modified element (§7): the `{ variant, ruleId, verb }` of `VariantAttribution`, plus where on
 * the page it is, so the report can annotate the step with "element modified by `denser-forecast`
 * rule `tighter-cards`" and point at the element it means.
 */
export interface AttributedElement extends VariantAttribution {
  /** A best-effort stable selector for the element, in the style of `diff/selector.ts`. */
  target: string;
}

/** One property whose computed value differs between a clone's source and its destination. */
export interface CloneStyleDifference {
  property: string;
  source: string;
  target: string;
}

/** The §4 unstyled-clone check, run during the verification pass so the styles compared are final. */
export interface CloneStyleCheck {
  origin: string;
  /** How many properties had a source value to compare against. */
  compared: number;
  differences: readonly CloneStyleDifference[];
  /** True when at least one compared property differs — the preview is misleading. */
  material: boolean;
}

export interface RuleResult {
  ruleId: string;
  verb: VariantVerb;
  outcome: RuleOutcome;
  /** Elements the rule's selector matched (for `clone`, elements matching `into`). */
  matched: number;
  /** Elements the rule actually modified (for `clone`, copies inserted). */
  changed: number;
  /** Modified elements whose change was still present at verification time (D22). */
  verified: number;
  /** Why the outcome is what it is, in a sentence a warning can quote. */
  detail?: string;
  /** `clone` only: the source-versus-destination style comparison. */
  clone?: CloneStyleCheck;
}

export interface VariantApplyReport {
  variant: string;
  rules: RuleResult[];
  attributions: AttributedElement[];
  /** `<style>` elements carried over from clone sources and injected into this page. */
  stylesInjected: number;
}

/* ------------------------------------------------------------------ clone extraction */

/** Argument for the in-page extractor that runs in the *source* page (D23). */
export interface CloneExtractArgs {
  ruleId: string;
  /** Provenance, for the messages this extraction's failures produce. */
  origin: string;
  match: string;
  /** Dashed CSS properties to read from the matched element. */
  styleProps: readonly string[];
  /**
   * `<style>` elements to leave behind, by id — the runner's own determinism stylesheet is already
   * present in the target page and copying it would double it.
   */
  excludeStyleIds: readonly string[];
}

export interface CloneExtractResult {
  ruleId: string;
  origin: string;
  match: string;
  found: boolean;
  /** How many elements the source selector matched; the first is extracted. */
  matched: number;
  html: string;
  styles: string[];
  computed: Record<string, string>;
  detail?: string;
}

/* ------------------------------------------------------------------ warnings */

/**
 * Warning kinds this module raises (§7).
 *
 * Shaped exactly like `RunWarning` in `types.ts` so the runner can push these onto a run's warnings
 * once `RunWarningKind` gains the three members below — the same relationship
 * `mocking/errors.ts#ScenarioError` has with `RunnerError`.
 */
export type VariantWarningKind =
  /** A rule's selector matched nothing, so the page is the unmodified UI (§7). */
  | 'variant-rule-unmatched'
  /** **D22**: the change was made and was gone by capture time. The whole point of §8.2. */
  | 'variant-rule-reverted'
  /** A cloned element renders materially differently at its destination than at its source (§4). */
  | 'variant-clone-unstyled';

export interface VariantWarning {
  kind: VariantWarningKind;
  message: string;
  /** Rule ids this warning is about, exactly as `RunWarning#rules` carries scenario rule ids. */
  rules?: string[];
}
