/**
 * The source axis of run identity (e2e spec §7, D27).
 *
 * Three properties are under test, and the last two are what make the feature safe to turn on:
 *
 * 1. a run captured before e2e mode existed is not "unknown", it is `replay` — the `scenarioOf` and
 *    `variantOf` contract, one axis over;
 * 2. **an inconsistent run never reaches disk.** Every branch of `assertRunSourceConsistent` is a
 *    wiring bug whose symptom appears far from its cause: an e2e run with no trace hash re-ingests
 *    on every CI run, and an e2e run carrying a variant lands in the wrong retention bucket;
 * 3. **`revision: unknown` is not a revision.** Ingested runs all share that sha, so anything that
 *    treats two of them as "the same code" would pair unrelated runs — which is the silent
 *    misattribution §7 exists to prevent.
 */

import { describe, expect, it } from 'vitest';

import { StoreError } from '../errors.js';
import {
  DEFAULT_KEEP_E2E_RUNS,
  E2E_DUPLICATE_STEP_TITLES,
  E2E_MAP_UNMATCHED,
  REVISION_UNKNOWN_SHA,
  SOURCE_E2E,
  SOURCE_REPLAY,
  UNKNOWN_REVISION,
  assertRunSourceConsistent,
  describeSource,
  duplicateStepTitlesWarning,
  e2eInfoOf,
  isE2eRun,
  isUnknownRevision,
  keepE2eRunsOf,
  normalizeE2eMeta,
  parseRunSource,
  sameSource,
  sourceOf,
  traceHashOf,
  unmatchedMapWarning,
} from './e2e.js';
import type { E2eRunInfo, MaybeE2e } from './e2e.js';
import type { RunMeta } from '../../types.js';

const META: RunMeta = {
  runId: '0007',
  flow: 'forecast',
  scenario: 'none',
  flowHash: 'sha256:abc',
  revision: { sha: '9f8e7d6', ref: 'main', dirty: false },
  mode: 'attach',
  network: 'replay',
  harHits: 3,
  harMisses: 0,
  viewports: ['1280x800'],
  status: 'ok',
  failedSteps: [],
  env: {
    tool: '0.1.0',
    node: 'v20.0.0',
    playwright: '1.62.1',
    chromium: '151',
    os: 'darwin-arm64',
    deviceScaleFactor: 2,
  },
  startedAt: '2026-08-10T10:00:00.000Z',
  finishedAt: '2026-08-10T10:00:10.000Z',
  unstable: false,
  pinned: false,
  pruned: false,
  warnings: [],
};

const INFO: E2eRunInfo = {
  traceHash: 'sha256:1111',
  testTitle: 'checkout.spec.ts:12 › checkout › shows the cart',
  titleKey: 'checkout.spec.ts › checkout › shows the cart',
};

function meta(overrides: MaybeE2e = {}): RunMeta {
  return { ...META, ...overrides } as RunMeta;
}

describe('sourceOf', () => {
  it('reads a run captured before e2e mode existed as a replay, not as unknown', () => {
    expect(sourceOf(META)).toBe(SOURCE_REPLAY);
    expect(sourceOf(null)).toBe(SOURCE_REPLAY);
    expect(sourceOf(undefined)).toBe(SOURCE_REPLAY);
  });

  it('reads an ingested run', () => {
    expect(sourceOf({ source: SOURCE_E2E })).toBe(SOURCE_E2E);
    expect(isE2eRun({ source: SOURCE_E2E })).toBe(true);
    expect(isE2eRun(META)).toBe(false);
  });

  it('treats a blank, misspelt or non-string source as replay rather than as a third state', () => {
    expect(sourceOf({ source: '  ' } as unknown as MaybeE2e)).toBe(SOURCE_REPLAY);
    expect(sourceOf({ source: 'E2E ' } as unknown as MaybeE2e)).toBe(SOURCE_E2E);
    expect(sourceOf({ source: 'trace' } as unknown as MaybeE2e)).toBe(SOURCE_REPLAY);
    expect(sourceOf({ source: 7 } as unknown as MaybeE2e)).toBe(SOURCE_REPLAY);
  });

  it('parses a --source argument the same way, and refuses a name it does not know', () => {
    expect(parseRunSource('e2e')).toBe(SOURCE_E2E);
    expect(parseRunSource(' Replay ')).toBe(SOURCE_REPLAY);
    expect(parseRunSource('playwright')).toBeNull();
    expect(parseRunSource(undefined)).toBeNull();
  });

  it('separates the two timelines', () => {
    expect(sameSource(META, { ...META })).toBe(true);
    expect(sameSource(META, { source: SOURCE_E2E })).toBe(false);
  });
});

