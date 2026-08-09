/**
 * RFC 6902 JSON Patch and RFC 6901 JSON Pointer, implemented in-repo (mocking spec §11).
 *
 * `patchOps` exists for what merge patch cannot express: array indices, removals, and setting a key
 * to `null` (§5). Those are exactly the sharp edges of the RFC, so they are spelled out here:
 *
 * - **`add` on an array inserts, it does not overwrite.** `add /a/0` shifts every later element up;
 *   `replace /a/0` is the overwrite. Both are legal at existing indices, and `add` is additionally
 *   legal at `length` (append) and at the `-` token (append).
 * - **`-` means "past the last element" and is only valid for `add`** (and as the target of `move`
 *   or `copy`, which are defined in terms of `add`). `remove /a/-` and `replace /a/-` are errors,
 *   not "the last element".
 * - **`remove` shifts indices**, so a patch removing `/a/0` twice removes two elements, and the
 *   canonical "remove several by index" patch lists them highest-first.
 * - **Array index tokens are strict**: decimal digits with no leading zeros, no sign, no whitespace.
 *   `/a/01` is malformed, not index 1.
 * - **A patch is atomic.** Every operation is applied to a clone, and a failure returns the failure
 *   rather than a half-applied document; the caller's input is never touched.
 *
 * Every failure message names the operation index, the op and the path, because these messages
 * surface as run failures naming the responsible rule (§8).
 */

import { JSON_PATCH_OPS, type JsonPatchOperation, type JsonValue } from '../types.js';
import { cloneJson, isJsonObject, jsonEquals } from './merge-patch.js';

export type JsonPatchErrorCode =
  | 'invalid-pointer'
  | 'invalid-index'
  | 'index-out-of-range'
  | 'dash-not-allowed'
  | 'target-missing'
  | 'parent-missing'
  | 'root-not-removable'
  | 'move-into-self'
  | 'test-failed';

export interface JsonPatchFailure {
  /** Index into the `patchOps` list, so the message can point at the YAML entry. */
  index: number;
  op: string;
  path: string;
  code: JsonPatchErrorCode;
  /** Full user-facing sentence, already prefixed with `patchOps[i] <op> <path>`. */
  message: string;
}

export type JsonPatchApplyResult =
  | { ok: true; value: JsonValue }
  | { ok: false; error: JsonPatchFailure };

export type PointerParseResult = { ok: true; tokens: string[] } | { ok: false; detail: string };

/* ------------------------------------------------------------------ RFC 6901 pointers */

/** Unescape one reference token: `~1` is `/` and `~0` is `~`, in that order (RFC 6901 §4). */
export function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function parseJsonPointer(pointer: string): PointerParseResult {
  if (pointer === '') return { ok: true, tokens: [] };
  if (!pointer.startsWith('/')) {
    return {
      ok: false,
      detail:
        "a JSON Pointer must be empty (the whole document) or start with '/', e.g. /daily/time/0",
    };
  }
  return { ok: true, tokens: pointer.slice(1).split('/').map(unescapeToken) };
}

/** `/daily/time/0` from `['daily', 'time', '0']`. */
export function formatJsonPointer(tokens: readonly string[]): string {
  return tokens.map((token) => `/${escapeToken(token)}`).join('');
}

const INDEX_RE = /^(?:0|[1-9][0-9]*)$/;

/* ------------------------------------------------------------------ navigation */

type Found = { found: true; value: JsonValue } | { found: false };

function getAt(doc: JsonValue, tokens: readonly string[]): Found {
  let current: JsonValue = doc;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!INDEX_RE.test(token)) return { found: false };
      const index = Number(token);
      if (index >= current.length) return { found: false };
      current = current[index] as JsonValue;
      continue;
    }
    if (isJsonObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return { found: false };
      current = current[token] as JsonValue;
      continue;
    }
    return { found: false };
  }
  return { found: true, value: current };
}

/* ------------------------------------------------------------------ apply */

function failure(
  index: number,
  op: JsonPatchOperation,
  code: JsonPatchErrorCode,
  detail: string,
): JsonPatchApplyResult {
  const from = 'from' in op ? ` from ${op.from}` : '';
  return {
    ok: false,
    error: {
      index,
      op: op.op,
      path: op.path,
      code,
      message: `patchOps[${index}] ${op.op} ${op.path}${from}: ${detail}`,
    },
  };
}

