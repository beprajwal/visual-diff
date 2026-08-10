/**
 * Canonical serialization of a VariantSpec (variants spec §4).
 *
 * Variants are committed files read back out of git history at the target SHA (§4 Storage, D4), so
 * the property the flow and scenario serializers protect matters here too: two variants that mean
 * the same thing must serialize identically, whatever order their keys were authored in. Canonical
 * form fixes key order, materializes the `clone` defaults, drops comments and never wraps long
 * lines.
 *
 * `scaffoldVariantSource` is the only writer today. The structural diff works on specs rather than
 * on text, so it does not depend on this — but a stable canonical form is what lets a reviewer read
 * `git diff` on a variant as a list of real changes.
 */

import { Document, isMap, isSeq } from 'yaml';
import { hasKey } from './schema.js';
import { VARIANT_VERBS, type CloneSpec, type VariantRule, type VariantSpec } from './types.js';

/** Key order inside `clone.from` — the source page first, then what to take from it. */
const CLONE_FROM_ORDER = ['step', 'url', 'match'] as const;

/** VariantSpec → canonical YAML. Always ends with a newline. */
export function serializeVariant(spec: VariantSpec): string {
  const doc = new Document(canonicalVariant(spec));

  const rules = doc.get('rules', true);
  if (isSeq(rules)) {
    for (const item of rules.items) {
      if (!isMap(item)) continue;
      // `style` and a relative `order` read as one line, the way every example in §4 writes them.
      setFlowStyle(item.get('style', true));
      setFlowStyle(item.get('order', true));
      const clone = item.get('clone', true);
      if (isMap(clone)) {
        setFlowStyle(clone.get('from', true));
        setFlowStyle(clone.get('position', true));
      }
    }
  }

  return doc.toString({ lineWidth: 0, minContentWidth: 0, singleQuote: false });
}

/** The plain object behind the canonical YAML. Exported for tests and for hashing. */
export function canonicalVariant(spec: VariantSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { version: 1, variant: spec.variant };
  if (spec.description !== undefined) out.description = spec.description;
  out.rules = spec.rules.map(canonicalRule);
  return out;
}

export function canonicalRule(rule: VariantRule): Record<string, unknown> {
  const out: Record<string, unknown> = { id: rule.id };
  if (rule.match !== undefined) out.match = rule.match;

  for (const verb of VARIANT_VERBS) {
    if (!hasKey(rule, verb)) continue;
    if (verb === 'clone' && rule.clone !== undefined) {
      out.clone = canonicalClone(rule.clone);
      continue;
    }
    if (verb === 'style' && rule.style !== undefined) {
      out.style = canonicalStyle(rule.style);
      continue;
    }
    out[verb] = (rule as unknown as Record<string, unknown>)[verb];
  }
  return out;
}

export function canonicalClone(clone: CloneSpec): Record<string, unknown> {
  return {
    from: pick(clone.from as unknown as Record<string, unknown>, CLONE_FROM_ORDER),
    into: clone.into,
    // Materialized on purpose: an omitted `position` and an explicit `position: append` are the
    // same clone, and a canonical form that kept the difference would show it as a diff. Same for
    // `times`.
    position: clone.position,
    times: clone.times,
  };
}

/**
 * Declaration order is preserved rather than sorted. CSS is order-sensitive — `padding` after
 * `padding-top` overwrites it — so sorting declarations would change what the variant means.
 */
function canonicalStyle(style: Record<string, string>): Record<string, string> {
  return { ...style };
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
