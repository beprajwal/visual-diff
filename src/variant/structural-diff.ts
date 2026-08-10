/**
 * Structural diff of two variant versions, keyed by rule id (variants spec §4).
 *
 * §4: "Rule ids are required and stable, as with flow steps (D4) and scenario rules (D11): they
 * carry attribution into the report and let two versions of a variant be compared structurally."
 * This file is that comparison, and it exists for the same reason `flow/structural-diff.ts` and
 * `scenario/structural-diff.ts` do — a proposal is edited far more often than it is written, and
 * "what changed between the two arrangements I tried" is the question a variant run raises.
 *
 * Alignment is by rule id and never by position, exactly as steps align under D4. Position is
 * reported through `baseIndex`/`headIndex` instead, and a reordering that changes nothing else
 * still shows up as a variant-level note: rules apply in file order (D22), so moving a `style`
 * after another one that sets the same property changes which value survives.
 *
 * Pure: two specs in, entries out. No filesystem, no YAML, no runtime.
 */

import {
  VARIANT_VERBS,
  type ClonePosition,
  type OrderSpec,
  type VariantRule,
  type VariantSpec,
  type VariantVerb,
} from './types.js';

export type VariantDiffStatus = 'matched' | 'added' | 'removed' | 'changed';

export interface VariantDiffEntry {
  id: string;
  status: VariantDiffStatus;
  /** Human-readable summary of what changed, present only on `changed`. */
  detail?: string;
  /** Position in the base rule list, or null when the rule is new. */
  baseIndex: number | null;
  /** Position in the head rule list, or null when the rule was removed. */
  headIndex: number | null;
}

/** One field-level difference between two versions of the same rule. */
export interface RuleFieldChange {
  /** Dotted key, e.g. `match`, `style.padding`, `clone.from.step`, `verb`. */
  key: string;
  /** `undefined` when the field is absent in base. */
  from: unknown;
  /** `undefined` when the field is absent in head. */
  to: unknown;
}

export interface VariantDiffInput {
  base: VariantSpec;
  head: VariantSpec;
}

/**
 * Align two variants by rule id.
 *
 * Output order follows the head spec, with rules that exist only in base spliced in at the point
 * they disappeared from, so the result reads like the head variant with deletions visible — the
 * same traversal `structuralFlowDiff` and `structuralScenarioDiff` use, for the same reason: a
 * reordered rule must not drag unrelated deletions to the front.
 */
export function structuralVariantDiff(input: VariantDiffInput): VariantDiffEntry[] {
  const baseRules = input.base.rules ?? [];
  const headRules = input.head.rules ?? [];

  const baseById = indexById(baseRules);
  const headById = indexById(headRules);

  const entryFor = (id: string): VariantDiffEntry => {
    const base = baseById.get(id);
    const head = headById.get(id);
    const baseIndex = base?.index ?? null;
    const headIndex = head?.index ?? null;

    if (head === undefined) return { id, status: 'removed', baseIndex, headIndex: null };
    if (base === undefined) return { id, status: 'added', baseIndex: null, headIndex };

    const drift = describeRuleChanges(base.rule, head.rule);
    if (drift.length > 0) {
      return { id, status: 'changed', detail: drift.join('; '), baseIndex, headIndex };
    }
    return { id, status: 'matched', baseIndex, headIndex };
  };

  const entries: VariantDiffEntry[] = [];
  const emitted = new Set<string>();
  const emit = (id: string): void => {
    if (emitted.has(id)) return;
    emitted.add(id);
    entries.push(entryFor(id));
  };

  let cursor = 0;
  for (const headRule of headRules) {
    while (cursor < baseRules.length) {
      const candidate = baseRules[cursor];
      if (candidate === undefined) break;
      if (candidate.id === headRule.id) {
        cursor += 1;
        break;
      }
      if (headById.has(candidate.id)) break;
      emit(candidate.id);
      cursor += 1;
    }
    emit(headRule.id);
  }
  for (const baseRule of baseRules) emit(baseRule.id);

  return entries;
}

