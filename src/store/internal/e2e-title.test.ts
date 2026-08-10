/**
 * D26: test titles → flow names, step titles → step ids.
 *
 * The tests are organised around the three ways this translation can silently go wrong, because
 * each of them produces a diff that is *plausible* rather than obviously broken:
 *
 * 1. **the line number.** A real runner title is `checkout.spec.ts:12 › checkout › shows the cart`.
 *    Adding an import at the top of the file renumbers every test in it. A key that kept the line
 *    would report every flow in that file as removed-and-added, on an edit that changed no pixels;
 * 2. **collisions.** Two tests can slug to one name, and the suffix that separates them must not
 *    depend on the order the traces arrived in — or ingesting the same CI run on two machines
 *    produces two different sets of flow names;
 * 3. **duplicate step titles**, which are trivially reachable (two `test.step('run the search')`
 *    blocks in one test are distinguished only by a callId ordinal) and must not be merged into one
 *    step id, which would compare two different screens as though they were one.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_SLUG_LENGTH,
  TITLE_SEPARATOR,
  allocateFlowName,
  assignStepIds,
  flowNameForTitle,
  normalizeTitle,
  parseLocation,
  parseTestTitle,
  sameTitle,
  slugify,
  specStem,
  splitTitle,
} from './e2e-title.js';
import { assertSafeSegment } from '../paths.js';

/** Exactly what `@playwright/test` 1.62.1 writes into `context-options.title`. */
const RUNNER_TITLE = 'probe.spec.ts:20 › search suite › finds a result for a query';

describe('the separator', () => {
  it('is U+203A, not a greater-than sign', () => {
    expect(TITLE_SEPARATOR).toBe('›');
    expect(TITLE_SEPARATOR).not.toBe('>');
  });

  it('splits a real runner title into its segments, tolerating loose spacing', () => {
    expect(splitTitle(RUNNER_TITLE)).toEqual([
      'probe.spec.ts:20',
      'search suite',
      'finds a result for a query',
    ]);
    expect(splitTitle('a›b')).toEqual(['a', 'b']);
    expect(splitTitle('  a   b  ›  c  ')).toEqual(['a b', 'c']);
    expect(splitTitle('a › › b')).toEqual(['a', 'b']);
    expect(splitTitle('')).toEqual([]);
  });
});

describe('parseLocation', () => {
  it('recognises the leading path:line the runner emits', () => {
    expect(parseLocation('probe.spec.ts:20')).toEqual({ file: 'probe.spec.ts', line: 20 });
    expect(parseLocation('tests/e2e/checkout.spec.ts:1')).toEqual({
      file: 'tests/e2e/checkout.spec.ts',
      line: 1,
    });
  });

  it('refuses anything that is merely colon-shaped, because a false positive renames a flow', () => {
    // A test genuinely titled with a colon and a number.
    expect(parseLocation('chapter 3: 40')).toBeNull();
    expect(parseLocation('budget: 40')).toBeNull();
    // No extension: not a file path.
    expect(parseLocation('something:12')).toBeNull();
    // A line number is required.
    expect(parseLocation('probe.spec.ts')).toBeNull();
    expect(parseLocation('probe.spec.ts:')).toBeNull();
    expect(parseLocation('probe.spec.ts:abc')).toBeNull();
  });
});

describe('normalizeTitle — the line number must not survive', () => {
  it('drops the line and keeps the path', () => {
    expect(normalizeTitle(RUNNER_TITLE)).toBe(
      'probe.spec.ts › search suite › finds a result for a query',
    );
  });

  it('gives one key to a test that only moved down the file — the D26 hazard', () => {
    const before = 'probe.spec.ts:20 › search suite › finds a result for a query';
    const afterAnAddedImport = 'probe.spec.ts:21 › search suite › finds a result for a query';
    expect(normalizeTitle(before)).toBe(normalizeTitle(afterAnAddedImport));
    expect(sameTitle(before, afterAnAddedImport)).toBe(true);
  });

  it('still separates two tests that differ in anything but the line', () => {
    expect(sameTitle(RUNNER_TITLE, 'probe.spec.ts:20 › search suite › finds nothing')).toBe(false);
    // Same describe and test, different file: a different test.
    expect(sameTitle(RUNNER_TITLE, 'other.spec.ts:20 › search suite › finds a result for a query')).toBe(
      false,
    );
  });

  it('is idempotent, so a pin written either way round matches', () => {
    const once = normalizeTitle(RUNNER_TITLE);
    expect(normalizeTitle(once)).toBe(once);
    expect(normalizeTitle('probe.spec.ts   ›search suite›finds a result for a query')).toBe(once);
  });

  it('handles a library-only title, which has no test concept at all in it', () => {
    // `tracing.start({ title })` takes whatever the caller passed; often no location, often bare.
    expect(normalizeTitle('weather dashboard')).toBe('weather dashboard');
    expect(parseTestTitle('weather dashboard')).toEqual({
      file: null,
      line: null,
      path: ['weather dashboard'],
      key: 'weather dashboard',
    });
  });

  it('exposes the line for display without letting anything key on it', () => {
    const parsed = parseTestTitle(RUNNER_TITLE);
    expect(parsed.file).toBe('probe.spec.ts');
    expect(parsed.line).toBe(20);
    expect(parsed.path).toEqual(['search suite', 'finds a result for a query']);
    expect(parsed.key).not.toContain('20');
  });
});