interface Cursor {
  parent: JsonValue;
  token: string;
}

function parentOf(doc: JsonValue, tokens: readonly string[]): Cursor | null {
  const found = getAt(doc, tokens.slice(0, -1));
  if (!found.found) return null;
  return { parent: found.value, token: tokens[tokens.length - 1] as string };
}

/**
 * Insert (`add`) or overwrite (`replace`) at `tokens`. Returns the new document, or a failure.
 * Both verbs share this because the only difference is what the target is allowed to be.
 */
function put(
  doc: JsonValue,
  tokens: readonly string[],
  value: JsonValue,
  mode: 'add' | 'replace',
  index: number,
  op: JsonPatchOperation,
): JsonPatchApplyResult {
  if (tokens.length === 0) return { ok: true, value };

  const cursor = parentOf(doc, tokens);
  if (cursor === null) {
    return failure(
      index,
      op,
      'parent-missing',
      `the parent path ${formatJsonPointer(tokens.slice(0, -1)) || '(document root)'} does not ` +
        'exist in the response body',
    );
  }

  const { parent, token } = cursor;

  if (Array.isArray(parent)) {
    if (token === '-') {
      if (mode === 'replace') {
        return failure(
          index,
          op,
          'dash-not-allowed',
          "the '-' token means \"past the last element\" and is only valid for add, not replace",
        );
      }
      parent.push(value);
      return { ok: true, value: doc };
    }
    if (!INDEX_RE.test(token)) {
      return failure(
        index,
        op,
        'invalid-index',
        `'${token}' is not a valid array index — RFC 6902 array indices are decimal digits with ` +
          "no leading zeros, or '-' to append",
      );
    }
    const at = Number(token);
    const limit = mode === 'add' ? parent.length : parent.length - 1;
    if (at > limit) {
      return failure(
        index,
        op,
        'index-out-of-range',
        mode === 'add'
          ? `array index ${at} is past the end of an array of length ${parent.length} — add ` +
            `accepts 0..${parent.length} or '-'`
          : `array index ${at} is out of range for an array of length ${parent.length}`,
      );
    }
    if (mode === 'add') parent.splice(at, 0, value);
    else parent[at] = value;
    return { ok: true, value: doc };
  }

  if (isJsonObject(parent)) {
    if (mode === 'replace' && !Object.prototype.hasOwnProperty.call(parent, token)) {
      return failure(
        index,
        op,
        'target-missing',
        `the path ${op.path} does not exist in the response body — replace requires an existing ` +
          'target, use add to create one',
      );
    }
    parent[token] = value;
    return { ok: true, value: doc };
  }

  return failure(
    index,
    op,
    'parent-missing',
    `${formatJsonPointer(tokens.slice(0, -1)) || '(document root)'} is ${describe(parent)}, which ` +
      'has no members to address',
  );
}

