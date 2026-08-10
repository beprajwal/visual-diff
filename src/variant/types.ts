/**
 * The variant vocabulary as types (variants spec §4, §5, §7).
 *
 * These live here rather than in `src/types.ts` for one reason only: the variant layer is being
 * built as a self-contained module, exactly as `scenario/` was, and the shapes below are its
 * published surface. Everything another module needs is re-exported from `variant/index.ts`.
 *
 * The single constraint this file exists to encode is the one from §1: **a variant cannot invent
 * UI**. Every verb below takes a selector over nodes the application already rendered — `style`,
 * `text`, `hide` and `order` operate on matched elements, and `clone` descends from one. There is
 * no verb that takes markup, and adding one would make the whole subsystem a lie (§2).
 */

/**
 * The closed rule vocabulary (D21). Exactly one per rule; two is a validation error rather than an
 * invented precedence order (§4).
 *
 * Declaration order is report order: it is the order `variantSummary` lists verbs in and the order
 * the structural diff walks them, so it is a stable output contract and not merely an array.
 */
export const VARIANT_VERBS = ['style', 'text', 'hide', 'order', 'clone'] as const;
export type VariantVerb = (typeof VARIANT_VERBS)[number];

/** Variant name, matching the filename stem of `.visual-diff/variants/<name>.yaml`. */
export type VariantName = string;

/**
 * What a run captured without a variant records in `meta.json` (§5, mirroring `SCENARIO_NONE`
 * under D12). Reserved: no variant file may take this name (§7), so `meta.variant === 'none'` is
 * unambiguous and every pre-variants run stays readable.
 */
export const VARIANT_NONE = 'none';

/**
 * `style: { padding: 8px, gap: 4px }` — CSS declarations applied to every matched element.
 *
 * Values are normalized to strings on the way in, because YAML reads `padding: 8` as a number and
 * `line-height: 1.5` as a float while `element.style.setProperty` takes only strings.
 */
export type StyleDeclarations = Record<string, string>;

/** A selector-relative placement: `{ before: … }` or `{ after: … }` (§4). */
export type RelativeTo = { before: string; after?: never } | { after: string; before?: never };

/** `order: first | last | { before: <selector> } | { after: <selector> }` (§4). */
export type OrderSpec = 'first' | 'last' | RelativeTo;

/** `clone.position: prepend | append | { before: … } | { after: … }` (§4). */
export type ClonePosition = 'prepend' | 'append' | RelativeTo;

/**
 * Where a clone comes from (D23): a step of the same run, or a URL visited during it. Exactly one
 * of `step` and `url`; neither or both is a validation error (§7).
 *
 * Both are resolved before capture and both are the same revision as the target — sourcing from a
 * stored run is refused precisely because it would permit compositing two revisions (§2).
 */
export type CloneSource = { match: string } & (
  | { step: string; url?: never }
  | { url: string; step?: never }
);

/** The `clone` verb: repeat an element the application rendered somewhere else (§4, D21). */
export interface CloneSpec {
  from: CloneSource;
  /** Selector for the element the clone is placed into. */
  into: string;
  /** Materialized: a spec that omits `position` appends (§4). */
  position: ClonePosition;
  /** Materialized: a spec that omits `times` clones once. Below 1 is a validation error (§7). */
  times: number;
}

/** What every rule carries, whichever verb it is built around (§4). */
export interface VariantRuleBase {
  /**
   * Stable and required, as flow step ids (D4) and scenario rule ids (D11) are: it is what carries
   * attribution into the report — "element modified by `denser-forecast` rule `tighter-cards`" —
   * what the never-matched and reverted warnings name, and what lets two versions of a variant be
   * compared structurally (§4, §7).
   */
  id: string;
}

/**
 * One rule: a verb plus whatever that verb selects (§4).
 *
 * The `?: never` slots make "exactly one verb per rule" a type error rather than an invented
 * precedence order, exactly as `ScenarioRule` does for the response verbs. `match` sits inside the
 * branches rather than in the base because the four in-place verbs require it while `clone` has no
 * use for one: a clone names its source with `clone.from.match` and its target with `clone.into`,
 * so a top-level `match` on a clone rule would be a third selector with nothing to select.
 */
export type VariantRule = VariantRuleBase &
  (
    | { match: string; style: StyleDeclarations; text?: never; hide?: never; order?: never; clone?: never }
    | { match: string; text: string; style?: never; hide?: never; order?: never; clone?: never }
    | { match: string; hide: true; style?: never; text?: never; order?: never; clone?: never }
    | { match: string; order: OrderSpec; style?: never; text?: never; hide?: never; clone?: never }
    | { clone: CloneSpec; match?: never; style?: never; text?: never; hide?: never; order?: never }
  );

/** `.visual-diff/variants/<name>.yaml`, committed and read from git history at the target SHA (§4). */
export interface VariantSpec {
  version: 1;
  /** Must agree with the filename stem; disagreement is a validation error (§7). */
  variant: VariantName;
  description?: string;
  /** Applied in file order, once, after the settle gate and before masking (D22, §9). */
  rules: VariantRule[];
}

/** One row of `vdiff variant list` (§6). */
export interface VariantSummary {
  name: VariantName;
  description?: string;
  ruleCount: number;
  /** Distinct verbs the variant uses, in `VARIANT_VERBS` order. */
  verbs: VariantVerb[];
  /** Path relative to the .visual-diff directory. */
  path: string;
}

/**
 * Per-element attribution (§7): "each modified element records `{ variant, ruleId, verb }`, and the
 * report annotates the step with 'element modified by `denser-forecast` rule `tighter-cards`'".
 * The shape mirrors `ScenarioAttribution`, which buys the same thing for requests (D11).
 */
export interface VariantAttribution {
  variant: VariantName;
  ruleId: string;
  verb: VariantVerb;
}
