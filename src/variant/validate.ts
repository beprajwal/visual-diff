/**
 * Post-schema semantic validation of a variant spec — variants spec §7, in full.
 *
 * §8 item 5 asks for "validator messages, one per rejection in §7, asserting the text". That is the
 * constraint this file is written under: every issue explains what the tool will not do and what to
 * write instead, and every issue names the offending key so the CLI can print file + line + key and
 * exit 2.
 *
 * The §7 list and where it lives:
 *
 *   unknown keys                      → `parse.ts` (zod `unrecognized_keys`, `.strict()` shapes)
 *   missing rule `id`                 → `parse.ts` (zod), duplicate ids here
 *   missing `match`                   → here (which verbs need one depends on the verb)
 *   two verbs on one rule             → here
 *   `clone.from` neither step nor url → here, and "both" here too
 *   unparseable selector              → here, via `selector.ts`
 *   `order`/`position` selectors      → here, same path
 *   `times` below 1                   → here
 *   `variant:` vs the filename        → here
 *   `none` reserved                   → here, and in `parse.ts` for the filename
 *   clone source step not in the flow → here, when the caller passes `flowStepIds` (§7 wants this
 *                                       "before the run starts", which is what that option is for)
 *
 * Four rejections are stricter than a literal reading of §4, and each is called out where it is
 * raised. All four exist because the alternative is a *silent* no-op, and §1 is unambiguous that a
 * variant which quietly did nothing while claiming to be a preview has actively misled its reader:
 * a camel-cased CSS property, a `!important` suffix, an empty style value, and a selector naming a
 * pseudo-element are each accepted by the browser API and each do nothing at all.
 */

import type { SourceLocation, ValidationIssue } from '../types.js';
import type { Locate } from '../scenario/index.js';
import { parseSelector } from './selector.js';
import {
  CLONE_FROM_KEYS,
  ORDER_KEYWORDS,
  POSITION_KEYWORDS,
  RELATIVE_KEYS,
  SAFE_STEP_ID_RE,
  SAFE_VARIANT_NAME_RE,
  VARIANTS_DIRNAME,
  hasKey,
  type CloneInput,
  type VariantRuleInput,
  type VariantSpecInput,
} from './schema.js';
import { VARIANT_NONE, VARIANT_VERBS, type VariantVerb } from './types.js';

export interface ValidateOptions {
  /**
   * The name the file claims by its own filename. A disagreement is an **error**, as it is for a
   * scenario: a run records the variant it used by name (§5) and looks the file up by that name, so
   * the two disagreeing means one of them is a lie.
   */
  expectVariantName?: string;
  /**
   * Step ids of the flow this variant will be run against. When given, a `clone.from.step` naming
   * a step the flow does not have is an error — §7: "clone source step not in the flow → exit 2,
   * before the run starts". Omitted when validating a variant on its own (`vdiff variant check`
   * without a flow), because the answer then genuinely is not knowable.
   */
  flowStepIds?: readonly string[];
}

