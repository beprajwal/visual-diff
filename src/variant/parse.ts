/**
 * Variant YAML → VariantSpec (variants spec §4; errors per §7).
 *
 * The same three-stage shape as the flow and scenario parsers, for the same reasons: the document
 * is parsed into a CST-backed AST so every issue can be pinned to a line, a column and the
 * offending key; only then is the shape checked with zod and the semantics with
 * `validateVariantSpec`. A failure is data (`ValidationResult`), not an exception, so
 * `vdiff variant check` can print every problem at once; the `load*` helpers wrap the same result
 * in a `VariantSpecError` for callers that want exit-2 semantics.
 *
 * `locateInDoc` and `locateOffset` are imported from the scenario layer's module edge rather than
 * copied a third time. `scenario/locate.ts` says exactly this in its own header — "if a third spec
 * format appears, this is the moment to lift both copies into a shared spec-parsing utility" — and
 * a third copy is the thing that comment exists to prevent. The scenario edge exports them, so this
 * reaches the edge rather than past it.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import type { ZodIssue } from 'zod';
import { locateInDoc, locateOffset, type Locate } from '../scenario/index.js';
import type { ValidationIssue, ValidationResult } from '../types.js';
import { VariantSpecError } from './errors.js';
import {
  CLONE_FROM_KEYS,
  CLONE_KEYS,
  RULE_KEYS,
  VARIANT_KEYS,
  hasKey,
  variantSpecSchema,
  type CloneInput,
  type VariantRuleInput,
  type VariantSpecInput,
} from './schema.js';
import {
  VARIANT_NONE,
  VARIANT_VERBS,
  type ClonePosition,
  type CloneSource,
  type CloneSpec,
  type OrderSpec,
  type StyleDeclarations,
  type VariantRule,
  type VariantSpec,
} from './types.js';
import { validateVariantSpec, type ValidateOptions } from './validate.js';

/** A variant that omits `clone.position` appends, and one that omits `clone.times` clones once. */
export const CLONE_DEFAULTS = { position: 'append', times: 1 } as const;

export interface ParseOptions extends ValidateOptions {
  /** Label used in issue locations. Defaults to `<inline>` for sources and the path for files. */
  file?: string;
}

/** Parse and validate a variant spec from YAML text. */
export function parseVariantSource(
  source: string,
  options: ParseOptions = {},
): ValidationResult<VariantSpec> {
  const file = options.file ?? '<inline>';
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });
  const locate: Locate = (keys) => locateInDoc(doc, lineCounter, file, keys);

  if (doc.errors.length > 0) {
    return fail(
      doc.errors.map((error) => ({
        code: 'yaml-parse-error',
        message: error.message,
        at: locateOffset(lineCounter, file, error.pos[0]),
      })),
    );
  }

  const raw: unknown = doc.toJS();
  if (raw === null || raw === undefined) {
    return fail([
      { code: 'empty-spec', message: 'variant spec is empty', at: { file, line: 1, column: 1 } },
    ]);
  }
  if (!isPlainObject(raw)) {
    return fail([
      {
        code: 'invalid-root',
        message: `a variant spec must be a mapping, got ${describeType(raw)}`,
        at: locate([]),
      },
    ]);
  }

  const parsed = variantSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: ValidationIssue[] = [];
    for (const issue of parsed.error.issues) issues.push(...mapZodIssue(issue, locate));
    return fail(issues);
  }

  const semanticOptions: ValidateOptions = {};
  if (options.expectVariantName !== undefined) {
    semanticOptions.expectVariantName = options.expectVariantName;
  }
  if (options.flowStepIds !== undefined) semanticOptions.flowStepIds = options.flowStepIds;

  const { issues, warnings } = validateVariantSpec(parsed.data, locate, semanticOptions);
  if (issues.length > 0) return fail(issues);

  return { ok: true, value: withDefaults(parsed.data), warnings: sortIssues(warnings) };
}

/**
 * Parse and validate a variant spec from disk. A missing file is itself a spec issue — §7 puts
 * "variant absent at the target SHA" alongside a missing flow under D4.
 */
export async function parseVariantFile(
  file: string,
  options: Omit<ParseOptions, 'file'> = {},
): Promise<ValidationResult<VariantSpec>> {
  const expected = options.expectVariantName ?? variantNameFromFile(file);

  if (expected === VARIANT_NONE) {
    return fail([
      {
        code: 'reserved-variant-name',
        message:
          `'${VARIANT_NONE}.yaml' is a reserved filename: '${VARIANT_NONE}' is what a run captured ` +
          'without a variant records in meta.json, so a variant cannot be called that',
        at: { file },
      },
    ]);
  }

  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    return fail([
      {
        code: 'variant-missing',
        message: `cannot read variant spec: ${errorMessage(error)}`,
        at: { file },
      },
    ]);
  }
  return parseVariantSource(source, { ...options, file, expectVariantName: expected });
}