/** The verb a rule is built around. Every valid rule has exactly one (§4). */
export function verbOf(rule: VariantRule): VariantVerb {
  for (const verb of VARIANT_VERBS) {
    if (Object.prototype.hasOwnProperty.call(rule, verb)) return verb;
  }
  // Unreachable for a parsed spec: `no-verb` is a validation error. Named rather than thrown so a
  // hand-built rule in a caller's test does not explode inside the diff.
  return 'style';
}

/**
 * `first`, `last`, `before [data-test=x]` — one readable token for a placement.
 *
 * Rendering `order` and `clone.position` as a token rather than as an object is what lets the
 * structural diff report `order 'first' -> 'before [data-test=chart]'` instead of the useless
 * "order changed" that comparing two shapes of different kinds would otherwise produce.
 */
export function describePlacement(placement: OrderSpec | ClonePosition): string {
  if (typeof placement === 'string') return placement;
  if (placement.before !== undefined) return `before ${placement.before}`;
  return `after ${placement.after}`;
}

/**
 * Field-level differences between two versions of the same rule.
 *
 * Comparison is field by field over the materialized spec, so the defaults `parse.ts` filled in are
 * on both sides and writing `times: 1` explicitly is not a change. When the *verb itself* changed,
 * only `verb` is reported and not also the old and new bodies: "style -> hide" says everything, and
 * listing both payloads underneath it says nothing more.
 *
 * `style` is compared declaration by declaration, because that is how it is edited: a proposal
 * usually moves one number, and "style changed" would hide exactly the thing being reviewed.
 */
export function ruleFieldChanges(base: VariantRule, head: VariantRule): RuleFieldChange[] {
  const changes: RuleFieldChange[] = [];

  if (base.match !== head.match) {
    changes.push({ key: 'match', from: base.match, to: head.match });
  }

  const baseVerb = verbOf(base);
  const headVerb = verbOf(head);
  if (baseVerb !== headVerb) {
    changes.push({ key: 'verb', from: baseVerb, to: headVerb });
    return changes;
  }

  changes.push(...verbBodyChanges(headVerb, base, head));
  return changes;
}

function verbBodyChanges(
  verb: VariantVerb,
  base: VariantRule,
  head: VariantRule,
): RuleFieldChange[] {
  // Nothing to compare: `hide` is always `true`, so two hide rules with the same match are equal.
  if (verb === 'hide') return [];

  if (verb === 'text') {
    if (base.text === head.text) return [];
    return [{ key: 'text', from: base.text, to: head.text }];
  }

  if (verb === 'style') {
    return styleChanges(base.style ?? {}, head.style ?? {});
  }

  if (verb === 'order') {
    const from = base.order === undefined ? undefined : describePlacement(base.order);
    const to = head.order === undefined ? undefined : describePlacement(head.order);
    if (from === to) return [];
    return [{ key: 'order', from, to }];
  }

  const from = base.clone;
  const to = head.clone;
  if (from === undefined || to === undefined) return [];

  const changes: RuleFieldChange[] = [];
  if (from.from.step !== to.from.step) {
    changes.push({ key: 'clone.from.step', from: from.from.step, to: to.from.step });
  }
  if (from.from.url !== to.from.url) {
    changes.push({ key: 'clone.from.url', from: from.from.url, to: to.from.url });
  }
  if (from.from.match !== to.from.match) {
    changes.push({ key: 'clone.from.match', from: from.from.match, to: to.from.match });
  }
  if (from.into !== to.into) changes.push({ key: 'clone.into', from: from.into, to: to.into });
  const fromPosition = describePlacement(from.position);
  const toPosition = describePlacement(to.position);
  if (fromPosition !== toPosition) {
    changes.push({ key: 'clone.position', from: fromPosition, to: toPosition });
  }
  if (from.times !== to.times) {
    changes.push({ key: 'clone.times', from: from.times, to: to.times });
  }
  return changes;
}

