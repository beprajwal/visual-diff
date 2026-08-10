import { describe, expect, it } from 'vitest';

import {
  assignStepIds,
  flowNameFromTitle,
  parseTestTitle,
  SAFE_NAME_RE,
  slugify,
  stepIdFromTitle,
  TITLE_SEPARATOR,
  titleKeyOf,
} from './titles.js';

/** The exact shape `@playwright/test` writes: relative path, colon, line, then the title path. */
const RUNNER_TITLE = 'probe.spec.ts:20 › search suite › finds a result for a query';

describe('parseTestTitle', () => {
  it('splits a runner title on U+203A and lifts out the file and line', () => {
    expect(parseTestTitle(RUNNER_TITLE)).toEqual({
      file: 'probe.spec.ts',
      line: 20,
      path: ['search suite', 'finds a result for a query'],
    });
  });

  it('uses U+203A, not a greater-than sign', () => {
    expect(TITLE_SEPARATOR).toBe(' › ');
    // A title written with '>' is one segment: nothing about it looks like a runner title.
    expect(parseTestTitle('probe.spec.ts:20 > suite > test').path).toEqual([
      'probe.spec.ts:20 > suite > test',
    ]);
  });

  it('keeps nested describe blocks in order', () => {
    const parsed = parseTestTitle('a/b/spec.ts:7 › outer › inner › does the thing');
    expect(parsed.file).toBe('a/b/spec.ts');
    expect(parsed.path).toEqual(['outer', 'inner', 'does the thing']);
  });

  it('treats a library title as a single unstructured segment', () => {
    // There is no test concept in a library trace: the title is whatever the caller passed.
    expect(parseTestTitle('weather dashboard: first load')).toEqual({
      path: ['weather dashboard: first load'],
    });
    expect(parseTestTitle('checkout:12')).toEqual({ path: ['checkout:12'] });
  });

  it('drops empty segments and surrounding whitespace', () => {
    expect(parseTestTitle('  spec.ts:3 ›  › outer ›  test  ')).toEqual({
      file: 'spec.ts',
      line: 3,
      path: ['outer', 'test'],
    });
  });

  it('returns an empty path for an empty title', () => {
    expect(parseTestTitle('   ')).toEqual({ path: [] });
  });
});

describe('titleKeyOf', () => {
  it('strips the line number and keeps the file', () => {
    expect(titleKeyOf(RUNNER_TITLE)).toBe(
      'probe.spec.ts › search suite › finds a result for a query',
    );
  });

  it('is unchanged when an unrelated edit moves the test down the file', () => {
    // The D26 hazard: adding an import at the top renames every test in the file.
    const before = titleKeyOf('probe.spec.ts:20 › suite › a test');
    const after = titleKeyOf('probe.spec.ts:31 › suite › a test');
    expect(after).toBe(before);
  });

  it('keeps the file, so identically named tests in different files stay distinct', () => {
    expect(titleKeyOf('a.spec.ts:1 › suite › a test')).not.toBe(
      titleKeyOf('b.spec.ts:1 › suite › a test'),
    );
  });
});

describe('flowNameFromTitle', () => {
  it('derives a store-safe flow name from the line-stripped title', () => {
    const flow = flowNameFromTitle(RUNNER_TITLE);
    expect(flow).toBe('probe-spec-ts-search-suite-finds-a-result-for-a-query');
    expect(SAFE_NAME_RE.test(flow)).toBe(true);
  });

  it('does not move when the test moves within its file', () => {
    expect(flowNameFromTitle('probe.spec.ts:20 › suite › a test')).toBe(
      flowNameFromTitle('probe.spec.ts:405 › suite › a test'),
    );
  });

  it('truncates a very long title and disambiguates it with a digest', () => {
    const long = `spec.ts:1 › ${'a very long describe block name '.repeat(8)}› ends here`;
    const other = `spec.ts:1 › ${'a very long describe block name '.repeat(8)}› ends elsewhere`;
    const flow = flowNameFromTitle(long);
    expect(flow.length).toBeLessThanOrEqual(100);
    expect(SAFE_NAME_RE.test(flow)).toBe(true);
    // The two titles agree for far more than 100 characters and must still land in different flows.
    expect(flow).not.toBe(flowNameFromTitle(other));
  });

  it('falls back when a title slugs to nothing', () => {
    expect(flowNameFromTitle('…', 'e2e')).toBe('e2e');
  });
});

describe('slugify', () => {
  it('produces names the store will accept as path components', () => {
    for (const input of ['Click "Fetch"', 'run — the search', '  spaced  out  ', 'ünïcode']) {
      expect(SAFE_NAME_RE.test(slugify(input))).toBe(true);
    }
  });

  it('collapses runs of punctuation into a single dash and trims the ends', () => {
    expect(slugify('Click getByRole(\'button\', { name: \'Fetch\' })')).toBe(
      'click-getbyrole-button-name-fetch',
    );
  });

  it('uses the fallback when nothing survives', () => {
    expect(slugify('🙂', 'step')).toBe('step');
    expect(stepIdFromTitle('---')).toBe('step');
  });
});

describe('assignStepIds', () => {
  const key = (title: string): { title: string; key: string } => ({ title, key: title });

  it('gives a stable numeric suffix to duplicate titles, in document order', () => {
    // Two `test.step('run the search')` blocks in one test are indistinguishable except by ordinal.
    const assigned = assignStepIds([
      key('open the dashboard'),
      key('run the search'),
      key('inspect results'),
      key('run the search'),
    ]);
    expect(assigned.ids).toEqual([
      'open-the-dashboard',
      'run-the-search',
      'inspect-results',
      'run-the-search-2',
    ]);
    expect(assigned.duplicates).toEqual(['run the search']);
  });

  it('reports a repeated title once however many times it recurs', () => {
    const assigned = assignStepIds([key('step'), key('step'), key('step')]);
    expect(assigned.ids).toEqual(['step', 'step-2', 'step-3']);
    expect(assigned.duplicates).toEqual(['step']);
  });

  it('does not renumber a repeat when an unrelated step is inserted before it', () => {
    const without = assignStepIds([key('a'), key('a')]).ids;
    const with_ = assignStepIds([key('a'), key('b'), key('a')]).ids;
    expect(without[1]).toBe('a-2');
    expect(with_[2]).toBe('a-2');
  });

  it('lets an override pin a title to an id', () => {
    const assigned = assignStepIds([key('run the search'), key('open the dashboard')], {
      'run the search': 'search',
    });
    expect(assigned.ids).toEqual(['search', 'open-the-dashboard']);
    expect(assigned.overridden).toEqual(['run the search']);
  });

  it('breaks a collision between two titles that slug the same way', () => {
    const assigned = assignStepIds([key('run the search'), key('Run The Search!')]);
    expect(assigned.ids).toEqual(['run-the-search', 'run-the-search-2']);
  });

  it('breaks a collision between an override and a derived id', () => {
    const assigned = assignStepIds([key('open the dashboard'), key('second')], {
      second: 'open-the-dashboard',
    });
    expect(assigned.ids).toEqual(['open-the-dashboard', 'open-the-dashboard-2']);
  });

  it('always produces ids the store will accept', () => {
    const assigned = assignStepIds([key('🙂'), key('🙂'), key('  ')], { '  ': '"quoted"' });
    for (const id of assigned.ids) expect(SAFE_NAME_RE.test(id)).toBe(true);
  });
});