describe('normalizeE2eMeta', () => {
  it('materialises the field on a run written before it existed', () => {
    expect((normalizeE2eMeta(META) as MaybeE2e).source).toBe(SOURCE_REPLAY);
  });

  it('returns the same object when nothing needs changing, so reads stay cheap', () => {
    const already = meta({ source: SOURCE_REPLAY });
    expect(normalizeE2eMeta(already)).toBe(already);
  });
});

describe('the e2e block', () => {
  it('is readable only on a run that claims to be e2e', () => {
    const ingested = meta({ source: SOURCE_E2E, e2e: INFO });
    expect(e2eInfoOf(ingested)).toEqual(INFO);
    expect(traceHashOf(ingested)).toBe('sha256:1111');
    // A replay run carrying a stray block is not silently promoted into an ingest.
    expect(e2eInfoOf(meta({ e2e: INFO }))).toBeNull();
    expect(traceHashOf(META)).toBeNull();
  });
});

describe('assertRunSourceConsistent', () => {
  it('accepts an ordinary replay run and a well-formed ingest', () => {
    expect(() => assertRunSourceConsistent('forecast', META)).not.toThrow();
    expect(() =>
      assertRunSourceConsistent('forecast', { source: SOURCE_E2E, e2e: INFO }),
    ).not.toThrow();
  });

  it('refuses an e2e run with no e2e block, naming what the block is for', () => {
    expect(() => assertRunSourceConsistent('forecast', { source: SOURCE_E2E })).toThrow(
      'run of flow "forecast" is marked source "e2e" but carries no e2e block; ' +
        'the trace hash and test title are what make ingestion idempotent',
    );
  });

  it('refuses a replay run carrying e2e metadata', () => {
    expect(() => assertRunSourceConsistent('forecast', { e2e: INFO })).toThrow(
      'run of flow "forecast" carries e2e metadata but source "replay"; ' +
        'an ingested run must record source "e2e"',
    );
  });

  it('refuses an ingest with no trace hash, because that is the idempotency key', () => {
    expect(() =>
      assertRunSourceConsistent('forecast', {
        source: SOURCE_E2E,
        e2e: { ...INFO, traceHash: '  ' },
      }),
    ).toThrow(
      'e2e run of flow "forecast" records no traceHash; without it the same archive ingests twice',
    );
  });

  it('refuses an ingest with no test title, and one with no title key', () => {
    expect(() =>
      assertRunSourceConsistent('forecast', { source: SOURCE_E2E, e2e: { ...INFO, testTitle: '' } }),
    ).toThrow(
      'e2e run of flow "forecast" records no testTitle; it is what the flow and its step ids were derived from',
    );
    expect(() =>
      assertRunSourceConsistent('forecast', { source: SOURCE_E2E, e2e: { ...INFO, titleKey: '' } }),
    ).toThrow(
      'e2e run of flow "forecast" records no titleKey; it is what a later ingest matches this run by',
    );
  });

  it('refuses a varied or scenario-bearing ingest — §2 puts both out of scope', () => {
    expect(() =>
      assertRunSourceConsistent('forecast', {
        source: SOURCE_E2E,
        e2e: INFO,
        variant: 'denser-forecast',
      }),
    ).toThrow(
      'e2e run of flow "forecast" was given variant "denser-forecast"; ' +
        'variants operate during capture, and an e2e trace was captured elsewhere',
    );
    expect(() =>
      assertRunSourceConsistent('forecast', {
        source: SOURCE_E2E,
        e2e: INFO,
        scenario: 'empty-forecast',
      }),
    ).toThrow(
      'e2e run of flow "forecast" was given scenario "empty-forecast"; ' +
        'scenarios operate during capture, and an e2e trace was captured elsewhere',
    );
  });

  it('accepts the reserved none on both axes, which is what an ingest actually carries', () => {
    expect(() =>
      assertRunSourceConsistent('forecast', {
        source: SOURCE_E2E,
        e2e: INFO,
        variant: 'none',
        scenario: 'none',
      }),
    ).not.toThrow();
  });

  it('throws a StoreError, so the CLI maps it to an exit code without a translation table', () => {
    try {
      assertRunSourceConsistent('forecast', { source: SOURCE_E2E });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe('e2e-meta-missing');
    }
  });
});