export interface ValidateOutcome {
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** The four verbs that act on elements the rule's own `match` selects. */
const IN_PLACE_VERBS: readonly VariantVerb[] = ['style', 'text', 'hide', 'order'];

/**
 * Written with `\u` escapes rather than the characters themselves: a literal control byte in a
 * source file makes git, grep and every diff tool treat the whole file as binary.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** `padding`, `-webkit-line-clamp`, `--brand-gap`. */
const CSS_PROPERTY_RE = /^(?:--[A-Za-z0-9_-]+|-?[A-Za-z][A-Za-z0-9-]*)$/;

/** A value that would end one declaration and start another if this were a `style` attribute. */
const DECLARATION_BREAKERS = /[;{}]/;

export function validateVariantSpec(
  input: VariantSpecInput,
  locate: Locate,
  options: ValidateOptions = {},
): ValidateOutcome {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  validateIdentity(input, locate, options, issues);

  const seenIds = new Map<string, number>();
  input.rules.forEach((rule, index) => {
    validateRuleId(rule, index, locate, seenIds, issues);
    validateVerbs(rule, index, locate, options, issues);
    validateOverride(input.rules, rule, index, locate, warnings);
  });

  return { issues, warnings };
}

/* ------------------------------------------------------------------ identity */

function validateIdentity(
  input: VariantSpecInput,
  locate: Locate,
  options: ValidateOptions,
  issues: ValidationIssue[],
): void {
  const name = input.variant;

  if (name === VARIANT_NONE) {
    issues.push({
      code: 'reserved-variant-name',
      message:
        `'${VARIANT_NONE}' is a reserved variant name: it is what a run captured without a ` +
        'variant records in meta.json, and what a variant run is diffed against, so no variant ' +
        'file may take it. Pick another name',
      at: locate(['variant']),
    });
  } else if (!SAFE_VARIANT_NAME_RE.test(name)) {
    issues.push({
      code: 'invalid-variant-name',
      message:
        `invalid variant name '${name}': a variant is stored as ` +
        `.visual-diff/${VARIANTS_DIRNAME}/<name>.yaml and named in meta.json, so it must start ` +
        'with a letter or digit and contain only letters, digits, dot, dash or underscore',
      at: locate(['variant']),
    });
  }

  const expected = options.expectVariantName;
  if (expected !== undefined && expected !== name) {
    issues.push({
      code: 'variant-name-mismatch',
      message:
        `variant is named '${name}' but the file is named '${expected}.yaml': the two must agree, ` +
        'because a run records the variant by name and later looks the file up by it',
      at: locate(['variant']),
    });
  }

  if (input.description !== undefined && input.description.trim() === '') {
    issues.push({
      code: 'empty-description',
      message: 'description is empty: give it a sentence or remove the key',
      at: locate(['description']),
    });
  }
}

/* ------------------------------------------------------------------ rule identity */

function validateRuleId(
  rule: VariantRuleInput,
  index: number,
  locate: Locate,
  seenIds: Map<string, number>,
  issues: ValidationIssue[],
): void {
  const at = locate(['rules', index, 'id']);

  if (rule.id === '') {
    issues.push({
      code: 'invalid-rule-id',
      message:
        'rule id is empty: an id is required and stable, because it is what the report names when ' +
        'it attributes a modified element, what the never-matched warning lists, and what lets ' +
        'two versions of a variant be compared',
      at,
    });
    return;
  }
  if (rule.id !== rule.id.trim() || CONTROL_CHARS.test(rule.id)) {
    issues.push({
      code: 'invalid-rule-id',
      message:
        `invalid rule id ${JSON.stringify(rule.id)}: a rule id is printed in run warnings and in ` +
        'the report, so it may not have surrounding whitespace or control characters',
      at,
    });
    return;
  }

  const first = seenIds.get(rule.id);
  if (first !== undefined) {
    issues.push({
      code: 'duplicate-rule-id',
      message:
        `duplicate rule id '${rule.id}' (already used by rules[${first}]). Rule ids are how a ` +
        'modified element is attributed and how two versions of a variant are compared, so they ' +
        'must be unique within a variant',
      at,
    });
    return;
  }
  seenIds.set(rule.id, index);
}

/* ------------------------------------------------------------------ verbs */

function verbsOf(rule: VariantRuleInput): VariantVerb[] {
  return VARIANT_VERBS.filter((verb) => hasKey(rule, verb));
}

function validateVerbs(
  rule: VariantRuleInput,
  index: number,
  locate: Locate,
  options: ValidateOptions,
  issues: ValidationIssue[],
): void {
  const present = verbsOf(rule);

  if (present.length === 0) {
    issues.push({
      code: 'no-verb',
      message:
        `rule '${rule.id}' does nothing: a rule needs exactly one of ` +
        `${VARIANT_VERBS.join(', ')}. There is no verb that takes markup — a variant rearranges ` +
        'what the application already renders, it does not add UI to it',
      at: locate(['rules', index]),
    });
    return;
  }

  if (present.length > 1) {
    // Reported once per verb after the first, so `--json` consumers can point at each key.
    for (const verb of present.slice(1)) {
      issues.push({
        code: 'two-verbs',
        message:
          `rule '${rule.id}' has ${present.length} verbs (${present.join(', ')}): a rule takes ` +
          'exactly one, so that the tool never has to invent a precedence order between them. ' +
          'Split them into separate rules — they apply in file order',
        at: locate(['rules', index, verb]),
      });
    }
    return;
  }

  const verb = present[0] as VariantVerb;
  validateMatch(rule, index, verb, locate, issues);

  if (verb === 'style') validateStyle(rule, index, locate, issues);
  if (verb === 'order') {
    const path = ['rules', index, 'order'] as const;
    validatePlacement(rule.order, path, 'order', ORDER_KEYWORDS, rule.id, locate, issues);
  }
  if (rule.clone !== undefined) validateClone(rule.clone, rule.id, index, locate, options, issues);
}

/* ------------------------------------------------------------------ match */

function validateMatch(
  rule: VariantRuleInput,
  index: number,
  verb: VariantVerb,
  locate: Locate,
  issues: ValidationIssue[],
): void {
  const at = locate(['rules', index, 'match']);

  if (!IN_PLACE_VERBS.includes(verb)) {
    if (rule.match !== undefined) {
      issues.push({
        code: 'unexpected-match',
        message:
          `rule '${rule.id}' is a clone and also has a match: a clone names the element it copies ` +
          'with clone.from.match and the element it copies into with clone.into, so a third ' +
          'selector has nothing to select. Remove match',
        at,
      });
    }
    return;
  }

  if (rule.match === undefined) {
    issues.push({
      code: 'missing-match',
      message:
        `rule '${rule.id}' is missing required key 'match': ${verb} acts on elements the ` +
        'application already rendered, so the rule has to say which ones — e.g. ' +
        "match: \"[data-test=forecast-card]\"",
      at,
    });
    return;
  }
  if (rule.match.trim() === '') {
    issues.push({
      code: 'missing-match',
      message:
        `rule '${rule.id}' has an empty match: a match is a CSS selector over the rendered page, ` +
        "so it must name one — e.g. match: \"[data-test=forecast-card]\"",
      at,
    });
    return;
  }
  checkSelector(rule.match, at, `rule '${rule.id}' has an invalid match`, issues);
}

/* ------------------------------------------------------------------ style */

function validateStyle(
  rule: VariantRuleInput,
  index: number,
  locate: Locate,
  issues: ValidationIssue[],
): void {
  const at = locate(['rules', index, 'style']);
  const style = rule.style;

  if (!isPlainObject(style)) {
    issues.push({
      code: 'invalid-style',
      message:
        `rule '${rule.id}' has a style that is ${describeType(style)}: style is a mapping of CSS ` +
        'declarations, as in style: { padding: 8px, gap: 4px }',
      at,
    });
    return;
  }

  const properties = Object.keys(style);
  if (properties.length === 0) {
    issues.push({
      code: 'empty-style',
      message:
        `rule '${rule.id}' has an empty style: a rule that declares nothing changes nothing, so ` +
        'either give it a declaration or delete the rule',
      at,
    });
    return;
  }

  for (const property of properties) {
    const propertyAt = locate(['rules', index, 'style', property]);

    // Stricter than §4 on purpose. `setProperty('paddingTop', …)` is accepted by the DOM and does
    // nothing: the CSSOM only knows hyphenated property names. The variant would render unchanged
    // and be reported as applied.
    if (/[A-Z]/.test(property) && !property.startsWith('--')) {
      issues.push({
        code: 'invalid-style-property',
        message:
          `rule '${rule.id}' sets '${property}', which is the DOM spelling of a CSS property: ` +
          'a style is written the way CSS writes it, hyphenated and lower-case, so use ' +
          `'${hyphenate(property)}'`,
        at: propertyAt,
      });
      continue;
    }
    if (!CSS_PROPERTY_RE.test(property)) {
      issues.push({
        code: 'invalid-style-property',
        message:
          `rule '${rule.id}' has an invalid CSS property name ${JSON.stringify(property)}: a ` +
          "property is a word such as 'padding', a vendor-prefixed '-webkit-line-clamp', or a " +
          "custom property '--brand-gap'",
        at: propertyAt,
      });
      continue;
    }

    validateStyleValue(rule.id, property, style[property], propertyAt, issues);
  }
}

function validateStyleValue(
  ruleId: string,
  property: string,
  value: unknown,
  at: SourceLocation,
  issues: ValidationIssue[],
): void {
  const push = (message: string): void => {
    issues.push({ code: 'invalid-style-value', message: `rule '${ruleId}' ${message}`, at });
  };

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      push(`sets '${property}' to ${describeNumber(value)}, which is not a CSS length or number`);
    }
    return;
  }
  if (typeof value !== 'string') {
    push(
      `sets '${property}' to ${describeType(value)}: a CSS declaration takes a value such as ` +
        "8px, 1.5 or 'none'",
    );
    return;
  }

  const trimmed = value.trim();
  // Stricter than §4: `setProperty(p, '')` removes the declaration instead of setting it, so an
  // empty value silently leaves the element exactly as the application rendered it.
  if (trimmed === '') {
    push(
      `sets '${property}' to an empty value, which removes the declaration rather than changing ` +
        "it. Write the value you want, e.g. 0 or 'none'",
    );
    return;
  }
  if (DECLARATION_BREAKERS.test(value)) {
    push(
      `sets '${property}' to ${JSON.stringify(value)}, which contains ; { or }: a style is one ` +
        'declaration per key, so write each property as its own entry',
    );
    return;
  }
  // Stricter than §4: `setProperty(p, 'x !important')` is rejected by the CSSOM and leaves the
  // property unset — the priority is a separate argument there, not part of the value.
  if (/!\s*important\s*$/i.test(trimmed)) {
    push(
      `sets '${property}' to ${JSON.stringify(value)}: a variant already writes an inline style, ` +
        'which beats every stylesheet rule, and !important in the value is silently discarded. ' +
        'Drop it',
    );
  }
}