/** As `parseVariantSource`, but throws `VariantSpecError` (exit 2) instead of returning issues. */
export function loadVariantSource(source: string, options: ParseOptions = {}): VariantSpec {
  return VariantSpecError.unwrap(options.file ?? '<inline>', parseVariantSource(source, options));
}

/** As `parseVariantFile`, but throws `VariantSpecError` (exit 2) instead of returning issues. */
export async function loadVariantFile(
  file: string,
  options: Omit<ParseOptions, 'file'> = {},
): Promise<VariantSpec> {
  return VariantSpecError.unwrap(file, await parseVariantFile(file, options));
}

/** `.visual-diff/variants/denser-forecast.yaml` → `denser-forecast`. */
export function variantNameFromFile(file: string): string {
  return path.basename(file).replace(/\.ya?ml$/i, '');
}

/* ------------------------------------------------------------------ defaults */

/**
 * Materialize the spec, applying the two defaults there are (`clone.position` and `clone.times`)
 * and narrowing the shapes `schema.ts` deliberately left as `unknown`. Every cast below is licensed
 * by a check in `validate.ts` that has already run and passed.
 */
function withDefaults(input: VariantSpecInput): VariantSpec {
  // Built in canonical key order, so a JSON dump of a spec reads the way the YAML does.
  return {
    version: 1,
    variant: input.variant,
    ...(input.description === undefined ? {} : { description: input.description }),
    rules: input.rules.map(normalizeRule),
  };
}

function normalizeRule(input: VariantRuleInput): VariantRule {
  const id = input.id;
  const match = input.match as string;

  if (hasKey(input, 'style')) {
    return { id, match, style: normalizeStyle(input.style) };
  }
  if (input.text !== undefined) return { id, match, text: input.text };
  if (input.hide === true) return { id, match, hide: true };
  if (hasKey(input, 'order')) return { id, match, order: normalizeOrder(input.order) };

  // Validation guarantees the remaining case: exactly one verb, and it is `clone`.
  return { id, clone: normalizeClone(input.clone as CloneInput) };
}

/**
 * YAML reads `padding: 8` as a number and `opacity: 0.5` as a float, while `setProperty` takes only
 * strings. Normalizing here rather than at application time keeps the spec, its canonical
 * serialization and its structural diff talking about the same values.
 */
