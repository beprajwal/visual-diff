/**
 * Scenario YAML → ScenarioSpec (mocking spec §5; errors per §8).
 *
 * The same three-stage shape as the flow parser, for the same reasons: the document is parsed into
 * a CST-backed AST so every issue can be pinned to a line, a column and the offending key; only
 * then is the shape checked with zod and the semantics with `validateScenarioSpec`. A failure is
 * data (`ValidationResult`), not an exception, so `vdiff scenario check` can print every problem at
 * once; the `load*` helpers wrap the same result in a `ScenarioSpecError` for callers that want
 * exit-2 semantics.
 *
 * Two things differ from the flow parser, and both come from mocking spec §8:
 *
 *   - the name/filename disagreement is an **error**, not a warning, so `parseScenarioFile` derives
 *     `expectScenarioName` from the filename by default rather than making every caller remember;
 *   - `none` is refused as a filename as well as a `scenario:` value (§11), since a file called
 *     `none.yaml` could never be selected — `SCENARIO_NONE` is what a scenario-less run records.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import type { ZodIssue } from 'zod';
import {
  DEFAULTS,
  RESPONSE_VERBS,
  SCENARIO_MODES,
  SCENARIO_NONE,
  type JsonPatchOperation,
  type JsonValue,
  type MergePatch,
  type RespondSpec,
  type ResponseBody,
  type RuleMatch,
  type ScenarioRule,
  type ScenarioSpec,
  type ValidationIssue,
  type ValidationResult,
} from '../types.js';
import { ScenarioSpecError } from './errors.js';
import { locateInDoc, locateOffset, type Locate } from './locate.js';
import {
  RULE_KEYS,
  SCENARIO_KEYS,
  hasKey,
  scenarioSpecSchema,
  type RespondInput,
  type ScenarioRuleInput,
  type ScenarioSpecInput,
} from './schema.js';
import { validateScenarioSpec } from './validate.js';

export interface ParseOptions {
  /** Label used in issue locations. Defaults to `<inline>` for sources and the path for files. */
  file?: string;
  /**
   * The name the file's own name claims. A disagreement is an error (§8). `parseScenarioFile`
   * fills this in from the basename unless the caller overrides it.
   */
  expectScenarioName?: string;
}

/** Parse and validate a scenario spec from YAML text. */
export function parseScenarioSource(
  source: string,
  options: ParseOptions = {},
): ValidationResult<ScenarioSpec> {
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
      { code: 'empty-spec', message: 'scenario spec is empty', at: { file, line: 1, column: 1 } },
    ]);
  }
  if (!isPlainObject(raw)) {
    return fail([
      {
        code: 'invalid-root',
        message: `a scenario spec must be a mapping, got ${describeType(raw)}`,
        at: locate([]),
      },
    ]);
  }

  const parsed = scenarioSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: ValidationIssue[] = [];
    for (const issue of parsed.error.issues) issues.push(...mapZodIssue(issue, locate));
    return fail(issues);
  }

  const semanticOptions =
    options.expectScenarioName === undefined
      ? {}
      : { expectScenarioName: options.expectScenarioName };
  const { issues, warnings } = validateScenarioSpec(parsed.data, locate, semanticOptions);
  if (issues.length > 0) return fail(issues);

  return { ok: true, value: withDefaults(parsed.data), warnings: sortIssues(warnings) };
}

/**
 * Parse and validate a scenario spec from disk. A missing file is itself a spec issue — mocking
 * spec §8 puts "scenario absent at the target SHA" alongside a missing flow under D4.
 */
export async function parseScenarioFile(
  file: string,
  options: Omit<ParseOptions, 'file'> = {},
): Promise<ValidationResult<ScenarioSpec>> {
  const expected = options.expectScenarioName ?? scenarioNameFromFile(file);

  if (expected === SCENARIO_NONE) {
    return fail([
      {
        code: 'reserved-scenario-name',
        message:
          `'${SCENARIO_NONE}.yaml' is a reserved filename: '${SCENARIO_NONE}' is what a run ` +
          'captured without a scenario records in meta.json, so a scenario cannot be called that',
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
        code: 'scenario-missing',
        message: `cannot read scenario spec: ${errorMessage(error)}`,
        at: { file },
      },
    ]);
  }
  return parseScenarioSource(source, { file, expectScenarioName: expected });
}

/** As `parseScenarioSource`, but throws `ScenarioSpecError` (exit 2) instead of returning issues. */
export function loadScenarioSource(source: string, options: ParseOptions = {}): ScenarioSpec {
  return ScenarioSpecError.unwrap(
    options.file ?? '<inline>',
    parseScenarioSource(source, options),
  );
}

/** As `parseScenarioFile`, but throws `ScenarioSpecError` (exit 2) instead of returning issues. */
export async function loadScenarioFile(
  file: string,
  options: Omit<ParseOptions, 'file'> = {},
): Promise<ScenarioSpec> {
  return ScenarioSpecError.unwrap(file, await parseScenarioFile(file, options));
}

/** `.visual-diff/scenarios/empty-forecast.yaml` → `empty-forecast`. */
export function scenarioNameFromFile(file: string): string {
  return path.basename(file).replace(/\.ya?ml$/i, '');
}

/* ------------------------------------------------------------------ defaults */

/**
 * Materialize the spec, applying the one default there is (`mode`) and narrowing the shapes
 * `schema.ts` deliberately left as `unknown`. Every cast below is licensed by a check in
 * `validate.ts` that has already run and passed.
 */