/* ------------------------------------------------------------------ order / clone.position */

/**
 * `order` and `clone.position` are the same shape with different keywords: two words, or a
 * `{ before: … }` / `{ after: … }` pair naming a sibling. Sharing the walk keeps their messages
 * consistent, which matters because a user who has learned one has learned the other.
 */
function validatePlacement(
  value: unknown,
  path: ReadonlyArray<string | number>,
  label: 'order' | 'clone.position',
  keywords: readonly string[],
  ruleId: string,
  locate: Locate,
  issues: ValidationIssue[],
): void {
  const at = locate(path);
  const code = label === 'order' ? 'invalid-order' : 'invalid-position';
  const forms = `${keywords.join(', ')}, { before: <selector> } or { after: <selector> }`;
  const push = (message: string, where: SourceLocation = at): void => {
    issues.push({ code, message: `rule '${ruleId}' ${message}`, at: where });
  };

  if (typeof value === 'string') {
    if (keywords.includes(value)) return;
    push(`has ${label} ${JSON.stringify(value)}: ${label} takes ${forms}`);
    return;
  }

  if (!isPlainObject(value)) {
    push(`has a ${label} that is ${describeType(value)}: ${label} takes ${forms}`);
    return;
  }

  const unknownKeys = Object.keys(value).filter(
    (key) => !RELATIVE_KEYS.includes(key as 'before' | 'after'),
  );
  for (const key of unknownKeys) {
    push(
      `has an unknown key '${key}' in ${label}: a selector-relative ${label} is written ` +
        '{ before: <selector> } or { after: <selector> }',
      locate([...path, key]),
    );
  }
  if (unknownKeys.length > 0) return;

  const present = RELATIVE_KEYS.filter((key) => hasKey(value, key));
  if (present.length === 0) {
    push(`has an empty ${label}: ${label} takes ${forms}`);
    return;
  }
  if (present.length === 2) {
    push(
      `has both before and after in ${label}: an element goes on one side of its reference or ` +
        'the other, so give exactly one',
      locate([...path, 'after']),
    );
    return;
  }

  const key = present[0] as 'before' | 'after';
  const selector = value[key];
  const selectorAt = locate([...path, key]);
  if (typeof selector !== 'string' || selector.trim() === '') {
    push(
      `has ${label}.${key} set to ${describeType(selector)}: it is the selector of the element ` +
        `the match is placed ${key}`,
      selectorAt,
    );
    return;
  }
  checkSelector(selector, selectorAt, `rule '${ruleId}' has an invalid ${label}.${key} selector`, issues);
}

