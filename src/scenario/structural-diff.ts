/**
 * Structural diff of two scenario versions, keyed by rule id (mocking spec D11, §5).
 *
 * This is the concrete payoff of D11 — "scenarios are declarative YAML, not code". The decision
 * record states the cost of the rejected alternative in exactly these terms: "two versions of a
 * scenario cannot be compared structurally, so the report cannot say which rule changed a response
 * without runtime instrumentation. As data, a rule id is attribution for free." This file is that
 * comparison, and it exists for the same reason `flow/structural-diff.ts` does.
 *
 * Alignment is by rule id and never by position, exactly as steps align under D4: reordering rules
 * changes which one wins a request, but it does not make two unrelated rules each other's history.
 * Position is reported through `baseIndex`/`headIndex` instead, and a reordering that changes
 * nothing else still shows up as a scenario-level note, because first match wins in file order and
 * so the order is part of the meaning.
 *
 * Pure: two specs in, entries out. No filesystem, no YAML, no runtime.
 */

import {
  RESPONSE_VERBS,
  type ResponseVerb,
  type ScenarioRule,
  type ScenarioSpec,
} from '../types.js';
import { canonicalRule } from './serialize.js';

export type ScenarioDiffStatus = 'matched' | 'added' | 'removed' | 'changed';

export interface ScenarioDiffEntry {
  id: string;
  status: ScenarioDiffStatus;
  /** Human-readable summary of what changed, present only on `changed`. */
  detail?: string;
  /** Position in the base rule list, or null when the rule is new. */
  baseIndex: number | null;
  /** Position in the head rule list, or null when the rule was removed. */
  headIndex: number | null;
}

/** One field-level difference between two versions of the same rule. */
export interface RuleFieldChange {
  /** Dotted key, e.g. `match.url`, `respond.status`, `verb`. */
  key: string;
  /** `undefined` when the field is absent in base. */
  from: unknown;
  /** `undefined` when the field is absent in head. */
  to: unknown;
}

export interface ScenarioDiffInput {
  base: ScenarioSpec;
  head: ScenarioSpec;
}

/** Fields compared on every rule, in report order. */
const MATCH_FIELDS = ['method', 'url', 'nth'] as const;

/**
 * Align two scenarios by rule id.
 *
 * Output order follows the head spec, with rules that exist only in base spliced in at the point
 * they disappeared from, so the result reads like the head scenario with deletions visible — the
 * same traversal `structuralFlowDiff` uses, for the same reason: a reordered rule must not drag
 * unrelated deletions to the front.
 */
