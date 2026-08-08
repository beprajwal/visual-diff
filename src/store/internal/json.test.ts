import { describe, expect, it } from 'vitest';

import { hashJsonStable, sha256 } from './hash.js';
import { stableStringify, stableStringifyLine } from './json.js';

describe('stableStringify', () => {
  it('sorts keys at every depth so output is byte-stable', () => {
    const a = { b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } };
    const b = { a: { c: [{ e: 4, f: 3 }], d: 2 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a, 0)).toBe('{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(stableStringify([3, 1, 2], 0)).toBe('[3,1,2]');
  });

  it('drops undefined rather than emitting null, because the contracts distinguish them', () => {
    expect(stableStringify({ a: undefined, b: null }, 0)).toBe('{"b":null}');
  });

  it('writes one line with no indent for JSONL sinks', () => {
    const line = stableStringifyLine({ b: 1, a: 'x' });
    expect(line).toBe('{"a":"x","b":1}');
    expect(line).not.toContain('\n');
  });
});

describe('hashing', () => {
  it('emits the documented sha256:<hex> form', () => {
    expect(sha256('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is independent of key order', () => {
    expect(hashJsonStable({ a: 1, b: 2 })).toBe(hashJsonStable({ b: 2, a: 1 }));
  });

  it('changes when a value changes', () => {
    expect(hashJsonStable({ a: 1 })).not.toBe(hashJsonStable({ a: 2 }));
  });
});