/* ------------------------------------------------------------------ clone */

function validateClone(
  clone: CloneInput,
  ruleId: string,
  index: number,
  locate: Locate,
  options: ValidateOptions,
  issues: ValidationIssue[],
): void {
  validateCloneSource(clone, ruleId, index, locate, options, issues);

  const intoAt = locate(['rules', index, 'clone', 'into']);
  if (clone.into.trim() === '') {
    issues.push({
      code: 'missing-into',
      message:
        `rule '${ruleId}' has an empty clone.into: it is the selector of the element the copy is ` +
        "placed into — e.g. into: \"[data-test=sidebar]\"",
      at: intoAt,
    });
  } else {
    checkSelector(clone.into, intoAt, `rule '${ruleId}' has an invalid clone.into`, issues);
  }

  if (hasKey(clone, 'position')) {
    validatePlacement(
      clone.position,
      ['rules', index, 'clone', 'position'],
      'clone.position',
      POSITION_KEYWORDS,
      ruleId,
      locate,
      issues,
    );
  }

  if (clone.times !== undefined) {
    const at = locate(['rules', index, 'clone', 'times']);
    if (!Number.isInteger(clone.times)) {
      issues.push({
        code: 'invalid-times',
        message:
          `rule '${ruleId}' has times ${describeNumber(clone.times)}: times counts how many ` +
          'copies to make, so it must be a whole number',
        at,
      });
    } else if (clone.times < 1) {
      issues.push({
        code: 'invalid-times',
        message:
          `rule '${ruleId}' has times ${clone.times}: times counts how many copies to make and ` +
          'so is at least 1. To preview the page without this element, delete the rule rather ' +
          'than cloning it zero times',
        at,
      });
    }
  }
}

