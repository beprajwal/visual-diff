/**
 * Flow YAML → FlowSpec (spec §6, D8; errors per §10 row 1).
 *
 * The document is parsed into a CST-backed AST first so that every issue can be pinned to a line,
 * a column and the offending key. Only then is the shape checked with zod and the semantics checked
 * with `validateFlowSpec`. A failure is data (`ValidationResult`), not an exception, so
 * `vdiff flow check` can print every problem at once; the `load*` helpers wrap the same result in a
 * `SpecError` for callers that want exit-2 semantics.
 */

import { readFile } from 'node:fs/promises';
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { ZodIssue } from 'zod';
import {
  DEFAULTS,
  STEP_VERBS,
  type FlowNetwork,
  type FlowSpec,
  type SourceLocation,
  type Step,
  type ValidationIssue,
  type ValidationResult,
  type ViewportId,
} from '../types.js';
import { SpecError } from './errors.js';
import { FORBIDDEN_KEYS, flowSpecSchema, type FlowSpecInput } from './schema.js';
import { validateFlowSpec, type Locate } from './validate.js';

export interface ParseOptions {
  /** Label used in issue locations. Defaults to `<inline>` for sources and the path for files. */
  file?: string;
  /** Warn (never fail) when the spec's `flow` differs from this name. */
  expectFlowName?: string;
}

type ParsedDoc = ReturnType<typeof parseDocument>;

/** Parse and validate a flow spec from YAML text. */
export function parseFlowSource(source: string, options: ParseOptions = {}): ValidationResult<FlowSpec> {
  const file = options.file ?? '<inline>';
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });
  const locate: Locate = (path) => locateInDoc(doc, lineCounter, file, path);

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
    return fail([{ code: 'empty-spec', message: 'flow spec is empty', at: { file, line: 1, column: 1 } }]);
  }
  if (!isPlainObject(raw)) {
    return fail([
      {
        code: 'invalid-root',
        message: `a flow spec must be a mapping, got ${describeType(raw)}`,
        at: locate([]),
      },
    ]);
  }

  applyShorthands(raw);

  const parsed = flowSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: ValidationIssue[] = [];
    for (const issue of parsed.error.issues) issues.push(...mapZodIssue(issue, locate));
    return fail(issues);
  }

  const spec = withDefaults(parsed.data);
  const semanticOptions =
    options.expectFlowName === undefined ? {} : { expectFlowName: options.expectFlowName };
  const { issues, warnings } = validateFlowSpec(spec, locate, semanticOptions);
  if (issues.length > 0) return fail(issues);

  return { ok: true, value: spec, warnings: sortIssues(warnings) };
}

/** Parse and validate a flow spec from disk. A missing file is itself a spec issue. */
export async function parseFlowFile(
  file: string,
  options: Omit<ParseOptions, 'file'> = {},
): Promise<ValidationResult<FlowSpec>> {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    return fail([
      {
        code: 'flow-not-found',
        message: `cannot read flow spec: ${errorMessage(error)}`,
        at: { file },
      },
    ]);
  }
  return parseFlowSource(source, { ...options, file });
}

/** As `parseFlowSource`, but throws `SpecError` (exit 2) instead of returning issues. */
export function loadFlowSource(source: string, options: ParseOptions = {}): FlowSpec {
  return SpecError.unwrap(options.file ?? '<inline>', parseFlowSource(source, options));
}

/** As `parseFlowFile`, but throws `SpecError` (exit 2) instead of returning issues. */
export async function loadFlowFile(
  file: string,
  options: Omit<ParseOptions, 'file'> = {},
): Promise<FlowSpec> {
  return SpecError.unwrap(file, await parseFlowFile(file, options));
}

/* ------------------------------------------------------------------ defaults */

function withDefaults(input: FlowSpecInput): FlowSpec {
  const network: FlowNetwork = input.network ?? { mode: 'replay', har: `${input.flow}.har` };
  const spec: FlowSpec = {
    version: 1,
    flow: input.flow,
    viewports: (input.viewports ?? [...DEFAULTS.viewports]) as ViewportId[],
    network,
    steps: input.steps.map(normalizeStep),
  };
  if (input.baseUrl !== undefined) spec.baseUrl = input.baseUrl;
  return spec;
}

function normalizeStep(input: FlowSpecInput['steps'][number]): Step {
  const step: Step = { id: input.id, shoot: input.shoot ?? true };
  if (input.goto !== undefined) step.goto = input.goto;
  if (input.click !== undefined) step.click = input.click;
  if (input.fill !== undefined) step.fill = { ...input.fill };
  if (input.press !== undefined) step.press = input.press;
  if (input.hover !== undefined) step.hover = input.hover;
  if (input.scroll !== undefined) step.scroll = { ...input.scroll };
  if (input.waitFor !== undefined) step.waitFor = input.waitFor;
  if (input.viewport !== undefined) step.viewport = input.viewport;
  if (input.mask !== undefined) step.mask = [...input.mask];
  if (input.expect !== undefined) step.expect = input.expect.map((entry) => ({ ...entry }));
  return step;
}

/**
 * YAML conveniences normalized before validation: a lone selector for `mask`, a lone mapping for
 * `expect`, a lone string for `viewports`. Each is exactly the singular form of a list the schema
 * already accepts; nothing new enters the vocabulary.
 */