function removeAt(
  doc: JsonValue,
  tokens: readonly string[],
  index: number,
  op: JsonPatchOperation,
): { ok: true; doc: JsonValue; removed: JsonValue } | { ok: false; result: JsonPatchApplyResult } {
  if (tokens.length === 0) {
    return {
      ok: false,
      result: failure(
        index,
        op,
        'root-not-removable',
        'the whole document cannot be removed — an empty path addresses the document root',
      ),
    };
  }

  const cursor = parentOf(doc, tokens);
  if (cursor === null) {
    return {
      ok: false,
      result: failure(
        index,
        op,
        'parent-missing',
        `the parent path ${formatJsonPointer(tokens.slice(0, -1)) || '(document root)'} does not ` +
          'exist in the response body',
      ),
    };
  }

  const { parent, token } = cursor;

  if (Array.isArray(parent)) {
    if (token === '-') {
      return {
        ok: false,
        result: failure(
          index,
          op,
          'dash-not-allowed',
          "the '-' token means \"past the last element\" and is only valid for add — to drop the " +
            `last element use index ${Math.max(parent.length - 1, 0)}`,
        ),
      };
    }
    if (!INDEX_RE.test(token)) {
      return {
        ok: false,
        result: failure(
          index,
          op,
          'invalid-index',
          `'${token}' is not a valid array index — RFC 6902 array indices are decimal digits with ` +
            'no leading zeros',
        ),
      };
    }
    const at = Number(token);
    if (at >= parent.length) {
      return {
        ok: false,
        result: failure(
          index,
          op,
          'index-out-of-range',
          `array index ${at} is out of range for an array of length ${parent.length}`,
        ),
      };
    }
    const [removed] = parent.splice(at, 1);
    return { ok: true, doc, removed: removed as JsonValue };
  }

  if (isJsonObject(parent)) {
    if (!Object.prototype.hasOwnProperty.call(parent, token)) {
      return {
        ok: false,
        result: failure(
          index,
          op,
          'target-missing',
          `the path ${op.path} does not exist in the response body`,
        ),
      };
    }
    const removed = parent[token] as JsonValue;
    delete parent[token];
    return { ok: true, doc, removed };
  }

  return {
    ok: false,
    result: failure(
      index,
      op,
      'parent-missing',
      `${formatJsonPointer(tokens.slice(0, -1)) || '(document root)'} is ${describe(parent)}, ` +
        'which has no members to address',
    ),
  };
}

function describe(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `the ${typeof value} ${JSON.stringify(value)}`;
}

/** True when `from` addresses an ancestor of `path`, which RFC 6902 forbids `move` from doing. */
function isProperPrefix(from: readonly string[], path: readonly string[]): boolean {
  if (from.length >= path.length) return false;
  return from.every((token, i) => token === path[i]);
}

function applyOne(doc: JsonValue, op: JsonPatchOperation, index: number): JsonPatchApplyResult {
  const parsedPath = parseJsonPointer(op.path);
  if (!parsedPath.ok) return failure(index, op, 'invalid-pointer', parsedPath.detail);
  const tokens = parsedPath.tokens;

  switch (op.op) {
    case 'add':
      return put(doc, tokens, cloneJson(op.value), 'add', index, op);

    case 'replace':
      return put(doc, tokens, cloneJson(op.value), 'replace', index, op);

    case 'remove': {
      const removed = removeAt(doc, tokens, index, op);
      return removed.ok ? { ok: true, value: removed.doc } : removed.result;
    }

    case 'test': {
      const found = getAt(doc, tokens);
      if (!found.found) {
        return failure(
          index,
          op,
          'target-missing',
          `the path ${op.path || '(document root)'} does not exist in the response body, so the ` +
            'test cannot pass',
        );
      }
      if (!jsonEquals(found.value, op.value)) {
        return failure(
          index,
          op,
          'test-failed',
          `test failed — expected ${JSON.stringify(op.value)} but the response body has ` +
            `${JSON.stringify(found.value)}`,
        );
      }
      return { ok: true, value: doc };
    }

    case 'copy':
    case 'move': {
      const parsedFrom = parseJsonPointer(op.from);
      if (!parsedFrom.ok) {
        return failure(index, op, 'invalid-pointer', `from: ${parsedFrom.detail}`);
      }
      const fromTokens = parsedFrom.tokens;
      const found = getAt(doc, fromTokens);
      if (!found.found) {
        return failure(
          index,
          op,
          'target-missing',
          `the from path ${op.from || '(document root)'} does not exist in the response body`,
        );
      }
      if (op.op === 'copy') {
        return put(doc, tokens, cloneJson(found.value), 'add', index, op);
      }
      // Order matters: an empty `from` is a prefix of every path, so the root check has to come
      // first or "move from the root" would be reported as "moved into its own child".
      if (fromTokens.length === 0) {
        return failure(
          index,
          op,
          'root-not-removable',
          'the whole document cannot be moved — an empty from path addresses the document root',
        );
      }
      if (isProperPrefix(fromTokens, tokens)) {
        return failure(
          index,
          op,
          'move-into-self',
          `${op.from} cannot be moved into its own child ${op.path}`,
        );
      }
      const removed = removeAt(doc, fromTokens, index, op);
      if (!removed.ok) return removed.result;
      return put(removed.doc, tokens, removed.removed, 'add', index, op);
    }

    default: {
      const unknown = op as { op: string };
      return failure(
        index,
        op,
        'invalid-pointer',
        `unknown op '${unknown.op}' — RFC 6902 defines ${JSON_PATCH_OPS.join(', ')}`,
      );
    }
  }
}

