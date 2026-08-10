/**
 * Variant application: the rules of §4 turned into changes to a rendered page, and the D22
 * verification pass that says whether they were still true when the shutter fell.
 *
 * ```ts
 * // …in the runner, after the settle gate and before masking (§9):
 * const sources = new Map<string, ExtractedClone>();
 * for (const rule of spec.rules.filter((r) => r.clone !== undefined)) {
 *   const found = await sourcePage.evaluate(extractCloneSourceInPage, cloneExtractArgs(name, rule));
 *   sources.set(rule.id, cloneSourceFrom(name, found));        // throws, naming the rule
 * }
 * const args = buildVariantApplyArgs({ variant: name, rules: spec.rules, cloneSources: sources });
 * const report = await page.evaluate(applyVariantInPage, args);
 * for (const warning of variantWarnings(report)) run.warn(warning);
 * // …mask, then screenshot…
 * ```
 *
 * The split down the middle of this module is the thing to keep: `plan.ts` decides everything that
 * can be decided in Node, `inpage.ts` does only what must happen inside the page, and the report
 * comes back as data so warnings and attribution are built where they can be tested. It is the same
 * shape `mocking/` uses, where the engine decides and the runner executes.
 *
 * This file is also the **module edge for the whole variants slice**, which is why the variant
 * *language* — parsing, validation, serialization, scaffolding, the structural diff and the name
 * rules — is re-exported here from `../variant/`. The CLI binds one specifier per subsystem
 * (`cli/deps.ts#MODULE_SPECIFIERS`) and loads it on first use, so `vdiff variant check` must reach
 * parsing, the file layout and this module through one import. The dependency runs one way only:
 * `variant-apply/` imports `variant/`, never the reverse.
 *
 * The re-export is a named list rather than `export *`, for the reason `mocking/index.ts` gives:
 * `variant/` also exports a `verbOf`, a `CloneSource` and a `VariantAttribution`, each with a
 * near-namesake here, and re-exporting wholesale would make which one a caller gets depend on the
 * order of two `export *` lines.
 *
 * A variant **cannot invent UI** (§2). There is no verb here that introduces markup: `clone` copies
 * an element the application already rendered, at the same revision, and everything else moves,
 * restyles, retexts or hides what is already on the page.
 */

export {
  VARIANT_ATTRS,
  VARIANT_CLONE_ATTR,
  VARIANT_STYLE_ATTR,
  type ApplicableClone,
  type ApplicableRule,
  type AppliedRule,
  type AttributedElement,
  type ClonePlacement,
  type CloneExtractArgs,
  type CloneExtractResult,
  type CloneStyleCheck,
  type CloneStyleDifference,
  type ExtractedClone,
  type OrderPlacement,
  type ResolvedClone,
  type ResolvedDeclaration,
  type RuleOutcome,
  type RuleResult,
  type VariantApplyArgs,
  type VariantApplyReport,
  type VariantWarning,
  type VariantWarningKind,
} from './types.js';

export {
  VariantError,
  variantRuleLabel,
  type VariantErrorCode,
  type VariantErrorInit,
  type VariantFailureKind,
} from './errors.js';

export {
  CLONE_STYLE_IGNORED,
  CLONE_STYLE_PROPS,
  DEFAULT_CLONE_POSITION,
  DEFAULT_CLONE_TIMES,
  appliedRule,
  buildVariantApplyArgs,
  cloneExtractArgs,
  cloneOrigin,
  cloneRuleIds,
  cloneSourceFrom,
  clonePlacement,
  cssPropertyName,
  orderPlacement,
  styleDeclarations,
  variantVerbOf,
  verbsOf,
  type BuildArgsOptions,
  type CloneExtractOptions,
} from './plan.js';

export { applyVariantInPage, extractCloneSourceInPage } from './inpage.js';

export {
  MAX_REPORTED_STYLE_DIFFERENCES,
  appliedRuleIds,
  cloneStyleWarnings,
  revertedRuleIds,
  revertedRulesWarning,
  unmatchedRuleIds,
  unmatchedRulesWarning,
  variantHeld,
  variantWarnings,
} from './warnings.js';

export { listVariants, variantFile, variantsDir } from './paths.js';

/*
 * The variant language, re-exported (see the header).
 */
export {
  CLONE_DEFAULTS,
  CLONE_FROM_KEYS,
  CLONE_KEYS,
  ORDER_KEYWORDS,
  POSITION_KEYWORDS,
  RELATIVE_KEYS,
  RULE_KEYS,
  SAFE_STEP_ID_RE,
  SAFE_VARIANT_NAME_RE,
  VARIANTS_DIRNAME,
  VARIANT_KEYS,
  VARIANT_NONE,
  VARIANT_VERBS,
  VariantSpecError,
  assertVariantName,
  canonicalClone,
  canonicalRule,
  canonicalVariant,
  describePlacement,
  describeRuleChanges,
  formatRuleChanges,
  isValidSelector,
  isValidVariantName,
  isVariantSpecError,
  loadVariantFile,
  loadVariantSource,
  parseSelector,
  parseVariantFile,
  parseVariantSource,
  ruleFieldChanges,
  scaffoldVariantSource,
  scaffoldVariantSpec,
  serializeVariant,
  structuralVariantDiff,
  validateVariantSpec,
  variantFileName,
  variantLevelChanges,
  variantNameFromFile,
  variantNameIssue,
  variantRelPath,
  variantRepoPath,
  variantSummary,
  variantSpecSchema,
  verbOf,
  type ClonePosition,
  type CloneSpec,
  type CloneSource,
  type OrderSpec,
  type RelativeTo,
  type RuleFieldChange,
  type SelectorFailure,
  type SelectorParseResult,
  type SelectorSuccess,
  type StyleDeclarations,
  type ValidateOptions,
  type ValidateOutcome,
  type VariantAttribution,
  type VariantDiffEntry,
  type VariantDiffInput,
  type VariantDiffStatus,
  type VariantName,
  type VariantRule,
  type VariantRuleBase,
  type VariantSpec,
  type VariantSummary,
  type VariantVerb,
} from '../variant/index.js';
