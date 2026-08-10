/**
 * Turning a variant spec into the one JSON argument the page receives (variants spec §4, §9).
 *
 * Everything here is pure and runs in Node. It exists so the in-page pass has no decisions left to
 * make: no defaults to apply, no camelCase to translate, no clone source to go and fetch. That
 * split is what makes D23 true — "both resolved before capture, so a missing source fails fast
 * rather than mid-run" — and it is what keeps `applyVariantInPage` small enough to be honest about
 * closing over nothing.
 *
 * It is also where "exactly one verb per rule" (§4) is enforced a second time. Validation rejects a
 * two-verb rule with a file and a line; this module refuses to run one that got past it, because
 * the alternative is inventing a precedence order at the moment a user is looking at a picture and
 * deciding whether to build something.
 */

import { STYLE_PROPS, type StyleProp } from '../types.js';
import { DETERMINISM_STYLE_ID } from '../runner/determinism.js';
import {
  VARIANT_VERBS,
  type ClonePosition,
  type CloneSource,
  type OrderSpec,
  type VariantVerb,
} from '../variant/index.js';
import { VariantError, variantRuleLabel } from './errors.js';
import type {
  ApplicableClone,
  ApplicableRule,
  AppliedRule,
  ClonePlacement,
  CloneExtractArgs,
  CloneExtractResult,
  ExtractedClone,
  OrderPlacement,
  ResolvedDeclaration,
  VariantApplyArgs,
} from './types.js';

/** `clone.times` when the rule does not say (§4). One copy is the proposal "add another of these". */
export const DEFAULT_CLONE_TIMES = 1;

/** `clone.position` when the rule does not say. Appending disturbs the least. */
export const DEFAULT_CLONE_POSITION: ClonePlacement = { at: 'append' };

/**
 * Computed properties deliberately *not* compared between a clone's source and its destination.
 *
 * Both describe where an element sits in its stacking and layout context, which is precisely what
 * moving it into a sidebar is expected to change. Comparing them would make the §4 unstyled-clone
 * warning fire on every successful clone, and a warning that always fires is read as noise exactly
 * when it finally means something.
 */
export const CLONE_STYLE_IGNORED: readonly StyleProp[] = ['position', 'zIndex'];

/**
 * `backgroundColor` → `background-color`. `setProperty` and `getPropertyValue` take the dashed
 * form, and a variant author writing either spelling in YAML means the same property.
 */
