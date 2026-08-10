/**
 * Module edge for `variant/` (variants spec §4, §6, §7).
 *
 * Everything another module needs from the variant layer is re-exported here: parsing and
 * validation of the YAML spec, canonical serialization, CSS selector validation, the rule-id
 * structural diff, the `vdiff variant new` scaffold and the `vdiff variant list` summary. Nothing
 * outside this module reaches past this file.
 *
 * The layer is pure and dependency-light on purpose, exactly as `flow/` and `scenario/` are: no
 * filesystem beyond `readFile`, no Playwright, no store, and no DOM — a variant is validated as
 * text, and applied in-page by the runner (§9). Historical replay reads a variant out of git at the
 * target SHA (D4) and hands it here as text.
 *
 * The one dependency it does take is on the scenario layer's module edge, for `locateInDoc` /
 * `locateOffset` (the key-path-to-line resolver) and `formatIssues`. Those are spec-format-neutral,
 * `scenario/locate.ts` says in its own header that a third copy is the wrong answer, and the
 * scenario edge exports them — so this reaches that edge rather than past it.
 */

export {
  VARIANT_NONE,
  VARIANT_VERBS,
  type ClonePosition,
  type CloneSource,
  type CloneSpec,
  type OrderSpec,
  type RelativeTo,
  type StyleDeclarations,
  type VariantAttribution,
  type VariantName,
  type VariantRule,
  type VariantRuleBase,
  type VariantSpec,
  type VariantSummary,
  type VariantVerb,
} from './types.js';

export {
  CLONE_DEFAULTS,
  loadVariantFile,
  loadVariantSource,
  parseVariantFile,
  parseVariantSource,
  variantNameFromFile,
  type ParseOptions,
} from './parse.js';

export {
  validateVariantSpec,
  type ValidateOptions,
  type ValidateOutcome,
} from './validate.js';

export {
  isValidSelector,
  parseSelector,
  type SelectorFailure,
  type SelectorParseResult,
  type SelectorSuccess,
} from './selector.js';

export {
  canonicalClone,
  canonicalRule,
  canonicalVariant,
  serializeVariant,
} from './serialize.js';

export {
  describePlacement,
  describeRuleChanges,
  formatRuleChanges,
  ruleFieldChanges,
  structuralVariantDiff,
  variantLevelChanges,
  verbOf,
  type RuleFieldChange,
  type VariantDiffEntry,
  type VariantDiffInput,
  type VariantDiffStatus,
} from './structural-diff.js';

export {
  scaffoldVariantSource,
  scaffoldVariantSpec,
  type ScaffoldOptions,
} from './scaffold.js';

export {
  assertVariantName,
  isValidVariantName,
  variantFileName,
  variantNameIssue,
  variantRelPath,
  variantRepoPath,
  variantSummary,
} from './name.js';

export { VariantSpecError, isVariantSpecError } from './errors.js';

export {
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
  variantSpecSchema,
  type CloneInput,
  type VariantRuleInput,
  type VariantSpecInput,
} from './schema.js';
