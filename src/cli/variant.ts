/**
 * cli — the variant axis, as the CLI reads and prints it (variants spec §4, §5, §6).
 *
 * A variant is a declarative set of rules applied to the *rendered* page just before capture, so a
 * proposed UI change can be looked at without being built (D20). It cannot invent UI: every rule
 * operates on nodes the application already produced, and there is no HTML injection verb.
 *
 * The vocabulary itself — names, verbs, the spec shape — is the variant language layer's, and is
 * re-exported here rather than restated, so the CLI and the parser can never disagree about what a
 * rule is.
 *
 * The *run identity* half — `variantOf` / `isKept`, the tolerant reads of the two fields a run
 * carries; `classifyVariantPair`, which decides what a selected pair is once variants are in play;
 * and the sentences printed for those classifications — is likewise re-exported rather than
 * restated, from `report/variant.ts`. Both front-ends print those sentences, and the rule for what
 * counts as *the same revision* decides whether a proposal comparison is stated or warned about;
 * written down twice, the two copies would eventually disagree about which. The direction of the
 * import is the one that already exists — the CLI loads the report module to serve it — and what it
 * reaches for is a leaf: pure functions over `meta.json`, no server, no store, no Playwright.
 *
 * The classification is derived from the two runs' `meta.json` rather than from a field on the
 * stored `findings.json`, deliberately: a variant comparison is a fact about which two runs were
 * selected, so it stays answerable for a diff computed before this slice existed.
 */

import { SCENARIO_NONE } from '../types.js';

export {
  VARIANT_NONE,
  VARIANT_VERBS,
  type CloneSource,
  type CloneSpec,
  type ClonePosition,
  type OrderSpec,
  type StyleDeclarations,
  type VariantAttribution,
  type VariantName,
  type VariantRule,
  type VariantSpec,
  type VariantSummary,
  type VariantVerb,
} from '../variant/types.js';

export {
  classifyVariantPair,
  describeVariantPair,
  isEphemeralVariantRun,
  isKept,
  isVariantRun,
  sameRevision,
  showVariant,
  variantOf,
  type VariantPair,
  type VariantPairLabel,
  type VariantPairSide,
} from '../report/variant.js';

import {
  VARIANT_NONE,
  VARIANT_VERBS,
  type VariantName,
  type VariantRule,
  type VariantSpec,
  type VariantSummary,
  type VariantVerb,
} from '../variant/types.js';
import type { ValidationIssue } from '../types.js';

/** `--json` data for `vdiff variant new`. */
export interface VariantNewResult {
  variant: VariantName;
  /** Path of the written file, relative to the .visual-diff directory. */
  path: string;
}

/**
 * `--json` data for `vdiff variant check`. A failed check is a `CliError` at exit 2 carrying its
 * issues (variants spec §7), so this shape describes a variant that passed: the warnings are what a
 * valid variant still has to say about itself.
 */
export interface VariantCheckResult {
  variant: VariantSummary;
  warnings: ValidationIssue[];
}

/** `--json` data for `vdiff variant list`. */
export interface VariantListResult {
  variants: VariantSummary[];
}

/** Path of a variant file relative to the `.visual-diff` directory (variants spec §4 "Storage"). */
export function variantStorePath(name: VariantName): string {
  return `variants/${name}.yaml`;
}

/** The verb one rule carries. Exactly one is present by construction (D21). */
export function verbOf(rule: VariantRule): VariantVerb {
  const slots = rule as unknown as Record<string, unknown>;
  for (const verb of VARIANT_VERBS) {
    if (slots[verb] !== undefined) return verb;
  }
  // Unreachable for a parsed spec: the validator rejects a rule with no verb before it gets here.
  throw new Error(`variant rule '${rule.id}' carries no verb`);
}

/** Verbs a variant uses, deduplicated and in vocabulary order rather than first-seen order. */
export function verbsOf(spec: VariantSpec): VariantVerb[] {
  const seen = new Set<VariantVerb>();
  for (const rule of spec.rules) seen.add(verbOf(rule));
  return VARIANT_VERBS.filter((verb) => seen.has(verb));
}

/** Projects a parsed spec onto the summary row `list` and `check` both report. */
export function toVariantSummary(spec: VariantSpec): VariantSummary {
  const summary: VariantSummary = {
    name: spec.variant,
    ruleCount: spec.rules.length,
    verbs: verbsOf(spec),
    path: variantStorePath(spec.variant),
  };
  if (spec.description !== undefined) summary.description = spec.description;
  return summary;
}

/* ------------------------------------------------------------------ output (§5, §6) */

/** Names both axes of run identity beyond `(flow, revision)`, and nothing when there are none. */
export function identitySuffix(scenario: string, variant: VariantName): string {
  const parts: string[] = [];
  if (scenario !== SCENARIO_NONE) parts.push(`scenario ${scenario}`);
  if (variant !== VARIANT_NONE) parts.push(`variant ${variant}`);
  return parts.length === 0 ? '' : `  ${parts.join('  ')}`;
}
