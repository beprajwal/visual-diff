import { describe, expect, it } from 'vitest';

import type { JsonPatchOperation, JsonValue } from '../types.js';
import {
  applyJsonPatch,
  escapeToken,
  formatJsonPointer,
  parseJsonPointer,
  unescapeToken,
  validateJsonPatch,
  validateJsonPatchOperation,
} from './json-patch.js';

const DAILY = {
  daily: {
    time: ['2026-08-10', '2026-08-11', '2026-08-12'],
    weather_code: [3, 61, 0],
  },
};

function apply(doc: JsonValue, ops: JsonPatchOperation[]): JsonValue {
  const result = applyJsonPatch(doc, ops);
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.message}`);
  return result.value;
}

function failure(doc: JsonValue, ops: JsonPatchOperation[]) {
  const result = applyJsonPatch(doc, ops);
  if (result.ok) throw new Error('expected the patch to fail');
  return result.error;
}

describe('RFC 6901 pointers', () => {
  it('parses the empty pointer as the whole document', () => {
    expect(parseJsonPointer('')).toEqual({ ok: true, tokens: [] });
  });

  it('unescapes ~1 as / and ~0 as ~, in that order', () => {
    expect(parseJsonPointer('/a~1b/c~0d')).toEqual({ ok: true, tokens: ['a/b', 'c~d'] });
    expect(unescapeToken('~01')).toBe('~1');
    expect(escapeToken('a/b~c')).toBe('a~1b~0c');
    expect(formatJsonPointer(['a/b', 'c'])).toBe('/a~1b/c');
  });

  it('keeps empty tokens, which address the "" key', () => {
    expect(parseJsonPointer('/')).toEqual({ ok: true, tokens: [''] });
    expect(apply({ '': 1 }, [{ op: 'replace', path: '/', value: 2 }])).toEqual({ '': 2 });
  });

  it('rejects a pointer that does not start with /', () => {
    expect(parseJsonPointer('daily/time')).toEqual({
      ok: false,
      detail:
        "a JSON Pointer must be empty (the whole document) or start with '/', e.g. /daily/time/0",
    });
  });
});

describe('add versus replace on arrays', () => {
  it('add inserts and shifts the rest up; replace overwrites in place', () => {
    expect(apply(DAILY, [{ op: 'add', path: '/daily/weather_code/0', value: 95 }])).toEqual({
      daily: { time: DAILY.daily.time, weather_code: [95, 3, 61, 0] },
    });
    expect(apply(DAILY, [{ op: 'replace', path: '/daily/weather_code/0', value: 95 }])).toEqual({
      daily: { time: DAILY.daily.time, weather_code: [95, 61, 0] },
    });
  });

  it('add accepts the index one past the end, which appends', () => {
    expect(apply({ a: [1, 2] }, [{ op: 'add', path: '/a/2', value: 3 }])).toEqual({ a: [1, 2, 3] });
  });

  it("add accepts the '-' token, which appends", () => {
    expect(apply({ a: [1, 2] }, [{ op: 'add', path: '/a/-', value: 3 }])).toEqual({ a: [1, 2, 3] });
    expect(apply({ a: [] }, [{ op: 'add', path: '/a/-', value: 1 }])).toEqual({ a: [1] });
  });

  it("refuses '-' for replace and remove, naming the index to use instead", () => {
    expect(failure({ a: [1, 2] }, [{ op: 'replace', path: '/a/-', value: 3 }])).toEqual({
      index: 0,
      op: 'replace',
      path: '/a/-',
      code: 'dash-not-allowed',
      message:
        'patchOps[0] replace /a/-: the \'-\' token means "past the last element" and is only ' +
        'valid for add, not replace',
    });
    expect(failure({ a: [1, 2] }, [{ op: 'remove', path: '/a/-' }]).message).toBe(
      'patchOps[0] remove /a/-: the \'-\' token means "past the last element" and is only valid ' +
        'for add — to drop the last element use index 1',
    );
  });

  it('refuses an index past the end, differently for add and replace', () => {
    expect(failure({ a: [1, 2] }, [{ op: 'add', path: '/a/5', value: 3 }]).message).toBe(
      "patchOps[0] add /a/5: array index 5 is past the end of an array of length 2 — add accepts 0..2 or '-'",
    );
    expect(failure({ a: [1, 2] }, [{ op: 'replace', path: '/a/2', value: 3 }]).message).toBe(
      'patchOps[0] replace /a/2: array index 2 is out of range for an array of length 2',
    );
  });

  it('refuses a malformed index rather than coercing it', () => {
    expect(failure({ a: [1, 2] }, [{ op: 'add', path: '/a/01', value: 3 }]).message).toBe(
      "patchOps[0] add /a/01: '01' is not a valid array index — RFC 6902 array indices are " +
        "decimal digits with no leading zeros, or '-' to append",
    );
    expect(failure({ a: [1, 2] }, [{ op: 'remove', path: '/a/ 1' }]).message).toBe(
      "patchOps[0] remove /a/ 1: ' 1' is not a valid array index — RFC 6902 array indices are " +
        'decimal digits with no leading zeros',
    );
    expect(failure({ a: [1, 2] }, [{ op: 'replace', path: '/a/-1', value: 0 }]).code).toBe(
      'invalid-index',
    );
  });
});

describe('remove shifts indices', () => {
  it('removing the same index twice removes two elements', () => {
    expect(
      apply(DAILY, [
        { op: 'remove', path: '/daily/time/0' },
        { op: 'remove', path: '/daily/time/0' },
      ]),
    ).toEqual({ daily: { time: ['2026-08-12'], weather_code: [3, 61, 0] } });
  });

  it('removing low-to-high drops the wrong elements, high-to-low drops the right ones', () => {
    const doc = { a: [0, 1, 2, 3] };
    expect(
      apply(doc, [
        { op: 'remove', path: '/a/1' },
        { op: 'remove', path: '/a/2' },
      ]),
    ).toEqual({ a: [0, 2] });
    expect(
      apply(doc, [
        { op: 'remove', path: '/a/2' },
        { op: 'remove', path: '/a/1' },
      ]),
    ).toEqual({ a: [0, 3] });
  });

  it('runs the spec §5 example: drop the first day and restate its code', () => {
    expect(
      apply(DAILY, [
        { op: 'remove', path: '/daily/time/0' },
        { op: 'replace', path: '/daily/weather_code/0', value: 95 },
      ]),
    ).toEqual({
      daily: { time: ['2026-08-11', '2026-08-12'], weather_code: [95, 61, 0] },
    });
  });
});

describe('objects and the document root', () => {
  it('adds, replaces and removes object members', () => {
    expect(apply({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }])).toEqual({ a: 1, b: 2 });
    expect(apply({ a: 1 }, [{ op: 'add', path: '/a', value: 2 }])).toEqual({ a: 2 });
    expect(apply({ a: 1, b: 2 }, [{ op: 'remove', path: '/b' }])).toEqual({ a: 1 });
  });

  it('sets a key to null, which merge patch cannot express (§5)', () => {
    expect(apply({ a: 1 }, [{ op: 'replace', path: '/a', value: null }])).toEqual({ a: null });
  });

  it('replaces the whole document through the empty path', () => {
    expect(apply({ a: 1 }, [{ op: 'replace', path: '', value: { b: 2 } }])).toEqual({ b: 2 });
    expect(apply({ a: 1 }, [{ op: 'add', path: '', value: [] }])).toEqual([]);
  });

  it('refuses to remove the whole document', () => {
    expect(failure({ a: 1 }, [{ op: 'remove', path: '' }]).message).toBe(
      'patchOps[0] remove : the whole document cannot be removed — an empty path addresses the document root',
    );
  });

  it('requires replace to have an existing target, and says to use add', () => {
    expect(failure({ a: 1 }, [{ op: 'replace', path: '/b', value: 2 }]).message).toBe(
      'patchOps[0] replace /b: the path /b does not exist in the response body — replace requires ' +
        'an existing target, use add to create one',
    );
  });

  it('requires a parent to exist, naming the parent path', () => {
    expect(failure({ a: 1 }, [{ op: 'add', path: '/x/y', value: 2 }]).message).toBe(
      'patchOps[0] add /x/y: the parent path /x does not exist in the response body',
    );
  });

  it('refuses to address members of a scalar', () => {
    expect(failure({ a: 1 }, [{ op: 'add', path: '/a/b', value: 2 }]).message).toBe(
      'patchOps[0] add /a/b: /a is the number 1, which has no members to address',
    );
    expect(failure({ a: null }, [{ op: 'remove', path: '/a/b' }]).message).toBe(
      'patchOps[0] remove /a/b: /a is null, which has no members to address',
    );
  });

  it('removes a missing object key with a clear message', () => {
    expect(failure({ a: 1 }, [{ op: 'remove', path: '/b' }]).message).toBe(
      'patchOps[0] remove /b: the path /b does not exist in the response body',
    );
  });
});

describe('move, copy and test', () => {
  it('moves a value, removing it from its old home first', () => {
    expect(apply({ a: [1, 2, 3], b: {} }, [{ op: 'move', path: '/b/x', from: '/a/0' }])).toEqual({
      a: [2, 3],
      b: { x: 1 },
    });
  });

  it('moves within one array, with indices computed after the removal', () => {
    expect(apply({ a: [0, 1, 2] }, [{ op: 'move', path: '/a/2', from: '/a/0' }])).toEqual({
      a: [1, 2, 0],
    });
  });

  it('refuses to move a container into its own child', () => {
    expect(failure({ a: { b: {} } }, [{ op: 'move', path: '/a/b/c', from: '/a' }]).message).toBe(
      'patchOps[0] move /a/b/c from /a: /a cannot be moved into its own child /a/b/c',
    );
  });

  it('refuses to move the document root', () => {
    expect(failure({ a: 1 }, [{ op: 'move', path: '/b', from: '' }]).message).toBe(
      'patchOps[0] move /b from : the whole document cannot be moved — an empty from path ' +
        'addresses the document root',
    );
  });

  it('copies without aliasing the source', () => {
    const patched = apply({ a: { deep: [1] } }, [{ op: 'copy', path: '/b', from: '/a' }]) as {
      a: { deep: number[] };
      b: { deep: number[] };
    };
    patched.b.deep.push(2);
    expect(patched.a.deep).toEqual([1]);
  });

  it('reports a missing from path', () => {
    expect(failure({ a: 1 }, [{ op: 'copy', path: '/b', from: '/nope' }]).message).toBe(
      'patchOps[0] copy /b from /nope: the from path /nope does not exist in the response body',
    );
  });

  it('passes a satisfied test and fails an unsatisfied one, showing both values', () => {
    expect(apply({ status: 'ok' }, [{ op: 'test', path: '/status', value: 'ok' }])).toEqual({
      status: 'ok',
    });
    expect(failure({ status: 'ok' }, [{ op: 'test', path: '/status', value: 'error' }]).message).toBe(
      'patchOps[0] test /status: test failed — expected "error" but the response body has "ok"',
    );
  });

  it('tests structurally, ignoring object key order', () => {
    expect(apply({ a: { x: 1, y: 2 } }, [{ op: 'test', path: '/a', value: { y: 2, x: 1 } }])).toEqual(
      { a: { x: 1, y: 2 } },
    );
    expect(failure({ a: [1, 2] }, [{ op: 'test', path: '/a', value: [2, 1] }]).code).toBe(
      'test-failed',
    );
  });

  it('fails a test against a path that does not exist', () => {
    expect(failure({ a: 1 }, [{ op: 'test', path: '/b', value: 1 }]).message).toBe(
      'patchOps[0] test /b: the path /b does not exist in the response body, so the test cannot pass',
    );
  });
});

describe('atomicity and purity', () => {
  it('leaves the input document untouched, success or failure', () => {
    const doc = structuredClone(DAILY);
    apply(doc, [{ op: 'remove', path: '/daily/time/0' }]);
    expect(doc).toEqual(DAILY);
    failure(doc, [{ op: 'remove', path: '/daily/time/9' }]);
    expect(doc).toEqual(DAILY);
  });

  it('applies nothing when a later operation fails', () => {
    const result = applyJsonPatch(DAILY, [
      { op: 'remove', path: '/daily/time/0' },
      { op: 'replace', path: '/daily/nope', value: 1 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.index).toBe(1);
    expect(DAILY.daily.time).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
  });

  it('does not alias values supplied by the patch', () => {
    const value = { nested: [1] };
    const patched = apply({}, [{ op: 'add', path: '/a', value }]) as { a: { nested: number[] } };
    patched.a.nested.push(2);
    expect(value.nested).toEqual([1]);
  });

  it('applies an empty op list as a no-op', () => {
    expect(apply(DAILY, [])).toEqual(DAILY);
  });

  it('reports the index of the failing operation, not the first one', () => {
    const error = failure({ a: [1] }, [
      { op: 'add', path: '/a/-', value: 2 },
      { op: 'add', path: '/a/-', value: 3 },
      { op: 'remove', path: '/a/9' },
    ]);
    expect(error.index).toBe(2);
    expect(error.message).toBe(
      'patchOps[2] remove /a/9: array index 9 is out of range for an array of length 3',
    );
  });

  it('rejects an invalid pointer before touching the document', () => {
    expect(failure({ a: 1 }, [{ op: 'add', path: 'a', value: 1 }]).message).toBe(
      "patchOps[0] add a: a JSON Pointer must be empty (the whole document) or start with '/', " +
        'e.g. /daily/time/0',
    );
    expect(failure({ a: 1 }, [{ op: 'copy', path: '/b', from: 'a' }]).message).toBe(
      "patchOps[0] copy /b from a: from: a JSON Pointer must be empty (the whole document) or " +
        "start with '/', e.g. /daily/time/0",
    );
  });
});

describe('malformed op validation (§8)', () => {
  it('accepts every well-formed operation', () => {
    const ops: unknown[] = [
      { op: 'add', path: '/a', value: 1 },
      { op: 'remove', path: '/a' },
      { op: 'replace', path: '/a', value: null },
      { op: 'move', path: '/a', from: '/b' },
      { op: 'copy', path: '/a', from: '/b' },
      { op: 'test', path: '', value: {} },
    ];
    expect(validateJsonPatch(ops)).toEqual([]);
  });

  it('requires a list of mappings', () => {
    expect(validateJsonPatch({ op: 'add' })).toEqual([
      'patchOps: expected a list of RFC 6902 operations, e.g. - { op: remove, path: /daily/time/0 }',
    ]);
    expect(validateJsonPatchOperation('remove /a/0', 0)).toBe(
      "patchOps[0]: each entry must be a mapping with an 'op' and a 'path', e.g. { op: remove, path: /daily/time/0 }",
    );
  });

  it('names the six legal ops when op is missing or unknown', () => {
    expect(validateJsonPatchOperation({ path: '/a' }, 0)).toBe(
      "patchOps[0]: 'op' is required and must be one of add, remove, replace, move, copy, test",
    );
    expect(validateJsonPatchOperation({ op: 'upsert', path: '/a', value: 1 }, 2)).toBe(
      "patchOps[2]: unknown op 'upsert' — RFC 6902 defines add, remove, replace, move, copy, test",
    );
  });

  it('requires a pointer-shaped path', () => {
    expect(validateJsonPatchOperation({ op: 'remove' }, 0)).toBe(
      "patchOps[0] remove: 'path' is required and must be a JSON Pointer string, e.g. /daily/time/0",
    );
    expect(validateJsonPatchOperation({ op: 'remove', path: 'daily/time/0' }, 1)).toBe(
      "patchOps[1] remove daily/time/0: a JSON Pointer must be empty (the whole document) or " +
        "start with '/', e.g. /daily/time/0",
    );
  });

  it('requires value exactly where the RFC does, and rejects it where it does not', () => {
    expect(validateJsonPatchOperation({ op: 'add', path: '/a' }, 0)).toBe(
      "patchOps[0] add /a: 'value' is required for op 'add'",
    );
    expect(validateJsonPatchOperation({ op: 'remove', path: '/a', value: 1 }, 0)).toBe(
      "patchOps[0] remove /a: 'value' is not allowed for op 'remove'",
    );
    // An explicit null value is a value: `replace /a value: null` is the way to null a key.
    expect(validateJsonPatchOperation({ op: 'replace', path: '/a', value: null }, 0)).toBeNull();
  });

  it('requires from exactly where the RFC does', () => {
    expect(validateJsonPatchOperation({ op: 'move', path: '/a' }, 0)).toBe(
      "patchOps[0] move /a: 'from' is required for op 'move' and must be a JSON Pointer string",
    );
    expect(validateJsonPatchOperation({ op: 'copy', path: '/a', from: 'b' }, 0)).toBe(
      "patchOps[0] copy /a: from b: a JSON Pointer must be empty (the whole document) or start " +
        "with '/', e.g. /daily/time/0",
    );
    expect(validateJsonPatchOperation({ op: 'add', path: '/a', value: 1, from: '/b' }, 0)).toBe(
      "patchOps[0] add /a: 'from' is not allowed for op 'add'",
    );
  });

  it('rejects unknown keys, listing what the op does take', () => {
    expect(validateJsonPatchOperation({ op: 'remove', path: '/a', reason: 'why' }, 3)).toBe(
      "patchOps[3] remove /a: unknown key 'reason' — op 'remove' takes op, path",
    );
  });

  it('reports every malformed entry in order', () => {
    expect(validateJsonPatch([{ op: 'add', path: '/a' }, { op: 'nope', path: '/b' }])).toEqual([
      "patchOps[0] add /a: 'value' is required for op 'add'",
      "patchOps[1]: unknown op 'nope' — RFC 6902 defines add, remove, replace, move, copy, test",
    ]);
  });
});