function applyShorthands(raw: Record<string, unknown>): void {
  if (typeof raw.viewports === 'string') raw.viewports = [raw.viewports];
  const steps = raw.steps;
  if (!Array.isArray(steps)) return;
  for (const step of steps) {
    if (!isPlainObject(step)) continue;
    if (typeof step.mask === 'string') step.mask = [step.mask];
    if (isPlainObject(step.expect)) step.expect = [step.expect];
  }
}

/* ------------------------------------------------------------------ zod issue mapping */

function mapZodIssue(issue: ZodIssue, locate: Locate): ValidationIssue[] {
  const path = issue.path;

  switch (issue.code) {
    case 'unrecognized_keys': {
      const inStep =
        path.length === 2 && path[0] === 'steps' && typeof path[1] === 'number';
      return issue.keys.map((key): ValidationIssue => {
        const at = locate([...path, key]);
        if (FORBIDDEN_KEYS.has(key)) {
          return {
            code: 'sleep-forbidden',
            message:
              `'${key}' is not part of the flow vocabulary: there is no fixed sleep, because a sleep ` +
              'is how a half-rendered frame gets captured. Use waitFor, which gates on the page.',
            at,
          };
        }
        if (inStep) {
          return {
            code: 'unknown-verb',
            message: `unknown step verb '${key}'. The vocabulary is: ${STEP_VERBS.join(' ')}`,
            at,
          };
        }
        return { code: 'unknown-key', message: `unknown key '${key}'`, at };
      });
    }

    case 'invalid_type': {
      const last = path[path.length - 1];
      if (issue.received === 'undefined') {
        return [
          {
            code: last === 'id' ? 'missing-id' : 'missing-key',
            message: `missing required key '${String(last ?? '')}'`,
            at: locate(path),
          },
        ];
      }
      return [
        {
          code: 'invalid-type',
          message: `expected ${issue.expected}, got ${issue.received}`,
          at: locate(path),
        },
      ];
    }

    case 'invalid_literal': {
      if (path.length === 1 && path[0] === 'version') {
        if (issue.received === undefined) {
          return [
            { code: 'missing-key', message: "missing required key 'version'", at: locate(path) },
          ];
        }
        return [
          {
            code: 'unsupported-version',
            message: `unsupported flow spec version ${JSON.stringify(issue.received)}: this build understands version 1`,
            at: locate(path),
          },
        ];
      }
      return [{ code: 'invalid-value', message: issue.message, at: locate(path) }];
    }

    case 'invalid_enum_value':
      return [
        {
          code: 'invalid-value',
          message: `invalid value ${JSON.stringify(issue.received)}. Allowed: ${issue.options
            .map((option) => String(option))
            .join(', ')}`,
          at: locate(path),
        },
      ];

    case 'too_small': {
      if (issue.type === 'array') {
        if (path.length === 1 && path[0] === 'steps') {
          return [
            { code: 'empty-steps', message: 'a flow needs at least one step', at: locate(path) },
          ];
        }
        return [
          {
            code: 'empty-list',
            message: `expected at least ${String(issue.minimum)} item(s)`,
            at: locate(path),
          },
        ];
      }
      if (issue.type === 'string') {
        return [{ code: 'empty-value', message: 'value must not be empty', at: locate(path) }];
      }
      return [{ code: 'invalid-value', message: issue.message, at: locate(path) }];
    }

    default:
      return [{ code: 'invalid-value', message: issue.message, at: locate(path) }];
  }
}

/* ------------------------------------------------------------------ source locations */

/** Resolve a key path to a file/line/column, falling back to the deepest node that did resolve. */
export function locateInDoc(
  doc: ParsedDoc | null,
  lineCounter: LineCounter,
  file: string,
  path: ReadonlyArray<string | number>,
): SourceLocation {
  const location: SourceLocation = { file };
  if (path.length > 0) location.key = keyPath(path);
  if (!doc) return location;

  let node: unknown = doc.contents;
  let anchor: unknown = doc.contents;

  for (let i = 0; i < path.length; i += 1) {
    const segment = path[i];
    if (segment === undefined) break;
    const last = i === path.length - 1;

    if (isMap(node)) {
      const pair = node.items.find(
        (candidate) => isScalar(candidate.key) && String(candidate.key.value) === String(segment),
      );
      if (!pair) break;
      anchor = last ? pair.key : (pair.value ?? pair.key);
      node = pair.value;
    } else if (isSeq(node)) {
      const index = typeof segment === 'number' ? segment : Number(segment);
      if (!Number.isInteger(index)) break;
      const item: unknown = node.items[index];
      if (item === undefined) break;
      anchor = item;
      node = item;
    } else {
      break;
    }
  }

  const offset = startOffset(anchor);
  if (offset === undefined) return location;
  const pos = lineCounter.linePos(offset);
  location.line = pos.line;
  location.column = pos.col;
  return location;
}

/** `steps[2].click`, `network.har`, `viewports[1]`. */
export function keyPath(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

function locateOffset(lineCounter: LineCounter, file: string, offset: number): SourceLocation {
  const pos = lineCounter.linePos(offset);
  return { file, line: pos.line, column: pos.col };
}

function startOffset(node: unknown): number | undefined {
  if (node === null || typeof node !== 'object' || !('range' in node)) return undefined;
  const range = (node as { range?: readonly number[] | null }).range;
  if (!range || typeof range[0] !== 'number') return undefined;
  return range[0];
}

/* ------------------------------------------------------------------ helpers */

function fail(issues: ValidationIssue[]): ValidationResult<FlowSpec> {
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
