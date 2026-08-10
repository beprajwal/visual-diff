/**
 * Turning an apply report into run warnings (variants spec §7).
 *
 * Three situations in §7's table are warnings rather than failures, and all three share one shape
 * with the never-matched scenario warning they are modelled on (mocking §8): **the run produced a
 * screenshot, and the screenshot is not what its label says it is**. That is the whole hazard of
 * this subsystem. A run that fails is annoying; a run that quietly hands back a picture of the
 * unmodified UI and calls it a proposal gets a decision made on it.
 *
 * So each message says three things, in order: which rule, what happened, and what the user is
 * therefore actually looking at.
 */

import type {
  CloneStyleDifference,
  RuleResult,
  VariantApplyReport,
  VariantWarning,
} from './types.js';

/** How many differing properties a clone warning names before it starts counting instead. */
export const MAX_REPORTED_STYLE_DIFFERENCES = 3;

/** Rules that changed nothing — a selector that matched no element, or worse (§7). */
export function unmatchedRuleIds(report: VariantApplyReport): string[] {
  return report.rules.filter((rule) => rule.outcome === 'unmatched').map((rule) => rule.ruleId);
}

/** Rules whose effect was gone by capture time, in file order (D22). */
export function revertedRuleIds(report: VariantApplyReport): string[] {
  return report.rules.filter((rule) => rule.outcome === 'reverted').map((rule) => rule.ruleId);
}

/** Rules that changed something and were still holding when the screenshot was taken. */
export function appliedRuleIds(report: VariantApplyReport): string[] {
  return report.rules.filter((rule) => rule.outcome === 'applied').map((rule) => rule.ruleId);
}

function withDetail(rule: RuleResult): string {
  return rule.detail === undefined ? `'${rule.ruleId}'` : `'${rule.ruleId}' (${rule.detail})`;
}

/**
 * The changed-nothing warning (§7), the sibling of mocking's never-matched rule warning.
 *
 * "A user believing they are looking at a denser layout, when a mistyped selector matched nothing,
 * has been actively misled" — so the warning names every silent rule and, through each rule's
 * `detail`, says why it was silent: a selector that matched nothing, a reference element that was
 * not there, a declaration the browser refused.
 */
export function unmatchedRulesWarning(report: VariantApplyReport): VariantWarning | null {
  const rules = report.rules.filter((rule) => rule.outcome === 'unmatched');
  if (rules.length === 0) return null;
  const ids = rules.map((rule) => rule.ruleId);
  const subject =
    rules.length === 1
      ? `rule ${withDetail(rules[0] as RuleResult)} changed nothing`
      : `${rules.length} rules changed nothing (${rules.map(withDetail).join('; ')})`;
  return {
    kind: 'variant-rule-unmatched',
    message:
      `variant '${report.variant}': ${subject} during this run — those parts of the page are the ` +
      'unmodified UI, so what was captured is not the proposal it is labelled as.',
    rules: ids,
  };
}

/**
 * **The D22 warning.** Rules that were applied and no longer held when the page was captured.
 *
 * D22 chose to apply rules once rather than re-apply them under a `MutationObserver`, because
 * fighting a reconciler risks a page that never settles. The specific failure that choice creates
 * is an app re-rendering between mutation and capture and silently reverting the variant. This
 * warning is the entire mitigation: it converts a screenshot that is wrong in a way nobody can see
 * into a run that says so.
 */
export function revertedRulesWarning(report: VariantApplyReport): VariantWarning | null {
  const rules = report.rules.filter((rule) => rule.outcome === 'reverted');
  if (rules.length === 0) return null;
  const ids = rules.map((rule) => rule.ruleId);
  const subject =
    rules.length === 1
      ? `rule ${withDetail(rules[0] as RuleResult)} was applied but had been reverted before capture`
      : `${rules.length} rules were applied but had been reverted before capture ` +
        `(${rules.map(withDetail).join('; ')})`;
  return {
    kind: 'variant-rule-reverted',
    message:
      `variant '${report.variant}': ${subject} — the application re-rendered after the variant was ` +
      'applied, so the screenshot shows the unmodified UI for those elements. Rules are applied ' +
      'once, after the settle gate; a screen that keeps re-rendering past it cannot be varied this way.',
    rules: ids,
  };
}

function describeDifferences(differences: readonly CloneStyleDifference[]): string {
  const named = differences.slice(0, MAX_REPORTED_STYLE_DIFFERENCES);
  const rendered = named
    .map((difference) => `${difference.property} '${difference.source}' → '${difference.target}'`)
    .join(', ');
  const overflow = differences.length - named.length;
  return overflow > 0 ? `${rendered}, and ${overflow} more` : rendered;
}

/**
 * The unstyled-clone warning (§4, §7).
 *
 * CSS-in-JS injects its rules when a component mounts, so a component cloned onto a page where it
 * never mounted can arrive with no rules at all. **An unstyled clone is a misleading preview, not a
 * failed one** — it renders, it looks like a decision can be made from it, and it is wrong — which
 * is why a material difference between the clone's computed styles here and at its source is worth
 * a warning of its own.
 */
export function cloneStyleWarnings(report: VariantApplyReport): VariantWarning[] {
  const out: VariantWarning[] = [];
  for (const rule of report.rules) {
    const check = rule.clone;
    if (check === undefined || !check.material) continue;
    out.push({
      kind: 'variant-clone-unstyled',
      message:
        `variant '${report.variant}' rule '${rule.ruleId}': the element cloned from ${check.origin} ` +
        `renders differently here than at its source — ${check.differences.length} of ` +
        `${check.compared} compared style properties differ ` +
        `(${describeDifferences(check.differences)}). An unstyled clone is a misleading preview, ` +
        "not a failed one: check that the source page's injected styles reached this page.",
      rules: [rule.ruleId],
    });
  }
  return out;
}

/** Every warning this report produces, in the order a report should show them (§7). */
export function variantWarnings(report: VariantApplyReport): VariantWarning[] {
  const out: VariantWarning[] = [];
  const unmatched = unmatchedRulesWarning(report);
  if (unmatched !== null) out.push(unmatched);
  const reverted = revertedRulesWarning(report);
  if (reverted !== null) out.push(reverted);
  out.push(...cloneStyleWarnings(report));
  return out;
}

/** True when every rule in the variant did what it said and was still doing it at capture time. */
export function variantHeld(report: VariantApplyReport): boolean {
  return report.rules.every((rule) => rule.outcome === 'applied');
}