function withDefaults(input: ScenarioSpecInput): ScenarioSpec {
  // Built in canonical key order, so a JSON dump of a spec reads the way the YAML does.
  return {
    version: 1,
    scenario: input.scenario,
    ...(input.description === undefined ? {} : { description: input.description }),
    mode: input.mode ?? DEFAULTS.scenarioMode,
    rules: input.rules.map(normalizeRule),
  };
}

function normalizeRule(input: ScenarioRuleInput): ScenarioRule {
  const match: RuleMatch = { url: input.match.url };
  if (input.match.method !== undefined) match.method = input.match.method;
  if (input.match.nth !== undefined) match.nth = input.match.nth;

  const base = { id: input.id, match } as { id: string; match: RuleMatch; delay?: number };
  if (input.delay !== undefined) base.delay = input.delay;

  if (hasKey(input, 'patch')) return { ...base, patch: input.patch as MergePatch };
  if (input.patchOps !== undefined) {
    return { ...base, patchOps: input.patchOps.map(normalizePatchOp) };
  }
  if (input.respond !== undefined) return { ...base, respond: normalizeRespond(input.respond) };
  if (input.abort === true) return { ...base, abort: true };

  // Validation guarantees the remaining case: a rule with no verb but a delay.
  return { ...base, delay: input.delay as number };
}

function normalizePatchOp(op: unknown): JsonPatchOperation {
  const source = op as Record<string, unknown>;
  const name = source.op as JsonPatchOperation['op'];
  switch (name) {
    case 'remove':
      return { op: 'remove', path: source.path as string };
    case 'move':
      return { op: 'move', path: source.path as string, from: source.from as string };
    case 'copy':
      return { op: 'copy', path: source.path as string, from: source.from as string };
    default:
      return {
        op: name,
        path: source.path as string,
        value: source.value as JsonValue,
      } as JsonPatchOperation;
  }
}

function normalizeRespond(input: RespondInput): RespondSpec {
  const respond: RespondSpec = { status: input.status };
  if (input.headers !== undefined) respond.headers = { ...input.headers };
  if (hasKey(input, 'body')) respond.body = input.body as ResponseBody;
  return respond;
}

/* ------------------------------------------------------------------ zod issue mapping */

const RULE_KEY_LIST = RULE_KEYS.join(', ');
const SCENARIO_KEY_LIST = SCENARIO_KEYS.join(', ');

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
              `exactly one of ${RESPONSE_VERBS.join(', ')} is the response verb and delay is a modifier`,
            at,
          };
        }
        if (where === 'match') {
          return {
            code: 'unknown-key',
            message: `unknown key '${key}' in match. A match is written with: method, url, nth`,
            at,
          };
        }
        if (where === 'respond') {
          return {
            code: 'unknown-key',
            message: `unknown key '${key}' in respond. A respond is written with: status, headers, body`,
            at,
          };
        }
        return {
          code: 'unknown-key',
          message: `unknown key '${key}'. A scenario is written with: ${SCENARIO_KEY_LIST}`,
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
                'lets two versions of a scenario be compared and what the report names when it ' +
                'attributes a changed response',
              at: locate(keys),
            },
          ];
        }
        if (last === 'url') {
          return [
            {
              code: 'missing-url',
              message:
                "missing required key 'match.url': a rule is a URL glob applied to the whole URL " +
                "including the query string, e.g. '**/v1/forecast**'",
              at: locate(keys),
            },
          ];
        }
        if (last === 'status') {
          return [
            {
              code: 'missing-key',
              message: "missing required key 'respond.status': a response needs a status",
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
              `unsupported scenario spec version ${JSON.stringify(issue.received)}: this build ` +
              'understands version 1',
            at: locate(keys),
          },
        ];
      }
      if (keys[keys.length - 1] === 'abort') {
        return [
          {
            code: 'invalid-abort',
            message:
              `abort takes only true, got ${JSON.stringify(issue.received)}. There is no way to ` +
              'switch a rule off in place: delete the rule, or comment it out',
            at: locate(keys),
          },
        ];
      }
      return [{ code: 'invalid-value', message: issue.message, at: locate(keys) }];
    }

    case 'invalid_enum_value':
      if (keys.length === 1 && keys[0] === 'mode') {
        return [
          {
            code: 'invalid-mode',
            message:
              `unknown scenario mode ${JSON.stringify(issue.received)}. The modes are ` +
              `${SCENARIO_MODES.join(' and ')}: overlay patches a recording, mock runs with no ` +
              'recording at all and aborts every unmatched request',
            at: locate(keys),
          },
        ];
      }
      return [
        {
          code: 'invalid-value',
          message: `invalid value ${JSON.stringify(issue.received)}. Allowed: ${issue.options
            .map((option) => String(option))
            .join(', ')}`,
          at: locate(keys),
        },
      ];

    case 'too_small': {
      if (issue.type === 'array' && keys.length === 1 && keys[0] === 'rules') {
        return [
          {
            code: 'empty-rules',
            message:
              'a scenario needs at least one rule: a scenario with none patches nothing, which ' +
              'is what running without --scenario already does',
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
function describeWhere(keys: ReadonlyArray<string | number>): 'root' | 'rule' | 'match' | 'respond' {
  if (keys.length === 0) return 'root';
  const last = keys[keys.length - 1];
  if (last === 'match') return 'match';
  if (last === 'respond') return 'respond';
  if (keys[0] === 'rules' && typeof last === 'number') return 'rule';
  return 'root';
}

/* ------------------------------------------------------------------ helpers */

function fail(issues: ValidationIssue[]): ValidationResult<ScenarioSpec> {
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