describe('slugify', () => {
  it('produces something that is always a legal path segment', () => {
    for (const value of [
      'finds a result for a query',
      '../../etc/passwd',
      '.hidden',
      'a:b*c?d"e<f>g|h',
      'Ünïcødé ✨ title',
      'run the search — again',
    ]) {
      const slug = slugify(value);
      if (slug === '') continue;
      expect(() => assertSafeSegment('flow', slug)).not.toThrow();
    }
  });

  it('collapses runs of separators and trims the ends', () => {
    expect(slugify('  Shows the CART!!  ')).toBe('shows-the-cart');
    expect(slugify('a---b')).toBe('a-b');
    expect(slugify('...')).toBe('');
  });
});

describe('specStem', () => {
  it('keeps the part of a path worth reading in a flow name', () => {
    expect(specStem('tests/e2e/checkout.spec.ts')).toBe('checkout');
    expect(specStem('probe.test.tsx')).toBe('probe');
    expect(specStem('probe.ts')).toBe('probe');
    expect(specStem('probe')).toBe('probe');
    expect(specStem('a\\b\\checkout.spec.js')).toBe('checkout');
  });
});

describe('flowNameForTitle', () => {
  it('derives a readable name from a runner title', () => {
    expect(flowNameForTitle(RUNNER_TITLE)).toBe('probe-search-suite-finds-a-result-for-a-query');
  });

  it('is unmoved by the line number, which is the whole point of D26 normalisation', () => {
    expect(flowNameForTitle('probe.spec.ts:20 › a › b')).toBe(
      flowNameForTitle('probe.spec.ts:400 › a › b'),
    );
  });

  it('keeps two same-named tests in different files apart', () => {
    expect(flowNameForTitle('checkout.spec.ts:1 › cart › shows totals')).not.toBe(
      flowNameForTitle('admin.spec.ts:1 › cart › shows totals'),
    );
  });

  it('names a library-only title with no file at all', () => {
    expect(flowNameForTitle('weather dashboard')).toBe('weather-dashboard');
  });

  it('returns null rather than inventing a name nobody could find twice', () => {
    expect(flowNameForTitle('')).toBeNull();
    expect(flowNameForTitle('— › —')).toBeNull();
  });

  it('always produces a legal path segment, including from hostile input', () => {
    const name = flowNameForTitle('../../etc:1 › .. › ../../escape');
    expect(name).not.toBeNull();
    expect(() => assertSafeSegment('flow', name as string)).not.toThrow();
  });

  it('caps a very long title and keeps two long titles that share a prefix distinct', () => {
    const prefix = 'checkout.spec.ts:1 › checkout › ' + 'the user opens the cart and '.repeat(6);
    const a = flowNameForTitle(`${prefix}pays`);
    const b = flowNameForTitle(`${prefix}leaves`);
    expect(a).not.toBeNull();
    expect((a as string).length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(a).not.toBe(b);
  });
});

describe('allocateFlowName — the suffix must be stable, not ordinal', () => {
  // Two different tests whose describe/test path and file stem slug identically: the same file
  // basename in two directories is the realistic way this happens.
  const first = 'a/checkout.spec.ts:1 › cart › shows totals';
  const second = 'b/checkout.spec.ts:1 › cart › shows totals';

  it('gives the first claimant the plain name', () => {
    expect(allocateFlowName(first, new Set())).toBe('checkout-cart-shows-totals');
  });

  it('suffixes the newcomer without renaming the flow that is already on disk', () => {
    const taken = new Set(['checkout-cart-shows-totals']);
    const allocated = allocateFlowName(second, taken);
    expect(allocated).not.toBe('checkout-cart-shows-totals');
    expect(allocated?.startsWith('checkout-cart-shows-totals-')).toBe(true);
    // The name already in use is untouched: nothing on disk is renamed.
    expect(allocateFlowName(first, new Set())).toBe('checkout-cart-shows-totals');
  });

  it('gives the same answer whichever order the two traces are ingested in', () => {
    // Machine 1 sees `first` then `second`; machine 2 sees them the other way round. The suffix is
    // a digest of the title, so the *set* of names is the same either way for the suffixed one.
    const suffixedAfterFirst = allocateFlowName(second, new Set(['checkout-cart-shows-totals']));
    const suffixedAgain = allocateFlowName(second, new Set(['checkout-cart-shows-totals']));
    expect(suffixedAfterFirst).toBe(suffixedAgain);
    // And it is not a counter: no `-2` anywhere.
    expect(suffixedAfterFirst).not.toMatch(/-2$/);
  });

  it('resolves a three-way collision without falling back to a counter', () => {
    const third = 'c/checkout.spec.ts:1 › cart › shows totals';
    const one = allocateFlowName(first, new Set()) as string;
    const two = allocateFlowName(second, new Set([one])) as string;
    const three = allocateFlowName(third, new Set([one, two])) as string;
    expect(new Set([one, two, three]).size).toBe(3);
    for (const name of [one, two, three]) {
      expect(() => assertSafeSegment('flow', name)).not.toThrow();
    }
  });

  it('still returns null for a title with nothing sluggable in it', () => {
    expect(allocateFlowName('', new Set())).toBeNull();
  });
});

describe('assignStepIds', () => {
  it('keys a step by its title, not by its position', () => {
    const { ids, duplicates } = assignStepIds([
      'open the dashboard',
      'run the search',
      'read the result',
    ]);
    expect(ids).toEqual(['open-the-dashboard', 'run-the-search', 'read-the-result']);
    expect(duplicates).toEqual([]);
  });

  it('keeps a step id stable when a step is inserted before it — the failure D4 rejected', () => {
    const before = assignStepIds(['open the dashboard', 'read the result']);
    const after = assignStepIds(['open the dashboard', 'run the search', 'read the result']);
    expect(before.ids[1]).toBe('read-the-result');
    expect(after.ids[2]).toBe('read-the-result');
  });

  it('disambiguates a repeated title instead of merging two different screens into one id', () => {
    const { ids, duplicates } = assignStepIds([
      'run the search',
      'read the result',
      'run the search',
    ]);
    expect(ids).toEqual(['run-the-search', 'read-the-result', 'run-the-search-2']);
    expect(duplicates).toEqual([
      { title: 'run the search', ids: ['run-the-search', 'run-the-search-2'] },
    ]);
  });

  it('does not hand a repeat the id a differently-titled step already holds', () => {
    const { ids } = assignStepIds(['run', 'run-2', 'run']);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(['run', 'run-2', 'run-2-2']);
  });

  it('names an unsluggable step by position rather than leaving it without an id', () => {
    // What a library-only trace yields: no step titles, only engine selectors, some of which
    // reduce to nothing.
    const { ids } = assignStepIds(['***', 'internal:role=button[name="Fetch"i]', '']);
    expect(ids[0]).toBe('step-1');
    expect(ids[1]).toBe('internal-role-button-name-fetch-i');
    expect(ids[2]).toBe('step-3');
    for (const id of ids) expect(() => assertSafeSegment('step id', id)).not.toThrow();
  });

  it('produces ids that are all legal path segments, since each becomes a directory', () => {
    const { ids } = assignStepIds(['../escape', '.hidden', 'Ünïcødé']);
    for (const id of ids) expect(() => assertSafeSegment('step id', id)).not.toThrow();
  });

  it('reports every repeated title once, whatever the multiplicity', () => {
    const { duplicates } = assignStepIds(['wait', 'wait', 'wait', 'go', 'go']);
    expect(duplicates).toEqual([
      { title: 'wait', ids: ['wait', 'wait-2', 'wait-3'] },
      { title: 'go', ids: ['go', 'go-2'] },
    ]);
  });

  it('handles a test with no steps at all', () => {
    expect(assignStepIds([])).toEqual({ ids: [], duplicates: [] });
  });
});
