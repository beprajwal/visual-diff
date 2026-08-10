/**
 * The source axis (e2e spec §4, §7, §8, D27).
 *
 * Every sentence this module produces is asserted verbatim rather than merely checked for being
 * non-null. They are the user interface of the feature: a reader looking at an e2e diff has to be
 * told *why* there are no property-level findings, and "some explanation was rendered" is not a test
 * of whether the explanation is the right one.
 */

import { describe, expect, it } from 'vitest';

import type { Revision } from '../types.js';

import {
  classifySourcePair,
  describeDegradedDiff,
  describeE2eOrigin,
  describeE2eRevision,
  describeSourcePair,
  e2eOriginOf,
  isE2eRun,
  isE2eWarningKind,
  isHighSeverityE2eWarningKind,
  isRunSource,
  showSource,
  sourceOf,
  E2E_DEGRADED_SENTENCES,
  E2E_MISSING_LAYERS,
  E2E_WARNING_KINDS,
  RUN_SOURCES,
  SOURCE_E2E,
  SOURCE_REPLAY,
} from './e2e.js';

const revision = (overrides: Partial<Revision> = {}): Revision => ({
  sha: '9f8e7d6c5b4a',
  ref: 'main',
  dirty: false,
  ...overrides,
});

describe('sourceOf', () => {
  it('reads a run written before this slice as a replay, because that is what it was', () => {
    expect(sourceOf({ runId: '0007' })).toBe(SOURCE_REPLAY);
    expect(sourceOf({})).toBe(SOURCE_REPLAY);
  });

  it('reads an ingested run as e2e', () => {
    expect(sourceOf({ source: 'e2e' })).toBe(SOURCE_E2E);
    expect(isE2eRun({ source: 'e2e' })).toBe(true);
    expect(isE2eRun({ source: 'replay' })).toBe(false);
  });

  it('survives null, undefined and a value it does not recognise', () => {
    expect(sourceOf(null)).toBe(SOURCE_REPLAY);
    expect(sourceOf(undefined)).toBe(SOURCE_REPLAY);
    // A run written by a newer build is still a run. Describing it conservatively beats refusing to
    // list it, which is what throwing here would amount to.
    expect(sourceOf({ source: 'cypress' })).toBe(SOURCE_REPLAY);
    expect(sourceOf({ source: 7 })).toBe(SOURCE_REPLAY);
  });

  it('names both sources, replay first', () => {
    expect(RUN_SOURCES).toEqual(['replay', 'e2e']);
    expect(isRunSource('replay')).toBe(true);
    expect(isRunSource('e2e')).toBe(true);
    expect(isRunSource('trace')).toBe(false);
    expect(showSource(SOURCE_E2E)).toBe('e2e');
    expect(showSource(SOURCE_REPLAY)).toBe('replay');
  });
});

describe('e2eOriginOf', () => {
  it('returns null for a replay run, so a caller gets "nothing to say" rather than empty fields', () => {
    expect(e2eOriginOf({ runId: '0007' })).toBeNull();
    expect(e2eOriginOf({ e2e: null })).toBeNull();
    expect(e2eOriginOf({ e2e: 'yes' })).toBeNull();
    expect(e2eOriginOf(null)).toBeNull();
  });

  it('keeps only the fields that are actually there', () => {
    expect(
      e2eOriginOf({
        e2e: {
          traceHash: 'sha256:abc',
          title: 'weather.spec.ts:12 › weather › shows the forecast',
          browser: 'chromium',
          traceVersion: 8,
          project: '   ',
          retry: Number.NaN,
        },
      }),
    ).toEqual({
      traceHash: 'sha256:abc',
      title: 'weather.spec.ts:12 › weather › shows the forecast',
      browser: 'chromium',
      traceVersion: 8,
    });
  });

  it('returns null when the block holds nothing usable', () => {
    expect(e2eOriginOf({ e2e: { title: '', retry: 'two' } })).toBeNull();
  });
});

describe('describeE2eOrigin', () => {
  it('names every field that is present, in a fixed order', () => {
    expect(
      describeE2eOrigin({
        title: 'weather.spec.ts:12 › weather › shows the forecast',
        browser: 'chromium',
        channel: 'chrome',
        project: 'desktop',
        retry: 2,
        playwrightVersion: '1.62.1',
        traceVersion: 8,
      }),
    ).toBe(
      'test weather.spec.ts:12 › weather › shows the forecast · chromium (chrome) ·' +
        ' project desktop · retry 2 · Playwright 1.62.1 · trace v8',
    );
  });

  it('says only what it knows — a library-only trace carries no test title, and that is ordinary', () => {
    expect(describeE2eOrigin({ browser: 'chromium', traceVersion: 8 })).toBe('chromium · trace v8');
  });

  it('is null when there is nothing to say', () => {
    expect(describeE2eOrigin(null)).toBeNull();
    expect(describeE2eOrigin({ traceHash: 'sha256:abc' })).toBeNull();
  });
});

