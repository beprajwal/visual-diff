/**
 * Post-schema semantic validation of a scenario spec — mocking spec §8, in full.
 *
 * §10 item 4 asks for "one test per rejection in §8, asserting the *message*, not merely the
 * failure. These messages are the feature's user interface." That is the constraint this file is
 * written under: every issue explains what the tool will not do and what to write instead, and
 * every issue names the offending key so the CLI can print file + line + key and exit 2.
 *
 * The §8 list and where it lives:
 *
 *   unknown keys                     → `parse.ts` (zod `unrecognized_keys`, `.strict()` shapes)
 *   missing rule `id`                → `parse.ts` (zod), duplicate ids here
 *   missing `match.url`              → `parse.ts` when absent, here when empty
 *   two response verbs on one rule   → here
 *   `patch`/`patchOps` in mock mode  → here
 *   malformed RFC 6902 op            → here
 *   unparseable glob                 → here, via `glob.ts`
 *   `status` outside 100–599         → here
 *   negative `delay`                 → here
 *   `nth` below 1                    → here
 *   `scenario:` vs the filename      → here
 *
 * Two rules are stricter than a literal reading of §5 and are called out where they are raised:
 * a `patch:` with no value, and a `respond.body` that claims to be base64 but is not.
 */

import {
  DEFAULTS,
  JSON_PATCH_OPS,
  RESPONSE_VERBS,
  SCENARIO_NONE,
  type JsonPatchOp,
  type ScenarioMode,
  type SourceLocation,
  type ValidationIssue,
} from '../types.js';
import { parseGlob } from './glob.js';
import type { Locate } from './locate.js';
import {
  PATCH_OP_KEYS,
  SAFE_SCENARIO_NAME_RE,
  hasKey,
  type ScenarioRuleInput,
  type ScenarioSpecInput,
} from './schema.js';

export interface ValidateOptions {
  /**
   * The name the file claims by its own filename. A disagreement is an **error** here, unlike the
   * flow layer's warning: a run records the scenario it used by name (mocking spec §6) and looks
   * the file up by that name, so the two disagreeing means one of them is a lie.
   */
  expectScenarioName?: string;
}

