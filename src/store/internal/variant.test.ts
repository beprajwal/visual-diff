/**
 * The variant axis of run identity (variants spec §5, D24).
 *
 * Two properties are under test, and the second is the one that makes the feature safe:
 *
 * 1. a run captured before variants existed is not "unknown", it is `none` — a fact about that run,
 *    and one every reader must reach the same way (the `scenarioOf` contract, one axis over);
 * 2. **the retention boundary is decided in exactly one place.** D24 exists because an afternoon of
 *    proposals must not evict the capture history regressions depend on, and that guarantee is only
 *    as good as there being a single answer to "which bucket is this run in".
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEEP_VARIANT_RUNS,
  VARIANT_NONE,
  captureHint,
  describeRevision,
  describeVariant,
  isEphemeralVariantRun,
  isKept,
  isVariantRun,
  keepVariantRunsOf,
  normalizeVariantMeta,
  normalizeVariantName,
  retentionBucketOf,
  runIdentityKey,
  sameRevision,
  sameVariant,
  variantOf,
} from './variant.js';
import type { MaybeVariant } from './variant.js';
import { SOURCE_E2E, SOURCE_REPLAY, UNKNOWN_REVISION } from './e2e.js';
import { SCENARIO_NONE } from '../../types.js';
import type { Revision, RunMeta } from '../../types.js';

const META: RunMeta = {
  runId: '0007',
  flow: 'forecast',
  scenario: 'empty-forecast',
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
    playwright: '1.50.0',
    chromium: '133',
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

function meta(overrides: MaybeVariant = {}): RunMeta {
  return { ...META, ...overrides } as RunMeta;
}

describe('variantOf', () => {
  it('reads a run captured before variants existed as the reserved none, not as unknown', () => {
    expect(variantOf(META)).toBe(VARIANT_NONE);
    expect(variantOf(null)).toBe(VARIANT_NONE);
    expect(variantOf(undefined)).toBe(VARIANT_NONE);
  });

  it('reads a named variant, trimmed', () => {
    expect(variantOf({ variant: 'denser-forecast' })).toBe('denser-forecast');
    expect(variantOf({ variant: '  denser-forecast  ' })).toBe('denser-forecast');
  });

  it('treats a blank or non-string variant as none rather than as a name', () => {
    expect(variantOf({ variant: '   ' })).toBe(VARIANT_NONE);
    expect(variantOf({ variant: 7 } as unknown as MaybeVariant)).toBe(VARIANT_NONE);
  });

  it('normalises a --variant argument exactly as it normalises a run', () => {
    expect(normalizeVariantName(undefined)).toBe(VARIANT_NONE);
    expect(normalizeVariantName('')).toBe(VARIANT_NONE);
    expect(normalizeVariantName(' denser-forecast ')).toBe('denser-forecast');
  });
});

describe('normalizeVariantMeta', () => {
  it('materialises the field on a run written before it existed', () => {
    expect((normalizeVariantMeta(META) as MaybeVariant).variant).toBe(VARIANT_NONE);
  });

  it('returns the same object when nothing needs changing, so reads stay cheap', () => {
    const already = meta({ variant: 'denser-forecast' });
    expect(normalizeVariantMeta(already)).toBe(already);
  });

  it('leaves every other field of the run alone', () => {
    const normalized = normalizeVariantMeta(META);
    expect(normalized.scenario).toBe('empty-forecast');
    expect(normalized.runId).toBe('0007');
    expect(normalized.revision).toEqual(META.revision);
  });
});

describe('the retention boundary (D24)', () => {
  it('puts an unvaried run in the timeline bucket', () => {
    expect(retentionBucketOf(META)).toBe('timeline');
    expect(isVariantRun(META)).toBe(false);
    expect(isEphemeralVariantRun(META)).toBe(false);
  });

  it('puts an unpromoted variant run in the variant bucket', () => {
    const proposal = meta({ variant: 'denser-forecast' });
    expect(isVariantRun(proposal)).toBe(true);
    expect(isKept(proposal)).toBe(false);
    expect(isEphemeralVariantRun(proposal)).toBe(true);
    expect(retentionBucketOf(proposal)).toBe('variant');
  });

  it('moves a promoted variant run into the timeline bucket — that is what --keep does', () => {
    const promoted = meta({ variant: 'denser-forecast', kept: true });
    expect(isVariantRun(promoted)).toBe(true);
    expect(isKept(promoted)).toBe(true);
    expect(isEphemeralVariantRun(promoted)).toBe(false);
    expect(retentionBucketOf(promoted)).toBe('timeline');
  });

  it('reads a missing kept flag as unpromoted rather than as unknown', () => {
    expect(isKept(META)).toBe(false);
    expect(isKept(null)).toBe(false);
    expect(isKept({ kept: false })).toBe(false);
  });

  it('puts an ingested run in its own bucket (e2e §7)', () => {
    expect(retentionBucketOf({ ...META, source: SOURCE_E2E })).toBe('e2e');
    expect(retentionBucketOf({ ...META, source: SOURCE_REPLAY })).toBe('timeline');
  });

  it('answers e2e even for a run that also claims a variant, so ingest can never enter the variant bucket', () => {
    // `commit` refuses to write such a run (§2), but this function is also asked about meta.json
    // files it did not write, and the isolation §7 asks for must not depend on that refusal.
    expect(retentionBucketOf({ ...META, source: SOURCE_E2E, variant: 'denser-forecast' })).toBe(
      'e2e',
    );
  });
});

describe('runIdentityKey', () => {
  it('groups by both axes, so one variant never shares a group with another', () => {
    const a = runIdentityKey(meta({ variant: 'denser-forecast' }));
    const b = runIdentityKey(meta({ variant: 'wider-forecast' }));
    const unvaried = runIdentityKey(META);
    expect(new Set([a, b, unvaried]).size).toBe(3);
  });

  it('gives two runs of one identity the same key', () => {
    expect(runIdentityKey(meta({ variant: 'denser-forecast', runId: '0001' }))).toBe(
      runIdentityKey(meta({ variant: 'denser-forecast', runId: '0009' })),
    );
  });

  it('does not confuse a scenario/variant split that a plain delimiter would', () => {
    // Only a separator no name can contain keeps these two identities apart.
    expect(runIdentityKey({ scenario: 'a b', variant: 'c' })).not.toBe(
      runIdentityKey({ scenario: 'a', variant: 'b c' }),
    );
  });

  it('reads a run missing every field as the replay/none/none identity', () => {
    expect(runIdentityKey(null)).toBe(
      runIdentityKey({ scenario: SCENARIO_NONE, variant: VARIANT_NONE, source: SOURCE_REPLAY }),
    );
  });

  it('separates the two timelines, so an ingested run is never counted against a replay one', () => {
    expect(runIdentityKey({ ...META, source: SOURCE_E2E })).not.toBe(runIdentityKey(META));
  });
});

describe('sameRevision', () => {
  const clean: Revision = { sha: '9f8e7d6', ref: 'main', dirty: false };

  it('is the same code reached from two branch names', () => {
    expect(sameRevision(clean, { sha: '9f8e7d6', ref: 'feat/denser', dirty: false })).toBe(true);
  });

  it('is not the same code at two shas', () => {
    expect(sameRevision(clean, { ...clean, sha: '1a2b3c4' })).toBe(false);
  });

  it('refuses to call a dirty tree the same revision as the clean commit under it', () => {
    expect(sameRevision(clean, { ...clean, dirty: true, dirtyHash: 'sha256:wip' })).toBe(false);
  });

  it('separates two different dirty trees at one sha, which is what dirtyHash is for', () => {
    const first: Revision = { ...clean, dirty: true, dirtyHash: 'sha256:wip-1' };
    const second: Revision = { ...clean, dirty: true, dirtyHash: 'sha256:wip-2' };
    expect(sameRevision(first, second)).toBe(false);
    expect(sameRevision(first, { ...first })).toBe(true);
  });

  it('answers false for an unknown revision rather than guessing', () => {
    expect(sameRevision(clean, null)).toBe(false);
    expect(sameRevision(null, null)).toBe(false);
    expect(sameRevision(clean, undefined)).toBe(false);
  });

  it('refuses to call two ingested runs the same code merely because both are unknown', () => {
    // Every e2e run records `revision: unknown` (e2e §7), so a match here would silently make any
    // two of them "the same revision" and let one stand in as the other's baseline.
    expect(sameRevision(UNKNOWN_REVISION, UNKNOWN_REVISION)).toBe(false);
    expect(sameRevision(clean, UNKNOWN_REVISION)).toBe(false);
  });
});

describe('sameVariant', () => {
  it('reads two runs written before the field existed as the same point on the axis', () => {
    expect(sameVariant(META, { ...META })).toBe(true);
  });

  it('separates a proposal from the unmodified page', () => {
    expect(sameVariant(META, meta({ variant: 'denser-forecast' }))).toBe(false);
  });
});

describe('prose helpers', () => {
  it('names a variant the same way everywhere, including when there is none', () => {
    expect(describeVariant(VARIANT_NONE)).toBe('no variant');
    expect(describeVariant('denser-forecast')).toBe("variant 'denser-forecast'");
  });

  it('marks a dirty revision, so two runs at one sha do not read as identical', () => {
    expect(describeRevision({ sha: '9f8e7d6', ref: 'main', dirty: false })).toBe('9f8e7d6');
    expect(describeRevision({ sha: '9f8e7d6', ref: 'main', dirty: true })).toBe('9f8e7d6 (dirty)');
    expect(describeRevision(null)).toBe('an unknown revision');
    // And the recorded form of "unknown" reads the same as the absent one.
    expect(describeRevision(UNKNOWN_REVISION)).toBe('an unknown revision');
  });

  it('builds the capture command a hint should print, on both axes', () => {
    expect(captureHint('forecast', SCENARIO_NONE, VARIANT_NONE)).toBe('vdiff run forecast');
    expect(captureHint('forecast', 'empty-forecast', VARIANT_NONE)).toBe(
      'vdiff run forecast --scenario empty-forecast',
    );
    expect(captureHint('forecast', 'empty-forecast', 'denser-forecast')).toBe(
      'vdiff run forecast --scenario empty-forecast --variant denser-forecast',
    );
  });
});

describe('keepVariantRunsOf', () => {
  it('defaults a retention block written before the key existed', () => {
    expect(keepVariantRunsOf({ keepRuns: 20 })).toBe(DEFAULT_KEEP_VARIANT_RUNS);
    expect(DEFAULT_KEEP_VARIANT_RUNS).toBe(10);
  });

  it('uses a configured bucket size', () => {
    expect(keepVariantRunsOf({ keepRuns: 20, keepVariantRuns: 3 })).toBe(3);
  });

  it('falls back rather than letting a nonsense value reach the pruner as a cap', () => {
    expect(keepVariantRunsOf({ keepRuns: 20, keepVariantRuns: 0 })).toBe(DEFAULT_KEEP_VARIANT_RUNS);
    expect(keepVariantRunsOf({ keepRuns: 20, keepVariantRuns: -1 })).toBe(DEFAULT_KEEP_VARIANT_RUNS);
    expect(keepVariantRunsOf({ keepRuns: 20, keepVariantRuns: 2.5 })).toBe(DEFAULT_KEEP_VARIANT_RUNS);
    expect(
      keepVariantRunsOf({ keepRuns: 20, keepVariantRuns: 'ten' } as unknown as { keepRuns: number }),
    ).toBe(DEFAULT_KEEP_VARIANT_RUNS);
  });
});