function normalizeStyle(style: unknown): StyleDeclarations {
  const out: StyleDeclarations = {};
  for (const [property, value] of Object.entries(style as Record<string, unknown>)) {
    out[property] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

function normalizeOrder(order: unknown): OrderSpec {
  if (typeof order === 'string') return order as 'first' | 'last';
  return normalizeRelative(order) as OrderSpec;
}

function normalizePosition(position: unknown): ClonePosition {
  if (typeof position === 'string') return position as 'prepend' | 'append';
  return normalizeRelative(position) as ClonePosition;
}

function normalizeRelative(value: unknown): { before: string } | { after: string } {
  const source = value as Record<string, unknown>;
  return hasKey(source, 'before')
    ? { before: source.before as string }
    : { after: source.after as string };
}

function normalizeClone(clone: CloneInput): CloneSpec {
  const from: CloneSource =
    clone.from.step !== undefined
      ? { step: clone.from.step, match: clone.from.match }
      : { url: clone.from.url as string, match: clone.from.match };

  return {
    from,
    into: clone.into,
    position: hasKey(clone, 'position')
      ? normalizePosition(clone.position)
      : CLONE_DEFAULTS.position,
    times: clone.times ?? CLONE_DEFAULTS.times,
  };
}

/* ------------------------------------------------------------------ zod issue mapping */

const RULE_KEY_LIST = RULE_KEYS.join(', ');
const VARIANT_KEY_LIST = VARIANT_KEYS.join(', ');
const VERB_LIST = VARIANT_VERBS.join(', ');

function mapZodIssue(issue: ZodIssue, locate: Locate): ValidationIssue[] {
  const keys = issue.path;

  switch (issue.code) {
    case 'unrecognized_keys': {
      const where = describeWhere(keys);
      return issue.keys.map((key): ValidationIssue => {
        const at = locate([...keys, key]);
        if (where === 'rule') {
          return {
            code: 'unknown-rule-key',
            message:
              `unknown key '${key}' in a rule. A rule is written with: ${RULE_KEY_LIST} — where ` +
              `exactly one of ${VERB_LIST} is the verb. There is deliberately no verb that takes ` +
              'markup: a variant rearranges what the application already renders, so every ' +
              'element it shows has to have been rendered by the application first',
            at,
          };
        }
        if (where === 'clone') {
          return {
            code: 'unknown-clone-key',
            message: `unknown key '${key}' in clone. A clone is written with: ${CLONE_KEYS.join(', ')}`,
            at,
          };
        }
        if (where === 'clone.from') {
          return {
            code: 'unknown-clone-key',
            message:
              `unknown key '${key}' in clone.from. A clone source is written with: ` +
              `${CLONE_FROM_KEYS.join(', ')} — step or url, never both`,
            at,
          };
        }
        return {
          code: 'unknown-key',
          message: `unknown key '${key}'. A variant is written with: ${VARIANT_KEY_LIST}`,
          at,
        };
      });
    }

    case 'invalid_type': {
      const last = keys[keys.length - 1];
      if (issue.received === 'undefined') {
        if (last === 'id' && keys[0] === 'rules') {
          return [
            {
              code: 'missing-id',
              message:
                "missing required key 'id': a rule id is required and stable, because it is what " +
                'the report names when it attributes a modified element and what lets two ' +
                'versions of a variant be compared',
              at: locate(keys),
            },
          ];
        }
        if (last === 'from') {
          return [
            {
              code: 'missing-key',
              message:
                "missing required key 'clone.from': a clone copies an element the application " +
                'already rendered, so it has to say which one — from: { step: <step>, match: ' +
                '<selector> }, or from: { url: <url>, match: <selector> }',
              at: locate(keys),
            },
          ];
        }
        if (last === 'into') {
          return [
            {
              code: 'missing-key',
              message:
                "missing required key 'clone.into': a clone needs somewhere to go — the selector " +
                'of the element it is placed into',
              at: locate(keys),
            },
          ];
        }
        if (last === 'match') {
          return [
            {
              code: 'missing-match',
              message:
                "missing required key 'clone.from.match': a clone source names the page it comes " +
                'from and the selector of the element to copy',
              at: locate(keys),
            },
          ];
        }
        return [
          {
            code: 'missing-key',
            message: `missing required key '${String(last ?? '')}'`,
            at: locate(keys),
          },
        ];
      }
      if (last === 'match') {
        const inClone = keys[keys.length - 2] === 'from';
        return [
          {
            code: 'invalid-match',
            message:
              `${inClone ? 'clone.from.match' : 'match'} takes a CSS selector, got ` +
              `${issue.received}: write it as a string, e.g. match: "[data-test=forecast-card]"`,
            at: locate(keys),
          },
        ];
      }
      if (last === 'text') {
        return [
          {
            code: 'invalid-text',
            message:
              `text takes a string, got ${issue.received}: quote the replacement copy, e.g. ` +
              'text: "Save this location"',
            at: locate(keys),
          },
        ];
      }
      if (last === 'clone') {
        return [
          {
            code: 'invalid-clone',
            message: `clone takes a mapping of ${CLONE_KEYS.join(', ')}, got ${issue.received}`,
            at: locate(keys),
          },
        ];
      }
      return [
        {
          code: 'invalid-type',
          message: `expected ${issue.expected}, got ${issue.received}`,
          at: locate(keys),
        },
      ];
    }

    case 'invalid_literal': {
      if (keys.length === 1 && keys[0] === 'version') {
        if (issue.received === undefined) {
          return [
            { code: 'missing-key', message: "missing required key 'version'", at: locate(keys) },
          ];
        }
        return [
          {
            code: 'unsupported-version',
            message:
              `unsupported variant spec version ${JSON.stringify(issue.received)}: this build ` +
              'understands version 1',
            at: locate(keys),
          },
        ];
      }
      if (keys[keys.length - 1] === 'hide') {
        return [
          {
            code: 'invalid-hide',
            message:
              `hide takes only true, got ${JSON.stringify(issue.received)}. There is no way to ` +
              'switch a rule off in place: delete the rule, or comment it out',
            at: locate(keys),
          },
        ];
      }
      return [{ code: 'invalid-value', message: issue.message, at: locate(keys) }];
    }

    case 'too_small': {
      if (issue.type === 'array' && keys.length === 1 && keys[0] === 'rules') {
        return [
          {
            code: 'empty-rules',
            message:
              'a variant needs at least one rule: a variant with none changes nothing, and a run ' +
              'of it would be a second copy of the unmodified page',
            at: locate(keys),
          },
        ];
      }
      return [{ code: 'invalid-value', message: issue.message, at: locate(keys) }];
    }

    default:
      return [{ code: 'invalid-value', message: issue.message, at: locate(keys) }];
  }
}

/** Which `.strict()` shape an `unrecognized_keys` issue came from. */
function describeWhere(
  keys: ReadonlyArray<string | number>,
): 'root' | 'rule' | 'clone' | 'clone.from' {
  if (keys.length === 0) return 'root';
  const last = keys[keys.length - 1];
  if (last === 'clone') return 'clone';
  if (last === 'from' && keys[keys.length - 2] === 'clone') return 'clone.from';
  if (keys[0] === 'rules' && typeof last === 'number') return 'rule';
  return 'root';
}

/* ------------------------------------------------------------------ helpers */

function fail(issues: ValidationIssue[]): ValidationResult<VariantSpec> {
  return { ok: false, issues: sortIssues(issues) };
}

function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort(
    (a, b) => (a.at.line ?? 0) - (b.at.line ?? 0) || (a.at.column ?? 0) - (b.at.column ?? 0),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