describe('describeE2eRevision', () => {
  it('explains an unknown revision rather than leaving it blank (§7, §8)', () => {
    expect(describeE2eRevision(revision({ sha: '' }))).toBe(
      'revision unknown: a Playwright trace records no git metadata, so this run is not attributed' +
        ' to a commit rather than being attributed to the wrong one',
    );
    expect(describeE2eRevision(null)).not.toBeNull();
  });

  it('says nothing when the revision is known', () => {
    expect(describeE2eRevision(revision())).toBeNull();
  });
});

describe('classifySourcePair', () => {
  it('carries no label for two replays — every pair slice 1 could produce', () => {
    expect(classifySourcePair({}, {})).toEqual({
      base: 'replay',
      head: 'replay',
      label: null,
      degraded: false,
    });
    expect(describeSourcePair(classifySourcePair({}, {}))).toBeNull();
  });

  it('labels two ingested runs as an e2e pair — degraded, but not confounded', () => {
    const pair = classifySourcePair({ source: 'e2e' }, { source: 'e2e' });
    expect(pair).toEqual({ base: 'e2e', head: 'e2e', label: 'e2e-pair', degraded: true });
  });

  it('labels a mixed pair as e2e-vs-replay, whichever side was ingested', () => {
    expect(classifySourcePair({ source: 'e2e' }, {}).label).toBe('e2e-vs-replay');
    expect(classifySourcePair({}, { source: 'e2e' }).label).toBe('e2e-vs-replay');
    expect(classifySourcePair({}, { source: 'e2e' }).degraded).toBe(true);
  });
});

describe('describeSourcePair', () => {
  it('names which side was ingested, so the sentence is actionable', () => {
    expect(describeSourcePair(classifySourcePair({ source: 'e2e' }, {}))).toBe(
      "e2e-vs-replay: base was ingested from a test suite's trace and head was replayed by this" +
        ' tool — the two were captured by different machinery, so most findings below describe the' +
        ' capture, not the application',
    );
    expect(describeSourcePair(classifySourcePair({}, { source: 'e2e' }))).toBe(
      "e2e-vs-replay: head was ingested from a test suite's trace and base was replayed by this" +
        ' tool — the two were captured by different machinery, so most findings below describe the' +
        ' capture, not the application',
    );
  });

  it('states the reduced detail for an e2e pair instead of warning about it', () => {
    expect(describeSourcePair(classifySourcePair({ source: 'e2e' }, { source: 'e2e' }))).toBe(
      'e2e pair: e2e diff, reduced detail — no property-level findings: a Playwright trace records' +
        ' DOM structure but no computed styles, so this diff says which region changed and which' +
        ' element is responsible, and never "padding 8px → 12px"',
    );
  });
});

describe('the degraded-diff explanation (§4)', () => {
  it('states all three things a reader would otherwise read as a defect', () => {
    expect(E2E_DEGRADED_SENTENCES).toHaveLength(3);
    expect(E2E_DEGRADED_SENTENCES[0]).toContain('no property-level findings');
    // Several steps legitimately resolve to the same screencast frame; presenting that as a fault
    // would be the report inventing a problem that is not there.
    expect(E2E_DEGRADED_SENTENCES[1]).toContain('steps may share one screenshot');
    expect(E2E_DEGRADED_SENTENCES[2]).toContain('viewport-only and lossy');
  });

  it('names the two layers a trace does not carry', () => {
    expect(E2E_MISSING_LAYERS).toEqual(['computed-style subset', 'accessibility tree']);
  });

  it('summarises to one line for output with room for one', () => {
    expect(describeDegradedDiff()).toBe(`e2e diff, reduced detail — ${E2E_DEGRADED_SENTENCES[0]}`);
  });
});

describe('run warnings (§8)', () => {
  it('recognises the kinds ingestion raises', () => {
    expect(E2E_WARNING_KINDS).toEqual([
      'e2e-map-unmatched',
      'e2e-step-title-duplicate',
      'e2e-revision-unknown',
    ]);
    for (const kind of E2E_WARNING_KINDS) expect(isE2eWarningKind(kind)).toBe(true);
    expect(isE2eWarningKind('har-miss')).toBe(false);
  });

  it('promotes only the stale map entry, because only it means the diff aligns on the wrong step', () => {
    expect(isHighSeverityE2eWarningKind('e2e-map-unmatched')).toBe(true);
    expect(isHighSeverityE2eWarningKind('e2e-step-title-duplicate')).toBe(false);
    expect(isHighSeverityE2eWarningKind('e2e-revision-unknown')).toBe(false);
  });
});