export function structuralScenarioDiff(input: ScenarioDiffInput): ScenarioDiffEntry[] {
  const baseRules = input.base.rules ?? [];
  const headRules = input.head.rules ?? [];

  const baseById = indexById(baseRules);
  const headById = indexById(headRules);

  const entryFor = (id: string): ScenarioDiffEntry => {
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

  const entries: ScenarioDiffEntry[] = [];
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

/** The response verb a rule is built around, or `null` for a rule carrying only a `delay`. */
export function verbOf(rule: ScenarioRule): ResponseVerb | null {
  for (const verb of RESPONSE_VERBS) {
    if (Object.prototype.hasOwnProperty.call(rule, verb)) return verb;
  }
  return null;
}

/**
 * Field-level differences between two versions of the same rule.
 *
 * Both sides are canonicalized first — the same canonical form the serializer writes — so that
 * reformatting a scenario, or writing `match: { url: x, method: GET }` in the other order, is not a
 * change. When the *verb itself* changed, only `verb` is reported and not also the old and new
 * bodies: "patch -> respond" says everything, and listing both payloads underneath it says nothing
 * more.
 */
export function ruleFieldChanges(base: ScenarioRule, head: ScenarioRule): RuleFieldChange[] {
  const changes: RuleFieldChange[] = [];

  for (const field of MATCH_FIELDS) {
    const from = base.match[field];
    const to = head.match[field];
    if (jsonOf(from) === jsonOf(to)) continue;
    changes.push({ key: `match.${field}`, from, to });
  }

  const baseVerb = verbOf(base);
  const headVerb = verbOf(head);
  if (baseVerb !== headVerb) {
    changes.push({ key: 'verb', from: baseVerb ?? undefined, to: headVerb ?? undefined });
  } else if (headVerb !== null) {
    changes.push(...verbBodyChanges(headVerb, base, head));
  }

  if (jsonOf(base.delay) !== jsonOf(head.delay)) {
    changes.push({ key: 'delay', from: base.delay, to: head.delay });
  }

  return changes;
}

function verbBodyChanges(
  verb: ResponseVerb,
  base: ScenarioRule,
  head: ScenarioRule,
): RuleFieldChange[] {
  if (verb === 'abort') return [];

  const baseCanonical = canonicalRule(base);
  const headCanonical = canonicalRule(head);

  if (verb === 'respond') {
    const from = base.respond;
    const to = head.respond;
    if (from === undefined || to === undefined) return [];
    const changes: RuleFieldChange[] = [];
    if (from.status !== to.status) {
      changes.push({ key: 'respond.status', from: from.status, to: to.status });
    }
    if (jsonOf(from.headers) !== jsonOf(to.headers)) {
      changes.push({ key: 'respond.headers', from: from.headers, to: to.headers });
    }
    if (jsonOf(from.body) !== jsonOf(to.body)) {
      changes.push({ key: 'respond.body', from: from.body, to: to.body });
    }
    return changes;
  }

  if (jsonOf(baseCanonical[verb]) === jsonOf(headCanonical[verb])) return [];
  return [{ key: verb, from: baseCanonical[verb], to: headCanonical[verb] }];
}

/** Human-readable, machine-stable description of the differences between two same-id rules. */
export function describeRuleChanges(base: ScenarioRule, head: ScenarioRule): string[] {
  return formatRuleChanges(ruleFieldChanges(base, head));
}

/**
 * Renders field-level changes as the strings the report shows on a changed rule.
 *
 * A scalar reads `url '**​/a' -> '**​/b'`; a field that appeared or disappeared reads
 * `added delay 3000` / `removed nth 2`; and a structured payload reads `patch changed` rather than
 * being dumped, because these strings live in a tooltip and a whole merge patch is unreadable there.
 */
export function formatRuleChanges(changes: readonly RuleFieldChange[]): string[] {
  const out: string[] = [];
  for (const change of changes) {
    const label = change.key.startsWith('match.') ? change.key.slice('match.'.length) : change.key;

    if (change.from === undefined) {
      out.push(isScalar(change.to) ? `added ${label} ${quoted(change.to)}` : `added ${label}`);
      continue;
    }
    if (change.to === undefined) {
      out.push(isScalar(change.from) ? `removed ${label} ${quoted(change.from)}` : `removed ${label}`);
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
 * Scenario-level drift that is not per-rule: the mode, the description, and the rule *order*.
 *
 * Order is here rather than in the per-rule entries because it is not a property of any one rule:
 * first match wins in file order (§5), so moving a broad rule above a narrow one silently disables
 * the narrow one without either rule's own text changing.
 */
export function scenarioLevelChanges(base: ScenarioSpec, head: ScenarioSpec): string[] {
  const out: string[] = [];
  if (base.scenario !== head.scenario) {
    out.push(`scenario ${valued(base.scenario)} -> ${valued(head.scenario)}`);
  }
  if (base.mode !== head.mode) out.push(`mode ${valued(base.mode)} -> ${valued(head.mode)}`);
  if (base.description !== head.description) {
    out.push(`description ${valued(base.description)} -> ${valued(head.description)}`);
  }

  const shared = (rules: readonly ScenarioRule[], other: readonly ScenarioRule[]): string[] => {
    const ids = new Set(other.map((rule) => rule.id));
    return rules.filter((rule) => ids.has(rule.id)).map((rule) => rule.id);
  };
  // NUL as the separator, written as the escape `\u0000` rather than a literal byte: a literal
  // control character makes git and grep read the whole source file as binary. A rule id can hold
  // any printable character, so a printable separator would let two orders compare equal.
  const baseOrder = shared(base.rules, head.rules).join('\u0000');
  const headOrder = shared(head.rules, base.rules).join('\u0000');
  if (baseOrder !== headOrder) {
    out.push('rules reordered, which changes which rule wins a request');
  }

  return out;
}

/* ------------------------------------------------------------------ helpers */

interface Located {
  rule: ScenarioRule;
  index: number;
}

function indexById(rules: readonly ScenarioRule[]): Map<string, Located> {
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

/** Distinguishes an absent field from any JSON value, which `JSON.stringify` alone does not. */
function jsonOf(value: unknown): string {
  return value === undefined ? ' unset' : JSON.stringify(value);
}