function validateCloneSource(
  clone: CloneInput,
  ruleId: string,
  index: number,
  locate: Locate,
  options: ValidateOptions,
  issues: ValidationIssue[],
): void {
  const from = clone.from;
  const fromAt = locate(['rules', index, 'clone', 'from']);
  const hasStep = from.step !== undefined;
  const hasUrl = from.url !== undefined;

  if (!hasStep && !hasUrl) {
    issues.push({
      code: 'invalid-clone-source',
      message:
        `rule '${ruleId}' has a clone.from with neither step nor url: a clone comes from a step ` +
        'of this same run, or from a url visited during it — both are the same revision as the ' +
        'target, which is what keeps a variant a preview rather than two revisions composited ' +
        `together. Give exactly one of ${CLONE_FROM_KEYS.slice(0, 2).join(' or ')}`,
      at: fromAt,
    });
  } else if (hasStep && hasUrl) {
    issues.push({
      code: 'invalid-clone-source',
      message:
        `rule '${ruleId}' has a clone.from with both step and url: a clone has one source, and ` +
        'the tool will not invent a precedence between them. Keep step for a page the flow ' +
        'already visits, url for one it never does',
      at: locate(['rules', index, 'clone', 'from', 'url']),
    });
  }

  if (hasStep) validateCloneStep(from.step as string, ruleId, index, locate, options, issues);
  if (hasUrl) validateCloneUrl(from.url as string, ruleId, index, locate, issues);

  const matchAt = locate(['rules', index, 'clone', 'from', 'match']);
  if (from.match.trim() === '') {
    issues.push({
      code: 'missing-match',
      message:
        `rule '${ruleId}' has an empty clone.from.match: it is the selector of the element to ` +
        'copy, and a clone descends from an element the application rendered — it cannot be ' +
        'written from nothing',
      at: matchAt,
    });
  } else {
    checkSelector(from.match, matchAt, `rule '${ruleId}' has an invalid clone.from.match`, issues);
  }
}

