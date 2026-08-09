import { describe, expect, it } from 'vitest';

import type { JsonValue } from '../types.js';
import { applyMergePatch, cloneJson, isJsonObject, jsonEquals } from './merge-patch.js';

describe('RFC 7386 merge patch', () => {
  // The test table from RFC 7386 Appendix A, verbatim. Implementing merge patch in-repo (§11) is
  // only defensible if it is the algorithm the RFC specifies, so the RFC's own cases are the test.
  const appendixA: Array<[JsonValue, JsonValue, JsonValue]> = [
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
    [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}],
    [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
    [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    [['a', 'b'], ['c', 'd'], ['c', 'd']],
    [{ a: 'b' }, ['c'], ['c']],
    [{ a: 'foo' }, null, null],
    [{ a: 'foo' }, 'bar', 'bar'],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ];

  it.each(appendixA)('%j patched with %j is %j', (target, patch, expected) => {
    expect(applyMergePatch(target, patch)).toEqual(expected);
  });

  it('treats an absent target exactly as null', () => {
    expect(applyMergePatch(undefined, { a: 'b' })).toEqual({ a: 'b' });
    expect(applyMergePatch(undefined, null)).toBeNull();
  });

  it('cannot set a key to null — which is why patchOps exists (§5)', () => {
    expect(applyMergePatch({ a: 1 }, { a: null })).toEqual({});
  });

  it('replaces arrays wholesale rather than merging them elementwise', () => {
    const target = { hourly: { temperature_2m: [17.4, 17.1, null, 16.6] } };
    expect(applyMergePatch(target, { hourly: { temperature_2m: [] } })).toEqual({
      hourly: { temperature_2m: [] },
    });
  });

  it('reaches into nested objects without disturbing their siblings', () => {
    const target = {
      current_weather: { temperature: 17.4, weathercode: 3, is_day: 1 },
      daily: { time: ['2026-08-10'] },
    };
    expect(applyMergePatch(target, { current_weather: { weathercode: 95 } })).toEqual({
      current_weather: { temperature: 17.4, weathercode: 95, is_day: 1 },
      daily: { time: ['2026-08-10'] },
    });
  });

  it('never mutates the recorded body it patches', () => {
    const target = { hourly: { temperature_2m: [1, 2] }, keep: true };
    const snapshot = structuredClone(target);
    const patched = applyMergePatch(target, { hourly: { temperature_2m: [] }, keep: null });
    expect(target).toEqual(snapshot);
    expect(patched).toEqual({ hourly: { temperature_2m: [] } });
  });

  it('does not alias arrays or objects from the patch into the result', () => {
    const patch = { hourly: { temperature_2m: [1] } };
    const patched = applyMergePatch({}, patch) as { hourly: { temperature_2m: number[] } };
    patched.hourly.temperature_2m.push(2);
    expect(patch.hourly.temperature_2m).toEqual([1]);
  });

  it('ignores inherited keys on the target', () => {
    const target = Object.create({ inherited: 'nope' }) as Record<string, JsonValue>;
    target.own = 'yes';
    expect(applyMergePatch(target as JsonValue, { extra: 1 })).toEqual({ own: 'yes', extra: 1 });
  });
});

describe('json helpers', () => {
  it('recognises plain objects only', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('x')).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });

  it('compares by RFC 6902 §4.6 equality: key order free, array order significant', () => {
    expect(jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
    expect(jsonEquals({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(jsonEquals({ a: 1 }, { a: 1, b: undefined as unknown as JsonValue })).toBe(false);
    expect(jsonEquals(null, null)).toBe(true);
    expect(jsonEquals(null, {})).toBe(false);
    expect(jsonEquals(0, false as unknown as JsonValue)).toBe(false);
    expect(jsonEquals(undefined, undefined)).toBe(true);
    expect(jsonEquals(undefined, null)).toBe(false);
  });

  it('clones without aliasing, and passes primitives straight through', () => {
    const value = { a: [1, { b: 2 }] };
    const copy = cloneJson(value);
    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
    expect(cloneJson('x')).toBe('x');
    expect(cloneJson(null)).toBeNull();
  });
});