describe('the unknown revision', () => {
  it('is a real Revision, so nothing downstream has to handle a nullable field', () => {
    expect(UNKNOWN_REVISION).toEqual({ sha: REVISION_UNKNOWN_SHA, ref: null, dirty: false });
    expect(REVISION_UNKNOWN_SHA).toBe('unknown');
  });

  it('cannot be confused with a git sha, which is hex', () => {
    expect(isUnknownRevision(UNKNOWN_REVISION)).toBe(true);
    expect(isUnknownRevision({ sha: '9f8e7d6', ref: null, dirty: false })).toBe(false);
    expect(isUnknownRevision(null)).toBe(true);
    expect(isUnknownRevision(undefined)).toBe(true);
  });
});

describe('the warnings ingestion raises', () => {
  it('says nothing when every pin was used', () => {
    expect(unmatchedMapWarning([])).toBeNull();
  });

  it('names every stale pin, in the singular and the plural', () => {
    const one = unmatchedMapWarning(['checkout.spec.ts › checkout › shows the cart']);
    expect(one?.kind).toBe(E2E_MAP_UNMATCHED);
    expect(one?.message).toBe(
      'e2e-map.yaml pins 1 title no ingested trace contains: ' +
        '"checkout.spec.ts › checkout › shows the cart" — each pin is doing nothing',
    );
    expect(one?.titles).toEqual(['checkout.spec.ts › checkout › shows the cart']);

    const two = unmatchedMapWarning(['a › b', 'c › d']);
    expect(two?.message).toBe(
      'e2e-map.yaml pins 2 titles no ingested trace contains: "a › b", "c › d" — ' +
        'each pin is doing nothing',
    );
  });

  it('reports duplicate step titles once for the whole test, not once per repeat (§8)', () => {
    expect(duplicateStepTitlesWarning('a › b', [])).toBeNull();
    const warning = duplicateStepTitlesWarning('checkout.spec.ts › checkout › shows the cart', [
      { title: 'run the search', ids: ['run-the-search', 'run-the-search-2'] },
      { title: 'wait', ids: ['wait', 'wait-2', 'wait-3'] },
    ]);
    expect(warning?.kind).toBe(E2E_DUPLICATE_STEP_TITLES);
    expect(warning?.message).toBe(
      '2 step titles repeat within "checkout.spec.ts › checkout › shows the cart"; ' +
        'the repeats were numbered rather than merged: ' +
        '"run the search" → run-the-search-2; "wait" → wait-2, wait-3',
    );
    expect(warning?.titles).toEqual(['run the search', 'wait']);
  });

  it('agrees on the singular for one repeated title', () => {
    const warning = duplicateStepTitlesWarning('a › b', [
      { title: 'open', ids: ['open', 'open-2'] },
    ]);
    expect(warning?.message).toBe(
      '1 step title repeats within "a › b"; ' +
        'the repeats were numbered rather than merged: "open" → open-2',
    );
  });
});

describe('prose', () => {
  it('names a source the same way everywhere', () => {
    expect(describeSource(SOURCE_REPLAY)).toBe('a replay capture');
    expect(describeSource(SOURCE_E2E)).toBe('an ingested e2e trace');
  });
});

describe('keepE2eRunsOf', () => {
  it('defaults a retention block written before the key existed', () => {
    expect(keepE2eRunsOf({ keepRuns: 20 })).toBe(DEFAULT_KEEP_E2E_RUNS);
    expect(DEFAULT_KEEP_E2E_RUNS).toBe(20);
  });

  it('uses a configured bucket size', () => {
    expect(keepE2eRunsOf({ keepRuns: 20, keepE2eRuns: 5 })).toBe(5);
  });

  it('falls back rather than letting a nonsense value reach the pruner as a cap', () => {
    expect(keepE2eRunsOf({ keepRuns: 20, keepE2eRuns: 0 })).toBe(DEFAULT_KEEP_E2E_RUNS);
    expect(keepE2eRunsOf({ keepRuns: 20, keepE2eRuns: -1 })).toBe(DEFAULT_KEEP_E2E_RUNS);
    expect(keepE2eRunsOf({ keepRuns: 20, keepE2eRuns: 2.5 })).toBe(DEFAULT_KEEP_E2E_RUNS);
    expect(
      keepE2eRunsOf({ keepRuns: 20, keepE2eRuns: 'ten' } as unknown as { keepRuns: number }),
    ).toBe(DEFAULT_KEEP_E2E_RUNS);
  });
});