function validateCloneStep(
  step: string,
  ruleId: string,
  index: number,
  locate: Locate,
  options: ValidateOptions,
  issues: ValidationIssue[],
): void {
  const at = locate(['rules', index, 'clone', 'from', 'step']);

  if (step.trim() === '' || !SAFE_STEP_ID_RE.test(step)) {
    issues.push({
      code: 'invalid-step',
      message:
        `rule '${ruleId}' has an invalid clone.from.step ${JSON.stringify(step)}: it names a step ` +
        'of the flow being run, and a step id starts with a letter or digit and contains only ' +
        'letters, digits, dot, dash or underscore',
      at,
    });
    return;
  }

  const known = options.flowStepIds;
  if (known === undefined || known.includes(step)) return;
  issues.push({
    code: 'unknown-step',
    message:
      `rule '${ruleId}' clones from step '${step}', which this flow does not have. Its steps are: ` +
      `${known.length === 0 ? '(none)' : known.join(', ')}`,
    at,
  });
}

function validateCloneUrl(
  url: string,
  ruleId: string,
  index: number,
  locate: Locate,
  issues: ValidationIssue[],
): void {
  const at = locate(['rules', index, 'clone', 'from', 'url']);
  const push = (reason: string): void => {
    issues.push({
      code: 'invalid-url',
      message: `rule '${ruleId}' has an invalid clone.from.url ${JSON.stringify(url)}: ${reason}`,
      at,
    });
  };

  const trimmed = url.trim();
  if (trimmed === '') {
    push('it is empty, and a clone source has to name the page it is extracted from');
    return;
  }
  if (trimmed.startsWith('/')) return;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      push(
        `a clone source is a page of the application under test, so its url is http or https, ` +
          `not ${JSON.stringify(parsed.protocol.replace(':', ''))}`,
      );
    }
  } catch {
    push(
      "it is neither an absolute url nor a path: write '/pricing' to resolve it against the " +
        "flow's baseUrl, or the whole 'https://…' url",
    );
  }
}

/* ------------------------------------------------------------------ selectors */

/**
 * A selector the page's own `querySelectorAll` would refuse is an error, never a silent no-match —
 * §9, and the failure mode already fixed once for `diff.ignore`.
 *
 * A pseudo-element is refused for the same reason one layer up: it is syntactically fine and can
 * never match, so accepting it would produce a run whose only symptom is a warning the user has
 * been told to expect from mistyped selectors.
 */