export function cssPropertyName(name: string): string {
  const trimmed = name.trim();
  // Custom properties are case-sensitive and must survive untouched: `--Brand-Fg` is not
  // `--brand-fg`.
  if (trimmed.startsWith('--')) return trimmed;
  return trimmed.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * The style subset compared between a clone's source and its destination (§4), dashed.
 *
 * Derived from the capture subset in `types.ts` rather than invented here, so "what the tool looks
 * at" stays one list: a property worth diffing between two revisions is a property worth checking
 * survived a clone.
 */
export const CLONE_STYLE_PROPS: readonly string[] = STYLE_PROPS.filter(
  (prop) => !CLONE_STYLE_IGNORED.includes(prop),
).map(cssPropertyName);

/** Which verbs a rule carries, in §4 order. Two of them is an error, not a precedence question. */
export function verbsOf(rule: ApplicableRule): VariantVerb[] {
  const verbs: VariantVerb[] = [];
  if (rule.style !== undefined) verbs.push('style');
  if (rule.text !== undefined) verbs.push('text');
  if (rule.hide === true) verbs.push('hide');
  if (rule.order !== undefined) verbs.push('order');
  if (rule.clone !== undefined) verbs.push('clone');
  return verbs;
}

/** The one verb a rule carries, or a {@link VariantError} naming the rule (§4, §7). */
export function variantVerbOf(variant: string, rule: ApplicableRule): VariantVerb {
  const verbs = verbsOf(rule);
  if (verbs.length === 1) return verbs[0] as VariantVerb;
  const label = variantRuleLabel(variant, rule.id);
  if (verbs.length === 0) {
    throw new VariantError({
      code: 'variant-rule-no-verb',
      variant,
      ruleId: rule.id,
      exitCode: 2,
      kind: 'variant-invalid',
      message: `${label} carries no verb: exactly one of ${VARIANT_VERBS.join(', ')} is required`,
      hint: 'a rule that changes nothing would render the unmodified page under a variant name',
    });
  }
  throw new VariantError({
    code: 'variant-rule-two-verbs',
    variant,
    ruleId: rule.id,
    exitCode: 2,
    kind: 'variant-invalid',
    message:
      `${label} carries two verbs (${verbs.join(', ')}): exactly one of ` +
      `${VARIANT_VERBS.join(', ')} is allowed`,
    hint: 'split the rule in two, each with its own id, rather than relying on an order of application',
  });
}

function requireMatch(variant: string, rule: ApplicableRule, verb: VariantVerb): string {
  const match = rule.match;
  if (match !== undefined && match.trim() !== '') return match;
  throw new VariantError({
    code: 'variant-rule-no-match',
    variant,
    ruleId: rule.id,
    exitCode: 2,
    kind: 'variant-invalid',
    message: `${variantRuleLabel(variant, rule.id)} has no 'match': a ${verb} rule needs a selector saying which elements it applies to`,
  });
}

/** `{ padding: 8px, gap: 4px }` → dashed declarations, values stringified, in author order. */
export function styleDeclarations(
  style: Readonly<Record<string, string | number>>,
): ResolvedDeclaration[] {
  return Object.entries(style).map(([name, value]) => ({
    name: cssPropertyName(name),
    value: typeof value === 'number' ? String(value) : value.trim(),
  }));
}

/** `first | last | { before } | { after }` → the placement the page acts on. */
export function orderPlacement(order: OrderSpec): OrderPlacement {
  if (order === 'first') return { at: 'first' };
  if (order === 'last') return { at: 'last' };
  // `RelativeTo` spells the unused half as `?: never`, so `in` narrows nothing and the value is
  // what has to be tested.
  if (order.before !== undefined) return { at: 'before', selector: order.before };
  return { at: 'after', selector: order.after as string };
}

/** `prepend | append | { before } | { after }` → the placement the page acts on. */
export function clonePlacement(position: ClonePosition | undefined): ClonePlacement {
  if (position === undefined) return DEFAULT_CLONE_POSITION;
  if (position === 'prepend') return { at: 'prepend' };
  if (position === 'append') return { at: 'append' };
  if (position.before !== undefined) return { at: 'before', selector: position.before };
  return { at: 'after', selector: position.after as string };
}

/** `step 'pricing'` or the URL — how a clone source is named in every message about it (D23). */
export function cloneOrigin(from: CloneSource): string {
  if (from.step !== undefined && from.step !== '') return `step '${from.step}'`;
  if (from.url !== undefined && from.url !== '') return `url '${from.url}'`;
  return 'an unspecified source';
}

export interface CloneExtractOptions {
  /** Dashed properties to read at the source. Defaults to {@link CLONE_STYLE_PROPS}. */
  styleProps?: readonly string[];
  /** `<style>` ids to leave behind. Defaults to the runner's determinism stylesheet. */
  excludeStyleIds?: readonly string[];
}

/**
 * The argument for the in-page extractor, run in the source page's own context so the source is
 * subject to the same determinism knobs, scenario and network mode as the target (§9).
 */
export function cloneExtractArgs(
  variant: string,
  rule: ApplicableRule,
  options: CloneExtractOptions = {},
): CloneExtractArgs {
  const clone = rule.clone;
  if (clone === undefined) {
    throw new VariantError({
      code: 'variant-clone-source-missing',
      variant,
      ruleId: rule.id,
      exitCode: 2,
      kind: 'variant-invalid',
      message: `${variantRuleLabel(variant, rule.id)} is not a clone rule, so it has no source to extract`,
    });
  }
  return {
    ruleId: rule.id,
    origin: cloneOrigin(clone.from),
    match: clone.from.match,
    styleProps: options.styleProps ?? CLONE_STYLE_PROPS,
    excludeStyleIds: options.excludeStyleIds ?? [DETERMINISM_STYLE_ID],
  };
}

/**
 * An extraction result becomes a usable source, or the run fails naming the rule (§7).
 *
 * A source that matched nothing is a *run* failure rather than a warning, unlike a target selector
 * that matches nothing: there is no element to clone, so the rule cannot even half-happen, and
 * carrying on would produce a page missing the very thing the variant is about.
 */
export function cloneSourceFrom(variant: string, result: CloneExtractResult): ExtractedClone {
  if (!result.found || result.html === '') {
    const detail = result.detail ?? `no element matched '${result.match}'`;
    throw new VariantError({
      code: 'variant-clone-source-empty',
      variant,
      ruleId: result.ruleId,
      message: `${variantRuleLabel(variant, result.ruleId)} could not extract its clone source from ${result.origin}: ${detail}`,
      hint: 'a clone can only copy an element the application already rendered — check the source selector and that the step renders it',
    });
  }
  return {
    origin: result.origin,
    match: result.match,
    html: result.html,
    styles: result.styles,
    computed: result.computed,
  };
}

export interface BuildArgsOptions {
  variant: string;
  rules: readonly ApplicableRule[];
  /** One resolved source per clone rule id (D23), keyed by rule id. */
  cloneSources?: ReadonlyMap<string, ExtractedClone>;
  /** Dashed properties compared at the destination. Defaults to {@link CLONE_STYLE_PROPS}. */
  cloneStyleProps?: readonly string[];
}

/** One rule, resolved. Exported for the callers that resolve rules one at a time. */
export function appliedRule(
  variant: string,
  rule: ApplicableRule,
  cloneSources: ReadonlyMap<string, ExtractedClone>,
): AppliedRule {
  const verb = variantVerbOf(variant, rule);

  if (verb === 'style') {
    return {
      id: rule.id,
      verb,
      match: requireMatch(variant, rule, verb),
      style: styleDeclarations(rule.style ?? {}),
    };
  }
  if (verb === 'text') {
    return { id: rule.id, verb, match: requireMatch(variant, rule, verb), text: rule.text ?? '' };
  }
  if (verb === 'hide') {
    return { id: rule.id, verb, match: requireMatch(variant, rule, verb) };
  }
  if (verb === 'order') {
    return {
      id: rule.id,
      verb,
      match: requireMatch(variant, rule, verb),
      // `verb === 'order'` means `rule.order` is defined; the input type cannot express that.
      order: orderPlacement(rule.order ?? 'last'),
    };
  }

  const clone = rule.clone as ApplicableClone;
  const times = clone.times ?? DEFAULT_CLONE_TIMES;
  if (!Number.isInteger(times) || times < 1) {
    throw new VariantError({
      code: 'variant-clone-times',
      variant,
      ruleId: rule.id,
      exitCode: 2,
      kind: 'variant-invalid',
      message: `${variantRuleLabel(variant, rule.id)} has times: ${JSON.stringify(times)}, which must be a whole number of 1 or more`,
    });
  }
  const source = cloneSources.get(rule.id);
  if (source === undefined) {
    throw new VariantError({
      code: 'variant-clone-source-missing',
      variant,
      ruleId: rule.id,
      message:
        `${variantRuleLabel(variant, rule.id)} was applied before its clone source from ` +
        `${cloneOrigin(clone.from)} had been extracted`,
      hint: 'clone sources are resolved before capture so a missing one fails fast rather than mid-run',
    });
  }
  return { id: rule.id, verb, clone: { into: clone.into, position: clonePlacement(clone.position), times, source } };
}

/** The whole spec, resolved into the single JSON argument `applyVariantInPage` takes. */
export function buildVariantApplyArgs(options: BuildArgsOptions): VariantApplyArgs {
  const sources = options.cloneSources ?? new Map<string, ExtractedClone>();
  return {
    variant: options.variant,
    rules: options.rules.map((rule) => appliedRule(options.variant, rule, sources)),
    cloneStyleProps: options.cloneStyleProps ?? CLONE_STYLE_PROPS,
  };
}

/** Rule ids whose clone sources must be extracted before the run can apply this variant (D23). */
export function cloneRuleIds(rules: readonly ApplicableRule[]): string[] {
  return rules.filter((rule) => rule.clone !== undefined).map((rule) => rule.id);
}