/**
 * Apply an RFC 6902 patch to a document, returning a new document or the first failure. The input
 * is never mutated: everything runs against a clone, so a failing patch leaves the recorded body
 * exactly as it was.
 */
export function applyJsonPatch(
  doc: JsonValue,
  ops: readonly JsonPatchOperation[],
): JsonPatchApplyResult {
  let current: JsonValue = cloneJson(doc);
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index] as JsonPatchOperation;
    const result = applyOne(current, op, index);
    if (!result.ok) return result;
    current = result.value;
  }
  return { ok: true, value: current };
}

/* ------------------------------------------------------------------ shape validation (§8) */

const OP_KEYS: Record<string, readonly string[]> = {
  add: ['op', 'path', 'value'],
  remove: ['op', 'path'],
  replace: ['op', 'path', 'value'],
  move: ['op', 'path', 'from'],
  copy: ['op', 'path', 'from'],
  test: ['op', 'path', 'value'],
};

const REQUIRED_VALUE = new Set(['add', 'replace', 'test']);
const REQUIRED_FROM = new Set(['move', 'copy']);

/**
 * "Malformed RFC 6902 op" for §8 validation, as a user-facing message or `null` when the operation
 * is well formed. Kept next to the interpreter so the two can never disagree about what is legal.
 */
export function validateJsonPatchOperation(value: unknown, index: number): string | null {
  const at = `patchOps[${index}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${at}: each entry must be a mapping with an 'op' and a 'path', e.g. { op: remove, path: /daily/time/0 }`;
  }

  const record = value as Record<string, unknown>;
  const op = record.op;
  if (typeof op !== 'string' || op === '') {
    return `${at}: 'op' is required and must be one of ${JSON_PATCH_OPS.join(', ')}`;
  }
  if (!(JSON_PATCH_OPS as readonly string[]).includes(op)) {
    return `${at}: unknown op '${op}' — RFC 6902 defines ${JSON_PATCH_OPS.join(', ')}`;
  }

  const path = record.path;
  if (typeof path !== 'string') {
    return `${at} ${op}: 'path' is required and must be a JSON Pointer string, e.g. /daily/time/0`;
  }
  const parsedPath = parseJsonPointer(path);
  if (!parsedPath.ok) return `${at} ${op} ${path}: ${parsedPath.detail}`;

  if (REQUIRED_VALUE.has(op) && !Object.prototype.hasOwnProperty.call(record, 'value')) {
    return `${at} ${op} ${path}: 'value' is required for op '${op}'`;
  }
  if (!REQUIRED_VALUE.has(op) && Object.prototype.hasOwnProperty.call(record, 'value')) {
    return `${at} ${op} ${path}: 'value' is not allowed for op '${op}'`;
  }

  if (REQUIRED_FROM.has(op)) {
    const from = record.from;
    if (typeof from !== 'string') {
      return `${at} ${op} ${path}: 'from' is required for op '${op}' and must be a JSON Pointer string`;
    }
    const parsedFrom = parseJsonPointer(from);
    if (!parsedFrom.ok) return `${at} ${op} ${path}: from ${from}: ${parsedFrom.detail}`;
  } else if (Object.prototype.hasOwnProperty.call(record, 'from')) {
    return `${at} ${op} ${path}: 'from' is not allowed for op '${op}'`;
  }

  const allowed = OP_KEYS[op] as readonly string[];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return `${at} ${op} ${path}: unknown key '${key}' — op '${op}' takes ${allowed.join(', ')}`;
    }
  }

  return null;
}

/** Every malformed operation in a `patchOps` list, in order. */
export function validateJsonPatch(ops: unknown): string[] {
  if (!Array.isArray(ops)) {
    return ["patchOps: expected a list of RFC 6902 operations, e.g. - { op: remove, path: /daily/time/0 }"];
  }
  const messages: string[] = [];
  ops.forEach((op, index) => {
    const message = validateJsonPatchOperation(op, index);
    if (message !== null) messages.push(message);
  });
  return messages;
}