function checkSelector(
  selector: string,
  at: SourceLocation,
  prefix: string,
  issues: ValidationIssue[],
): void {
  const parsed = parseSelector(selector);
  if (!parsed.ok) {
    issues.push({
      code: 'invalid-selector',
      message: `${prefix} ${JSON.stringify(selector)}: ${parsed.reason}`,
      at,
    });
    return;
  }
  const pseudo = parsed.pseudoElements[0];
  if (pseudo === undefined) return;
  issues.push({
    code: 'pseudo-element-selector',
    message:
      `${prefix} ${JSON.stringify(selector)}: '${pseudo}' is a pseudo-element, not an element. A ` +
      'variant rule operates on nodes the application rendered, and querySelectorAll never ' +
      'returns a pseudo-element, so this selector can only ever match nothing — select the ' +
      'element itself',
    at,
  });
}

/* ------------------------------------------------------------------ overrides */

/**
 * Rules apply once, in file order (D22), and every one of them applies — unlike scenario rules,
 * where the first match wins. So the analogous mistake is not an unreachable rule but an
 * *overridden* one: two rules setting text on the same match means only the second is ever seen,
 * and the user reading the report has no way to tell which one produced the screenshot.
 *
 * A warning rather than an error, exactly as scenario shadowing is: the overridden rule may be a
 * deliberate base that a later rule refines.
 */
function validateOverride(
  rules: readonly VariantRuleInput[],
  rule: VariantRuleInput,
  index: number,
  locate: Locate,
  warnings: ValidationIssue[],
): void {
  const verbs = verbsOf(rule);
  const verb = verbs.length === 1 ? verbs[0] : undefined;
  if (verb === undefined || verb === 'clone' || rule.match === undefined) return;

  for (let i = 0; i < index; i += 1) {
    const earlier = rules[i];
    if (earlier === undefined) continue;
    if (earlier.match !== rule.match) continue;
    const earlierVerbs = verbsOf(earlier);
    if (earlierVerbs.length !== 1 || earlierVerbs[0] !== verb) continue;

    if (verb === 'hide') {
      warnings.push({
        code: 'redundant-rule',
        message:
          `rule '${rule.id}' repeats rule '${earlier.id}' at rules[${i}]: both hide the same ` +
          'match, and hiding an element twice changes nothing',
        at: locate(['rules', index, 'hide']),
      });
      return;
    }

    if (verb === 'style') {
      const overlap = overlappingProperties(earlier.style, rule.style);
      if (overlap.length === 0) continue;
      warnings.push({
        code: 'overridden-rule',
        message:
          `rule '${rule.id}' overrides rule '${earlier.id}' at rules[${i}]: both set ` +
          `${overlap.join(', ')} on the same match, and rules apply in file order, so only this ` +
          "rule's value is visible",
        at: locate(['rules', index, 'style']),
      });
      return;
    }

    warnings.push({
      code: 'overridden-rule',
      message:
        `rule '${rule.id}' overrides rule '${earlier.id}' at rules[${i}]: both set ${verb} on the ` +
        `same match, and rules apply in file order, so only this rule's ${verb} is visible`,
      at: locate(['rules', index, verb]),
    });
    return;
  }
}

function overlappingProperties(earlier: unknown, later: unknown): string[] {
  if (!isPlainObject(earlier) || !isPlainObject(later)) return [];
  const first = new Set(Object.keys(earlier));
  return Object.keys(later).filter((key) => first.has(key));
}

/* ------------------------------------------------------------------ helpers */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `paddingTop` → `padding-top`, `WebkitLineClamp` → `-webkit-line-clamp`. */
function hyphenate(property: string): string {
  const hyphenated = property.replace(/([A-Z])/g, (match) => `-${match.toLowerCase()}`);
  return hyphenated;
}

/** `NaN` and `Infinity` stringify as themselves; everything else gets JSON quoting. */
function describeNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return String(value);
}

function describeType(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Date) return 'a date';
  if (value instanceof Map) return 'a YAML complex-key mapping';
  if (value instanceof Set) return 'a YAML set';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `the number ${describeNumber(value)}`;
  if (typeof value === 'boolean') return `the boolean ${String(value)}`;
  return `a ${typeof value}`;
}
