/**
 * RFC 7386 JSON merge patch, implemented in-repo (mocking spec §11).
 *
 * The whole algorithm is the five lines of RFC 7386 §2, and taking a dependency for it would put a
 * download in front of every `npx` user for no gain. The rules, in the RFC's own terms:
 *
 * - a patch that is not an object replaces the target wholesale (including `null`, arrays, scalars)
 * - an object patch applied to a non-object target starts from `{}`
 * - `null` at a key **deletes** that key rather than setting it to null
 * - any other value at a key recurses
 *
 * The deletion rule is the reason `patchOps` (RFC 6902) exists alongside this: merge patch cannot
 * set a key to `null`, cannot touch a single array element, and cannot remove one.
 *
 * Nothing here mutates its input. The recorded response body is shared with attribution (which
 * compares before against after to decide `bodyChanged`) and with any other rule that reads it, so
 * in-place mutation would corrupt both.
 */

import type { JsonObject, JsonValue, MergePatch } from '../types.js';

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Apply a merge patch, returning a new document. `target` may be `undefined` for "no document",
 * which RFC 7386 treats exactly as `null`: an object patch then builds a fresh object.
 */
export function applyMergePatch(target: JsonValue | undefined, patch: MergePatch): JsonValue {
  if (!isJsonObject(patch)) return cloneJson(patch);

  const base: JsonObject = isJsonObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    base[key] = applyMergePatch(base[key], value);
  }
  return base;
}

/** A structural clone that keeps the `JsonValue` type, used wherever a patch value is stored. */
export function cloneJson<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}

/**
 * RFC 6902 §4.6 equality, which is also what "did the body change?" means for attribution: order
 * matters inside arrays, never between object keys.
 */
export function jsonEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEquals(item, b[index]));
  }
  if (typeof a === 'object' || typeof b === 'object') {
    if (!isJsonObject(a) || !isJsonObject(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEquals(a[key], b[key]),
    );
  }
  return false;
}
