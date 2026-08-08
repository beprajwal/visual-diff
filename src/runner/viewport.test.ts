import { describe, expect, it } from 'vitest';

import { formatViewport, normalizeViewports, parseViewport, runPool, tryParseViewport } from './viewport.js';

describe('viewport parsing', () => {
  it('parses WIDTHxHEIGHT and round-trips through format', () => {
    const viewport = parseViewport('1280x800');
    expect(viewport).toEqual({ id: '1280x800', width: 1280, height: 800 });
    expect(formatViewport(viewport.width, viewport.height)).toBe('1280x800');
  });

  it('trims surrounding whitespace', () => {
    expect(parseViewport('  390x844 ').id).toBe('390x844');
  });

  it('rejects malformed ids', () => {
    for (const bad of ['1280', '1280*800', 'x800', '1280x', '0x800', '1280x0', '12.5x800', '1280X800', '']) {
      expect(tryParseViewport(bad)).toBeNull();
    }
    expect(() => parseViewport('nope')).toThrowError(/invalid viewport/);
  });

  it('de-duplicates while preserving order', () => {
    expect(normalizeViewports(['1280x800', '390x844', '1280x800']).map((v) => v.id)).toEqual([
      '1280x800',
      '390x844',
    ]);
  });

  it('refuses an empty viewport list', () => {
    expect(() => normalizeViewports([])).toThrowError(/no viewports/);
  });
});

describe('runPool', () => {
  it('respects the concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7];
    const results = await runPool(items, 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return n * 2;
    });
    expect(peak).toBe(2);
    expect(results.map((r) => (r.ok ? r.value : null))).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });

  it('isolates failures and keeps input order', async () => {
    const results = await runPool(['a', 'boom', 'c'], 3, async (value) => {
      if (value === 'boom') throw new Error('viewport failed');
      return value.toUpperCase();
    });
    expect(results[0]).toEqual({ ok: true, value: 'A' });
    expect(results[1]?.ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: 'C' });
    const failure = results[1];
    expect(failure && !failure.ok ? (failure.error as Error).message : '').toBe('viewport failed');
  });

  it('handles an empty item list without spinning a worker', async () => {
    let calls = 0;
    const results = await runPool([], 4, async () => {
      calls += 1;
      return null;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});
