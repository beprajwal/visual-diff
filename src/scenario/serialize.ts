/**
 * Canonical serialization of a ScenarioSpec (mocking spec §5).
 *
 * Scenarios are committed files read back out of git history at the target SHA (D4), so the same
 * property the flow serializer protects matters here: two scenarios that mean the same thing must
 * serialize identically, whatever order their keys were authored in. Canonical form fixes key
 * order, materializes the `mode` default, drops comments and never wraps long lines.
 *
 * `scaffoldScenarioSource` is the only writer today. The structural diff works on specs rather than
 * on text, so it does not depend on this — but a stable canonical form is what lets a reviewer read
 * `git diff` on a scenario as a list of real changes.
 */

import { Document, isMap, isSeq } from 'yaml';
import { RESPONSE_VERBS, type JsonPatchOperation, type ScenarioRule, type ScenarioSpec } from '../types.js';
import { hasKey } from './schema.js';

/** Key order inside `match`. */
const MATCH_ORDER = ['method', 'url', 'nth'] as const;
/** Key order inside `respond`. */
const RESPOND_ORDER = ['status', 'headers', 'body'] as const;
/** Key order inside one RFC 6902 operation. */
const PATCH_OP_ORDER = ['op', 'from', 'path', 'value'] as const;

/** ScenarioSpec → canonical YAML. Always ends with a newline. */
export function serializeScenario(spec: ScenarioSpec): string {
  const doc = new Document(canonicalScenario(spec));

  const rules = doc.get('rules', true);
  if (isSeq(rules)) {
    for (const item of rules.items) {
      if (!isMap(item)) continue;
      // `match` reads as one line, the way every example in the spec writes it.
      setFlowStyle(item.get('match', true));
      const patchOps = item.get('patchOps', true);
      if (isSeq(patchOps)) {
        for (const op of patchOps.items) setFlowStyle(op);
      }
    }
  }

  return doc.toString({ lineWidth: 0, minContentWidth: 0, singleQuote: false });
}

/** The plain object behind the canonical YAML. Exported for tests and for hashing. */
export function canonicalScenario(spec: ScenarioSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { version: 1, scenario: spec.scenario };
  if (spec.description !== undefined) out.description = spec.description;
  // Materialized on purpose: an omitted `mode` and an explicit `mode: overlay` are the same
  // scenario, and a canonical form that kept the difference would show it as a diff.
  out.mode = spec.mode;
  out.rules = spec.rules.map(canonicalRule);
  return out;
}

export function canonicalRule(rule: ScenarioRule): Record<string, unknown> {
  const out: Record<string, unknown> = { id: rule.id, match: canonicalMatch(rule.match) };

  for (const verb of RESPONSE_VERBS) {
    if (!hasKey(rule, verb)) continue;
    if (verb === 'respond' && rule.respond !== undefined) {
      out.respond = pick(rule.respond as unknown as Record<string, unknown>, RESPOND_ORDER);
      continue;
    }
    if (verb === 'patchOps' && rule.patchOps !== undefined) {
      out.patchOps = rule.patchOps.map(canonicalPatchOp);
      continue;
    }
    out[verb] = (rule as unknown as Record<string, unknown>)[verb];
  }

  // Last, because it is a modifier on whatever verb precedes it.
  if (rule.delay !== undefined) out.delay = rule.delay;
  return out;
}

export function canonicalPatchOp(op: JsonPatchOperation): Record<string, unknown> {
  return pick(op as unknown as Record<string, unknown>, PATCH_OP_ORDER);
}

function canonicalMatch(match: ScenarioRule['match']): Record<string, unknown> {
  return pick(match as unknown as Record<string, unknown>, MATCH_ORDER);
}

/** Copy the named keys, in order, skipping absent ones but keeping explicit nulls. */
function pick(
  source: Record<string, unknown>,
  order: ReadonlyArray<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (!hasKey(source, key)) continue;
    if (source[key] === undefined) continue;
    out[key] = source[key];
  }
  return out;
}

function setFlowStyle(node: unknown): void {
  if (isSeq(node) || isMap(node)) node.flow = true;
}