export interface ValidateOutcome {
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** The verbs that read a recorded body, and so cannot work when there is no recording. */
const RECORDING_DEPENDENT_VERBS = ['patch', 'patchOps'] as const;

const HTTP_METHOD_RE = /^[A-Za-z]+$/;
/**
 * Written with `\u` escapes rather than the characters themselves: a literal control byte in a
 * source file makes git, grep and every diff tool treat the whole file as binary.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function validateScenarioSpec(
  input: ScenarioSpecInput,
  locate: Locate,
  options: ValidateOptions = {},
): ValidateOutcome {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const mode: ScenarioMode = input.mode ?? DEFAULTS.scenarioMode;

  validateIdentity(input, locate, options, issues);

  const seenIds = new Map<string, number>();
  input.rules.forEach((rule, index) => {
    validateRuleId(rule, index, locate, seenIds, issues);
    validateMatch(rule, index, locate, issues);
    validateDelay(rule, index, locate, issues);
    validateVerbs(rule, index, mode, locate, issues, warnings);
    validateShadowing(input.rules, rule, index, locate, warnings);
  });

  return { issues, warnings };
}

/* ------------------------------------------------------------------ identity */

function validateIdentity(
  input: ScenarioSpecInput,
  locate: Locate,
  options: ValidateOptions,
  issues: ValidationIssue[],
): void {
  const name = input.scenario;

  if (name === SCENARIO_NONE) {
    issues.push({
      code: 'reserved-scenario-name',
      message:
        `'${SCENARIO_NONE}' is a reserved scenario name: it is what a run captured without a ` +
        'scenario records in meta.json, so no scenario file may take it. Pick another name',
      at: locate(['scenario']),
    });
  } else if (!SAFE_SCENARIO_NAME_RE.test(name)) {
    issues.push({
      code: 'invalid-scenario-name',
      message:
        `invalid scenario name '${name}': a scenario is stored as ` +
        `.visual-diff/scenarios/<name>.yaml and named in meta.json, so it must start with a ` +
        'letter or digit and contain only letters, digits, dot, dash or underscore',
      at: locate(['scenario']),
    });
  }

  const expected = options.expectScenarioName;
  if (expected !== undefined && expected !== name) {
    issues.push({
      code: 'scenario-name-mismatch',
      message:
        `scenario is named '${name}' but the file is named '${expected}.yaml': the two must ` +
        'agree, because a run records the scenario by name and later looks the file up by it',
      at: locate(['scenario']),
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
  rule: ScenarioRuleInput,
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
        'rule id is empty: an id is required and stable, because it is what lets two versions of ' +
        'a scenario be compared and what the report names when it attributes a changed response',
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
        `duplicate rule id '${rule.id}' (already used by rules[${first}]). Rule ids are how two ` +
        'versions of a scenario are compared and how a changed response is attributed, so they ' +
        'must be unique within a scenario',
      at,
    });
    return;
  }
  seenIds.set(rule.id, index);
}

/* ------------------------------------------------------------------ match */

function validateMatch(
  rule: ScenarioRuleInput,
  index: number,
  locate: Locate,
  issues: ValidationIssue[],
): void {
  const { method, url, nth } = rule.match;

  if (url.trim() === '') {
    issues.push({
      code: 'missing-url',
      message:
        'match.url is empty: a rule is a URL glob applied to the whole URL including the query ' +
        "string, so match.url must name one — e.g. '**/v1/forecast**'",
      at: locate(['rules', index, 'match', 'url']),
    });
  } else {
    const parsed = parseGlob(url);
    if (!parsed.ok) {
      issues.push({
        code: 'invalid-glob',
        message: `invalid url glob ${JSON.stringify(url)}: ${parsed.reason}`,
        at: locate(['rules', index, 'match', 'url']),
      });
    }
  }

  if (method !== undefined && !HTTP_METHOD_RE.test(method)) {
    issues.push({
      code: 'invalid-method',
      message:
        `invalid match.method ${JSON.stringify(method)}: an HTTP method is a bare word such as ` +
        'GET, POST or DELETE. Omit match.method entirely to match any method',
      at: locate(['rules', index, 'match', 'method']),
    });
  }

  if (nth !== undefined) {
    const at = locate(['rules', index, 'match', 'nth']);
    if (!Number.isInteger(nth)) {
      issues.push({
        code: 'invalid-nth',
        message:
          `invalid nth ${describeNumber(nth)}: nth counts occurrences of an otherwise identical ` +
          'request, so it must be a whole number',
        at,
      });
    } else if (nth < 1) {
      issues.push({
        code: 'invalid-nth',
        message:
          `invalid nth ${nth}: nth selects the nth occurrence of an otherwise identical request ` +
          'and is 1-based, so the first occurrence is nth: 1',
        at,
      });
    }
  }
}

/* ------------------------------------------------------------------ delay */

function validateDelay(
  rule: ScenarioRuleInput,
  index: number,
  locate: Locate,
  issues: ValidationIssue[],
): void {
  const { delay } = rule;
  if (delay === undefined) return;
  const at = locate(['rules', index, 'delay']);

  if (!Number.isFinite(delay)) {
    issues.push({
      code: 'invalid-delay',
      message: `invalid delay ${describeNumber(delay)}: a delay is a number of milliseconds`,
      at,
    });
    return;
  }
  if (delay < 0) {
    issues.push({
      code: 'invalid-delay',
      message:
        `invalid delay ${delay}: a delay is a non-negative number of milliseconds, and there is ` +
        'no way to serve a response earlier than it was asked for',
      at,
    });
  }
}

/* ------------------------------------------------------------------ verbs */

function verbsOf(rule: ScenarioRuleInput): string[] {
  return RESPONSE_VERBS.filter((verb) => hasKey(rule, verb));
}

function validateVerbs(
  rule: ScenarioRuleInput,
  index: number,
  mode: ScenarioMode,
  locate: Locate,
  issues: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const present = verbsOf(rule);

  if (present.length === 0) {
    if (rule.delay === undefined) {
      issues.push({
        code: 'no-response-verb',
        message:
          `rule '${rule.id}' does nothing: a rule needs exactly one of ` +
          `${RESPONSE_VERBS.join(', ')} — or delay on its own, which passes the recorded ` +
          'response through late',
        at: locate(['rules', index]),
      });
    } else if (mode === 'mock') {
      warnings.push({
        code: 'delay-only-in-mock-mode',
        message:
          `rule '${rule.id}' has only a delay, which passes the recorded response through late — ` +
          'but mock mode has no recording, so the request is aborted as a miss anyway. Add a ' +
          'respond, or an abort if the miss is the point',
        at: locate(['rules', index, 'delay']),
      });
    }
    return;
  }

  if (present.length > 1) {
    // Reported once per verb after the first, so `--json` consumers can point at each key.
    for (const verb of present.slice(1)) {
      issues.push({
        code: 'two-response-verbs',
        message:
          `rule '${rule.id}' has ${present.length} response verbs (${present.join(', ')}): a rule ` +
          'takes exactly one, so that the tool never has to invent a precedence order between ' +
          'them. delay is a modifier and composes with any of them; split the rest into ' +
          'separate rules',
        at: locate(['rules', index, verb]),
      });
    }
    return;
  }

  for (const verb of RECORDING_DEPENDENT_VERBS) {
    if (!present.includes(verb) || mode !== 'mock') continue;
    issues.push({
      code: 'patch-in-mock-mode',
      message:
        `rule '${rule.id}' uses ${verb}, which is rejected in mock mode: there is no recorded ` +
        'body to patch, so the patch would be applied to nothing and produce whatever it ' +
        'contains, which looks like it worked. Use respond to state the whole response, or ' +
        'switch the scenario to overlay mode',
      at: locate(['rules', index, verb]),
    });
  }

  if (hasKey(rule, 'patch')) validatePatch(rule, index, locate, issues);
  if (rule.patchOps !== undefined) validatePatchOps(rule, index, locate, issues);
  if (rule.respond !== undefined) validateRespond(rule, index, locate, issues, warnings);
}

/* ------------------------------------------------------------------ patch (RFC 7386) */

function validatePatch(
  rule: ScenarioRuleInput,
  index: number,
  locate: Locate,
  issues: ValidationIssue[],
): void {
  const at = locate(['rules', index, 'patch']);
  const patch = rule.patch;

  // Stricter than §5 on purpose. `patch:` with nothing after it parses as null, and a merge patch
  // of null replaces the entire recorded body with the four bytes `null` — which renders as a
  // broken page and reads, in the report, exactly like a patch that worked.
  if (patch === null) {
    issues.push({
      code: 'empty-patch',
      message:
        `rule '${rule.id}' has an empty patch: a merge patch of null replaces the whole recorded ` +
        'body with null (RFC 7386), which is almost never the intent. Give patch a mapping, or ' +
        'use respond to state the whole response',
      at,
    });
    return;
  }

  const offence = findNonJson(patch);
  if (offence !== null) {
    issues.push({
      code: 'invalid-patch',
      message:
        `rule '${rule.id}' has a patch that is not JSON${offence.where}: ${offence.reason}. A ` +
        'merge patch is applied to a recorded JSON body, so every value in it must be JSON',
      at,
    });
  }
}

/* ------------------------------------------------------------------ patchOps (RFC 6902) */

const PATCH_OP_SET: ReadonlySet<string> = new Set<string>(JSON_PATCH_OPS);
const OPS_TAKING_VALUE: ReadonlySet<string> = new Set<string>(['add', 'replace', 'test']);
const OPS_TAKING_FROM: ReadonlySet<string> = new Set<string>(['move', 'copy']);
const PATCH_OP_KEY_SET: ReadonlySet<string> = new Set<string>(PATCH_OP_KEYS);

function validatePatchOps(
  rule: ScenarioRuleInput,
  index: number,
  locate: Locate,
  issues: ValidationIssue[],
): void {
  const ops = rule.patchOps ?? [];

  if (ops.length === 0) {
    issues.push({
      code: 'empty-patch-ops',
      message:
        `rule '${rule.id}' has an empty patchOps: a rule with no operations changes nothing, so ` +
        'either give it an operation or delete the rule',
      at: locate(['rules', index, 'patchOps']),
    });
    return;
  }

  ops.forEach((op, opIndex) => {
    validatePatchOp(rule, index, op, opIndex, locate, issues);
  });
}

function validatePatchOp(
  rule: ScenarioRuleInput,
  index: number,
  op: unknown,
  opIndex: number,
  locate: Locate,
  issues: ValidationIssue[],
): void {
  const base = ['rules', index, 'patchOps', opIndex] as const;
  const at = (key?: string): SourceLocation =>
    locate(key === undefined ? [...base] : [...base, key]);
  const push = (message: string, key?: string): void => {
    issues.push({ code: 'invalid-patch-op', message: `rule '${rule.id}': ${message}`, at: at(key) });
  };

  if (!isPlainObject(op)) {
    push(
      `patchOps[${opIndex}] is ${describeType(op)}, but an RFC 6902 operation is a mapping such ` +
        'as { op: remove, path: /daily/time/0 }',
    );
    return;
  }

  const unknownKeys = Object.keys(op).filter((key) => !PATCH_OP_KEY_SET.has(key));
  for (const key of unknownKeys) {
    push(
      `unknown key '${key}' in patchOps[${opIndex}]. An RFC 6902 operation is written with ` +
        `${PATCH_OP_KEYS.join(', ')}`,
      key,
    );
  }

  if (!hasKey(op, 'op')) {
    push(
      `patchOps[${opIndex}] is missing 'op'. RFC 6902 defines: ${JSON_PATCH_OPS.join(', ')}`,
    );
    return;
  }
  const verb = op.op;
  if (typeof verb !== 'string' || !PATCH_OP_SET.has(verb)) {
    push(
      `unknown JSON Patch op ${JSON.stringify(verb)} in patchOps[${opIndex}]. RFC 6902 defines: ` +
        JSON_PATCH_OPS.join(', '),
      'op',
    );
    return;
  }
  const name = verb as JsonPatchOp;

  validatePointer(op, 'path', name, opIndex, push);

  if (OPS_TAKING_VALUE.has(name)) {
    if (!hasKey(op, 'value')) {
      push(`JSON Patch op '${name}' requires 'value', and patchOps[${opIndex}] has none`);
    } else {
      const offence = findNonJson(op.value);
      if (offence !== null) {
        push(`the 'value' of patchOps[${opIndex}] is not JSON${offence.where}: ${offence.reason}`, 'value');
      }
    }
  } else if (hasKey(op, 'value')) {
    push(
      `JSON Patch op '${name}' does not take a 'value'. Only ` +
        `${[...OPS_TAKING_VALUE].join(', ')} do`,
      'value',
    );
  }

  if (OPS_TAKING_FROM.has(name)) {
    if (!hasKey(op, 'from')) {
      push(`JSON Patch op '${name}' requires 'from', and patchOps[${opIndex}] has none`);
    } else {
      validatePointer(op, 'from', name, opIndex, push);
    }
  } else if (hasKey(op, 'from')) {
    push(
      `JSON Patch op '${name}' does not take a 'from'. Only ${[...OPS_TAKING_FROM].join(', ')} do`,
      'from',
    );
  }

  if (name === 'move' && typeof op.from === 'string' && typeof op.path === 'string') {
    if (isProperPrefixPointer(op.from, op.path)) {
      push(
        `cannot move '${op.from}' into its own child '${op.path}': RFC 6902 forbids a move whose ` +
          "'from' is a prefix of its 'path'",
        'from',
      );
    }
  }
}

type PushIssue = (message: string, key?: string) => void;

function validatePointer(
  op: Record<string, unknown>,
  key: 'path' | 'from',
  name: JsonPatchOp,
  opIndex: number,
  push: PushIssue,
): void {
  if (!hasKey(op, key)) {
    if (key === 'path') {
      push(`JSON Patch op '${name}' is missing 'path' in patchOps[${opIndex}]`);
    }
    return;
  }
  const pointer = op[key];
  if (typeof pointer !== 'string') {
    push(
      `the '${key}' of patchOps[${opIndex}] is ${describeType(pointer)}, but a JSON Pointer is a ` +
        "string such as '/daily/time/0'",
      key,
    );
    return;
  }
  const reason = pointerProblem(pointer);
  if (reason !== null) {
    push(`invalid JSON Pointer ${JSON.stringify(pointer)} in patchOps[${opIndex}]: ${reason}`, key);
  }
}

/** RFC 6901 §3: a pointer is empty or a sequence of `/`-prefixed tokens; `~` escapes as `~0`/`~1`. */
function pointerProblem(pointer: string): string | null {
  if (pointer === '') return null;
  if (!pointer.startsWith('/')) {
    return "a pointer is either empty or starts with '/', so write '/daily/time/0'";
  }
  for (let i = 0; i < pointer.length; i += 1) {
    if (pointer[i] !== '~') continue;
    const next = pointer[i + 1];
    if (next !== '0' && next !== '1') {
      return "'~' is an escape and must be followed by '0' (a literal ~) or '1' (a literal /)";
    }
    i += 1;
  }
  return null;
}

/** True when `from` names an ancestor of `path` — `/a` is a prefix of `/a/b` but not of `/ab`. */
function isProperPrefixPointer(from: string, path: string): boolean {
  if (from === path) return false;
  if (from === '') return true;
  return path.startsWith(`${from}/`);
}

/* ------------------------------------------------------------------ respond */

function validateRespond(
  rule: ScenarioRuleInput,
  index: number,
  locate: Locate,
  issues: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const respond = rule.respond;
  if (respond === undefined) return;
  const { status, headers } = respond;

  const statusAt = locate(['rules', index, 'respond', 'status']);
  if (!Number.isInteger(status)) {
    issues.push({
      code: 'invalid-status',
      message: `invalid status ${describeNumber(status)}: an HTTP status is a whole number between 100 and 599`,
      at: statusAt,
    });
  } else if (status < 100 || status > 599) {
    issues.push({
      code: 'invalid-status',
      message: `invalid status ${status}: an HTTP status is between 100 and 599`,
      at: statusAt,
    });
  }

  if (headers !== undefined) {
    for (const name of Object.keys(headers)) {
      if (name.trim() !== '' && !/[\s:]/.test(name)) continue;
      issues.push({
        code: 'invalid-header',
        message: `invalid response header name ${JSON.stringify(name)}: a header name is a bare token such as content-type`,
        at: locate(['rules', index, 'respond', 'headers', name]),
      });
    }
  }

  validateRespondBody(rule, index, locate, issues, warnings);
}

function validateRespondBody(
  rule: ScenarioRuleInput,
  index: number,
  locate: Locate,
  issues: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const respond = rule.respond;
  if (respond === undefined || !hasKey(respond, 'body')) return;
  const at = locate(['rules', index, 'respond', 'body']);
  const body = respond.body;

  if (body === null) {
    warnings.push({
      code: 'null-body',
      message:
        `rule '${rule.id}' responds with a body of null, which sends the four bytes "null". Omit ` +
        'body entirely for an empty response',
      at,
    });
    return;
  }

  if (isPlainObject(body) && hasKey(body, 'base64')) {
    const extras = Object.keys(body).filter((key) => key !== 'base64');
    if (extras.length > 0) {
      issues.push({
        code: 'invalid-body',
        message:
          `rule '${rule.id}' has a respond.body with a 'base64' key alongside ` +
          `${extras.map((key) => `'${key}'`).join(', ')}: a binary body is written ` +
          '{ base64: ... } and nothing else',
        at,
      });
      return;
    }
    const encoded = body.base64;
    if (typeof encoded !== 'string') {
      issues.push({
        code: 'invalid-body',
        message: `rule '${rule.id}' has a respond.body.base64 that is ${describeType(encoded)}, but base64 is a string`,
        at,
      });
      return;
    }
    if (!BASE64_RE.test(encoded) || encoded.length % 4 !== 0) {
      issues.push({
        code: 'invalid-base64',
        message:
          `rule '${rule.id}' has a respond.body.base64 that is not valid base64: it must be ` +
          'A-Z, a-z, 0-9, + and /, padded with = to a multiple of four characters',
        at,
      });
    }
    return;
  }

  const offence = findNonJson(body);
  if (offence !== null) {
    issues.push({
      code: 'invalid-body',
      message:
        `rule '${rule.id}' has a respond.body that is not JSON${offence.where}: ${offence.reason}. ` +
        'A body is an object, a string, or { base64: ... } for binary',
      at,
    });
  }
}

/* ------------------------------------------------------------------ shadowing */

/**
 * "First match wins in file order" (mocking spec §5). A rule whose match is already covered by an
 * earlier one can therefore never fire — and the run-time "rule never matched" warning would then
 * blame the author for a glob that is perfectly correct, so it is worth saying at validation time.
 * A warning rather than an error: the shadowed rule may be a deliberate placeholder.
 */
function validateShadowing(
  rules: readonly ScenarioRuleInput[],
  rule: ScenarioRuleInput,
  index: number,
  locate: Locate,
  warnings: ValidationIssue[],
): void {
  for (let i = 0; i < index; i += 1) {
    const earlier = rules[i];
    if (earlier === undefined) continue;
    if (earlier.match.url !== rule.match.url) continue;
    if (
      earlier.match.method !== undefined &&
      earlier.match.method.toUpperCase() !== rule.match.method?.toUpperCase()
    ) {
      continue;
    }
    if (earlier.match.nth !== undefined && earlier.match.nth !== rule.match.nth) continue;

    warnings.push({
      code: 'unreachable-rule',
      message:
        `rule '${rule.id}' can never match: rule '${earlier.id}' at rules[${i}] already matches ` +
        'the same requests, and the first match wins in file order',
      at: locate(['rules', index, 'match']),
    });
    return;
  }
}

/* ------------------------------------------------------------------ JSON-ness */

interface NonJson {
  /** `" at hourly.temperature_2m"`, or `''` for the value itself. */
  where: string;
  reason: string;
}

/**
 * First value inside `root` that has no JSON form, described by path. YAML can produce numbers
 * that JSON cannot hold (`.nan`, `.inf`), maps with non-string keys, and — through anchors —
 * structures that refer to themselves.
 */
export function findNonJson(root: unknown): NonJson | null {
  const seen = new Set<object>();

  const walk = (value: unknown, path: Array<string | number>): NonJson | null => {
    const where = path.length === 0 ? '' : ` at ${pathLabel(path)}`;

    if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;

    if (typeof value === 'number') {
      if (Number.isFinite(value)) return null;
      return { where, reason: `${describeNumber(value)} is not a number JSON can hold` };
    }

    if (typeof value !== 'object') {
      return { where, reason: `a ${typeof value} has no JSON form` };
    }
    if (seen.has(value)) {
      return { where, reason: 'it refers to itself, and a self-referencing document has no JSON form' };
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const found = walk(value[i], [...path, i]);
        if (found !== null) return found;
      }
      seen.delete(value);
      return null;
    }

    if (!isPlainObject(value)) {
      return { where, reason: `${describeType(value)} has no JSON form` };
    }

    for (const [key, entry] of Object.entries(value)) {
      const found = walk(entry, [...path, key]);
      if (found !== null) return found;
    }
    seen.delete(value);
    return null;
  };

  return walk(root, []);
}

function pathLabel(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

/* ------------------------------------------------------------------ helpers */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `NaN` and `Infinity` stringify as themselves; everything else gets JSON quoting. */
function describeNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return String(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Date) return 'a date';
  if (value instanceof Map) return 'a YAML complex-key mapping';
  if (value instanceof Set) return 'a YAML set';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  return `a ${typeof value}`;
}