function styleChanges(
  base: Record<string, string>,
  head: Record<string, string>,
): RuleFieldChange[] {
  const changes: RuleFieldChange[] = [];
  const properties = [...Object.keys(head), ...Object.keys(base).filter((key) => !(key in head))];
  for (const property of properties) {
    const from = base[property];
    const to = head[property];
    if (from === to) continue;
    changes.push({ key: `style.${property}`, from, to });
  }
  return changes;
}

/** Human-readable, machine-stable description of the differences between two same-id rules. */
export function describeRuleChanges(base: VariantRule, head: VariantRule): string[] {
  return formatRuleChanges(ruleFieldChanges(base, head));
}

/**
 * Renders field-level changes as the strings the report shows on a changed rule.
 *
 * A scalar reads `padding '8px' -> '4px'`; a field that appeared or disappeared reads
 * `added times 3` / `removed style.gap '4px'`; and anything structured reads `<key> changed` rather
 * than being dumped, because these strings live in a tooltip.
 */
export function formatRuleChanges(changes: readonly RuleFieldChange[]): string[] {
  const out: string[] = [];
  for (const change of changes) {
    const label = change.key.startsWith('style.') ? change.key.slice('style.'.length) : change.key;

    if (change.from === undefined) {
      out.push(isScalar(change.to) ? `added ${label} ${quoted(change.to)}` : `added ${label}`);
      continue;
    }
    if (change.to === undefined) {
      out.push(
        isScalar(change.from) ? `removed ${label} ${quoted(change.from)}` : `removed ${label}`,
      );
      continue;
    }
    if (isScalar(change.from) && isScalar(change.to)) {
      out.push(`${label} ${quoted(change.from)} -> ${quoted(change.to)}`);
      continue;
    }
    out.push(`${label} changed`);
  }
  return out;
}

/**
 * Variant-level drift that is not per-rule: the name, the description, and the rule *order*.
 *
 * Order is here rather than in the per-rule entries because it is not a property of any one rule:
 * every rule applies, in file order (D22), so two rules touching the same elements compose in the
 * order they are written and swapping them can change the result without either rule's own text
 * changing.
 */
export function variantLevelChanges(base: VariantSpec, head: VariantSpec): string[] {
  const out: string[] = [];
  if (base.variant !== head.variant) {
    out.push(`variant ${valued(base.variant)} -> ${valued(head.variant)}`);
  }
  if (base.description !== head.description) {
    out.push(`description ${valued(base.description)} -> ${valued(head.description)}`);
  }

  const shared = (rules: readonly VariantRule[], other: readonly VariantRule[]): string[] => {
    const ids = new Set(other.map((rule) => rule.id));
    return rules.filter((rule) => ids.has(rule.id)).map((rule) => rule.id);
  };
  // NUL as the separator, written as the escape `\u0000` rather than a literal byte: a literal
  // control character makes git and grep read the whole source file as binary. A rule id can hold
  // any printable character, so a printable separator would let two orders compare equal.
  const baseOrder = shared(base.rules, head.rules).join('\u0000');
  const headOrder = shared(head.rules, base.rules).join('\u0000');
  if (baseOrder !== headOrder) {
    out.push('rules reordered, which changes the order they are applied in');
  }

  return out;
}

/* ------------------------------------------------------------------ helpers */

interface Located {
  rule: VariantRule;
  index: number;
}

function indexById(rules: readonly VariantRule[]): Map<string, Located> {
  const out = new Map<string, Located>();
  rules.forEach((rule, index) => {
    if (!out.has(rule.id)) out.set(rule.id, { rule, index });
  });
  return out;
}

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function quoted(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
}

/** Like `quoted`, but names an absent value instead of rendering it as the string "undefined". */
function valued(value: unknown): string {
  return value === undefined ? 'unset' : quoted(value);
}
