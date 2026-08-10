/**
 * Pair labelling on the variant axis (variants spec §5, D24).
 *
 * The design decision under test is a refusal to copy the scenario axis. Two comparisons look
 * identical from inside `pairScenarios` — "the two sides differ" — and mean opposite things here:
 *
 * 1. **a variant against the unmodified page at the same revision is the proposal question**, the
 *    single reason the feature exists, and it must produce no warning at all. Labelling it would
 *    print a warning on every intended use, which is how a tool teaches people to stop reading its
 *    warnings;
 * 2. **a variant against anything else** — another proposal, or the unvaried page at a *different*
 *    revision — mixes the proposal with something else and must say so. The second is the dangerous
 *    one: its findings are the rearrangement plus the intervening code change, added together with
 *    nothing to separate them.
 *
 * The cache tests at the bottom guard the same failure `cache.ts` was built for, one axis over. A
 * pair stored as a proposal must not be served back for a comparison that is no longer one — and
 * because `proposal` turns on the two runs' *revisions*, that can change without either run id or
 * either variant name moving.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SCENARIO_NONE } from '../types.js';
import type { DiffResult, Revision, RunMeta } from '../types.js';
import { VARIANT_NONE } from '../store/internal/variant.js';
import type { MaybeVariant } from '../store/internal/variant.js';
import {
  diffCacheKey,
  diffConfigFingerprint,
  isCacheHit,
  readCachedDiff,
  SCENARIOLESS_PAIR,
} from './cache.js';
import { computeDiff, defaultDiffOptions, diffRuns } from './engine.js';
import { loadRunDir } from './loadRun.js';
import {
  labelPair,
  pairVariants,
  variantPairLabels,
  PAIR_LABEL_SEVERITY,
  VARIANTLESS_PAIR,
  VARIANT_PAIR_LABELS,
} from './pairing.js';
import type { PairVariants, VariantAwareDiffResult } from './pairing.js';
import { solidImage, writeRunFixture } from './testkit.js';
import type { FixtureRun } from './testkit.js';

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const REV_1: Revision = { sha: 'rev-1', ref: 'main', dirty: false };
const REV_2: Revision = { sha: 'rev-2', ref: 'main', dirty: false };

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempVdiff(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vdiff-variant-pairing-'));
  dirs.push(dir);
  return path.join(dir, '.visual-diff');
}

function meta(overrides: MaybeVariant = {}): RunMeta {
  return {
    runId: '0007',
    flow: 'forecast',
    scenario: SCENARIO_NONE,
    variant: VARIANT_NONE,
    flowHash: 'sha256:fixture',
    revision: REV_1,
    mode: 'attach',
    network: 'replay',
    harHits: 4,
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
      deviceScaleFactor: 1,
    },
    startedAt: '2026-08-10T10:00:00.000Z',
    finishedAt: '2026-08-10T10:00:10.000Z',
    unstable: false,
    pinned: false,
    pruned: false,
    warnings: [],
    ...overrides,
  } as RunMeta;
}

/** One step, one viewport, one flat white shot: identical on both sides, so findings stay at zero. */
function runFixture(runId: string): FixtureRun {
  return {
    runId,
    flow: 'forecast',
    steps: [
      {
        id: 'forecast',
        spec: { goto: '/' },
        shots: [{ viewport: '1280x800', image: solidImage(40, 20, WHITE) }],
      },
    ],
  };
}

async function writePair(
  vdiffDir: string,
  base: MaybeVariant,
  head: MaybeVariant,
): Promise<{ baseRunDir: string; headRunDir: string }> {
  const baseRunDir = path.join(vdiffDir, 'runs', 'forecast', '0003');
  const headRunDir = path.join(vdiffDir, 'runs', 'forecast', '0007');
  await writeRunFixture(baseRunDir, {
    ...runFixture('0003'),
    meta: { revision: REV_1, ...base },
  });
  await writeRunFixture(headRunDir, {
    ...runFixture('0007'),
    meta: { revision: REV_1, ...head },
  });
  return { baseRunDir, headRunDir };
}

describe('pairVariants', () => {
  it('reports two unvaried runs with neither flag — every pre-variants pair', () => {
    expect(pairVariants(meta({ runId: '0003' }), meta())).toEqual(VARIANTLESS_PAIR);
    expect(variantPairLabels(VARIANTLESS_PAIR)).toEqual([]);
  });

  it('reads a run written before the field existed as none, not as unknown', () => {
    const { variant: _absentBase, ...before } = meta({ runId: '0003' }) as MaybeVariant;
    const { variant: _absentHead, ...alsoBefore } = meta() as MaybeVariant;
    expect(pairVariants(before as RunMeta, alsoBefore as RunMeta)).toEqual(VARIANTLESS_PAIR);
  });

  it('calls a variant against the unvaried page at one revision the proposal, and does not cross it', () => {
    const variants = pairVariants(
      meta({ runId: '0003' }),
      meta({ variant: 'denser-forecast' }),
    );
    expect(variants).toEqual({
      base: VARIANT_NONE,
      head: 'denser-forecast',
      proposal: true,
      crossVariant: false,
    });
    expect(variantPairLabels(variants)).toEqual([]);
  });

  it('reads the proposal the other way round too — which side is varied carries no meaning', () => {
    const variants = pairVariants(
      meta({ runId: '0003', variant: 'denser-forecast' }),
      meta(),
    );
    expect(variants.proposal).toBe(true);
    expect(variants.crossVariant).toBe(false);
  });

  it('says nothing about two runs of one variant: that is the regression question on this axis', () => {
    const variants = pairVariants(
      meta({ runId: '0003', variant: 'denser-forecast', revision: REV_1 }),
      meta({ variant: 'denser-forecast', revision: REV_2 }),
    );
    expect(variants.proposal).toBe(false);
    expect(variants.crossVariant).toBe(false);
    expect(variantPairLabels(variants)).toEqual([]);
  });

  it('crosses when two different proposals are compared', () => {
    const variants = pairVariants(
      meta({ runId: '0003', variant: 'denser-forecast' }),
      meta({ variant: 'wider-forecast' }),
    );
    expect(variants.proposal).toBe(false);
    expect(variants.crossVariant).toBe(true);
    expect(variantPairLabels(variants)).toEqual(['cross-variant']);
  });

  it('crosses when the unvaried side is a different revision — the misleading pair', () => {
    const variants = pairVariants(
      meta({ runId: '0003', revision: REV_1 }),
      meta({ variant: 'denser-forecast', revision: REV_2 }),
    );
    expect(variants.proposal).toBe(false);
    expect(variants.crossVariant).toBe(true);
  });

  it('refuses to call two different dirty trees at one sha the same revision', () => {
    const variants = pairVariants(
      meta({ runId: '0003', revision: { sha: 'rev-1', ref: 'main', dirty: true, dirtyHash: 'a' } }),
      meta({
        variant: 'denser-forecast',
        revision: { sha: 'rev-1', ref: 'main', dirty: true, dirtyHash: 'b' },
      }),
    );
    expect(variants.proposal).toBe(false);
    expect(variants.crossVariant).toBe(true);
  });

  it('enumerates the label set, which has exactly one member on this axis', () => {
    expect([...VARIANT_PAIR_LABELS]).toEqual(['cross-variant']);
    expect(PAIR_LABEL_SEVERITY['cross-variant']).toBe('med');
  });
});

describe('labelPair on the variant axis', () => {
  it('says nothing at all about the proposal pair', () => {
    const labelling = labelPair(meta({ runId: '0003' }), meta({ variant: 'denser-forecast' }));
    expect(labelling.flags).toEqual([]);
    expect(labelling.variants.proposal).toBe(true);
  });

  it('names both runs and both variants when two proposals are compared', () => {
    const flags = labelPair(
      meta({ runId: '0003', variant: 'denser-forecast' }),
      meta({ variant: 'wider-forecast' }),
    ).flags;

    expect(flags).toEqual([
      {
        label: 'cross-variant',
        severity: 'med',
        message:
          "cross-variant pair: base run 0003 ran variant 'denser-forecast', head run 0007 ran " +
          "variant 'wider-forecast' — this compares two proposals, not two revisions",
      },
    ]);
  });

  it('names both revisions when a proposal is compared against another revision', () => {
    const flags = labelPair(
      meta({ runId: '0003', revision: REV_1 }),
      meta({ variant: 'denser-forecast', revision: REV_2 }),
    ).flags;

    expect(flags).toEqual([
      {
        label: 'cross-variant',
        severity: 'med',
        message:
          'cross-variant pair: base run 0003 ran no variant at revision rev-1, head run 0007 ran ' +
          "variant 'denser-forecast' at revision rev-2 — a proposal compared against a different " +
          'revision, not against the unmodified page it was proposed on',
      },
    ]);
  });

  it('marks a dirty tree in that message, so two runs at one sha do not read as identical', () => {
    const flags = labelPair(
      meta({ runId: '0003', revision: { sha: 'rev-1', ref: 'main', dirty: false } }),
      meta({
        variant: 'denser-forecast',
        revision: { sha: 'rev-1', ref: 'main', dirty: true, dirtyHash: 'wip' },
      }),
    ).flags;
    expect(flags[0]?.message).toContain('at revision rev-1 (dirty)');
  });

  it('carries a scenario label and a variant label together when a pair crosses both axes', () => {
    const flags = labelPair(
      meta({ runId: '0003', variant: 'denser-forecast' }),
      meta({ scenario: 'empty-forecast', variant: 'wider-forecast' }),
    ).flags;
    expect(flags.map((flag) => flag.label)).toEqual(['cross-scenario', 'cross-variant']);
  });
});

describe('diffRuns', () => {
  async function diffOf(base: MaybeVariant, head: MaybeVariant): Promise<VariantAwareDiffResult> {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(vdiffDir, base, head);
    const [baseLoad, headLoad] = await Promise.all([
      loadRunDir(baseRunDir),
      loadRunDir(headRunDir),
    ]);
    const { result } = await diffRuns(
      baseLoad.run,
      headLoad.run,
      defaultDiffOptions({ deviceScaleFactor: 1 }),
    );
    return result;
  }

  it('records an all-false variants block on an unvaried pair, and warns about nothing', async () => {
    const result = await diffOf({}, {});
    expect(result.variants).toEqual(VARIANTLESS_PAIR);
    expect(result.warnings).toEqual([]);
  });

  it('records the proposal without warning about it — the point of D24', async () => {
    const result = await diffOf({}, { variant: 'denser-forecast' });
    expect(result.variants).toEqual({
      base: VARIANT_NONE,
      head: 'denser-forecast',
      proposal: true,
      crossVariant: false,
    });
    expect(result.warnings).toEqual([]);
    // The report reads the metas to badge both runs, so the axis has to survive the load.
    expect((result.headMeta as MaybeVariant).variant).toBe('denser-forecast');
    expect((result.baseMeta as MaybeVariant).variant).toBe(VARIANT_NONE);
  });

  it('labels a cross-variant pair in findings.json and in the warnings', async () => {
    const result = await diffOf({ variant: 'denser-forecast' }, { variant: 'wider-forecast' });
    expect(result.variants?.crossVariant).toBe(true);
    expect(result.warnings).toEqual([
      "cross-variant pair: base run 0003 ran variant 'denser-forecast', head run 0007 ran " +
        "variant 'wider-forecast' — this compares two proposals, not two revisions",
    ]);
  });

  it('changes nothing else: a labelled pair is diffed exactly like any other', async () => {
    const proposal = await diffOf({}, { variant: 'denser-forecast' });
    const crossed = await diffOf({ variant: 'denser-forecast' }, { variant: 'wider-forecast' });
    expect(crossed.summary).toEqual(proposal.summary);
    expect(crossed.steps).toEqual(proposal.steps);
    expect(crossed.flowDiff).toEqual(proposal.flowDiff);
  });
});

describe('the diff cache on the variant axis', () => {
  const options = defaultDiffOptions({ deviceScaleFactor: 1 });

  const identity = (overrides: Partial<PairVariants> = {}): PairVariants => ({
    ...VARIANTLESS_PAIR,
    ...overrides,
  });

  it('keys a variant-less pair exactly as it did before the axis existed', () => {
    expect(diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR)).toBe(
      diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR),
    );
    expect(diffConfigFingerprint(options, SCENARIOLESS_PAIR)).toBe(
      diffConfigFingerprint(options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR),
    );
  });

  it('gives the same two run ids a different key under a different variant', () => {
    const unvaried = diffCacheKey('0003', '0007', options);
    const denser = diffCacheKey(
      '0003',
      '0007',
      options,
      SCENARIOLESS_PAIR,
      identity({ head: 'denser-forecast', proposal: true }),
    );
    const wider = diffCacheKey(
      '0003',
      '0007',
      options,
      SCENARIOLESS_PAIR,
      identity({ head: 'wider-forecast', proposal: true }),
    );

    expect(denser).not.toBe(unvaried);
    expect(wider).not.toBe(denser);
  });

  it('distinguishes the two sides, so a swapped proposal is not a hit', () => {
    expect(
      diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, identity({ base: 'denser-forecast', proposal: true })),
    ).not.toBe(
      diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, identity({ head: 'denser-forecast', proposal: true })),
    );
  });

  /*
   * The reason the variant key is not redundant with the variant *names*. Both sides keep their
   * names and their run ids; only the revisions move, and the pair stops being a proposal. A key
   * blind to that would serve the proposal's findings for a comparison that is no longer one.
   */
  it('folds the derived labels in, so a proposal is not served for a cross-variant pair', () => {
    const names = identity({ head: 'denser-forecast' });
    expect(diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, { ...names, proposal: true })).not.toBe(
      diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, { ...names, crossVariant: true }),
    );
  });

  it('recomputes rather than serving a stored diff whose variant identity has changed', async () => {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(vdiffDir, {}, {});
    const request = { baseRunDir, headRunDir, vdiffDir, options };

    const first = (await computeDiff(request)) as VariantAwareDiffResult;
    expect(first.variants).toEqual(VARIANTLESS_PAIR);

    // Same run ids, same revision, different variant identity.
    await writeRunFixture(headRunDir, {
      ...runFixture('0007'),
      meta: { revision: REV_1, variant: 'denser-forecast' },
    });

    const second = (await computeDiff(request)) as VariantAwareDiffResult;
    expect(second.variants?.head).toBe('denser-forecast');
    expect(second.variants?.proposal).toBe(true);

    const stored = JSON.parse(
      await readFile(path.join(vdiffDir, 'diffs', 'forecast', '0003..0007', 'findings.json'), 'utf8'),
    ) as VariantAwareDiffResult & { cacheKey?: string };
    expect(stored.variants?.proposal).toBe(true);
    expect(stored.cacheKey).toBe(
      diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, {
        base: VARIANT_NONE,
        head: 'denser-forecast',
        proposal: true,
        crossVariant: false,
      }),
    );
  });

  it('recomputes when only the baseline’s revision moved, which un-proposals the pair', async () => {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(
      vdiffDir,
      {},
      { variant: 'denser-forecast' },
    );
    const request = { baseRunDir, headRunDir, vdiffDir, options };

    const first = (await computeDiff(request)) as VariantAwareDiffResult;
    expect(first.variants?.proposal).toBe(true);
    expect(first.warnings).toEqual([]);

    // Nothing about either variant name or either run id changes here.
    await writeRunFixture(baseRunDir, { ...runFixture('0003'), meta: { revision: REV_2 } });

    const second = (await computeDiff(request)) as VariantAwareDiffResult;
    expect(second.variants?.proposal).toBe(false);
    expect(second.variants?.crossVariant).toBe(true);
    expect(second.warnings.some((w) => w.startsWith('cross-variant pair'))).toBe(true);
  });

  it('still hits when nothing on the variant axis moved', async () => {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(
      vdiffDir,
      {},
      { variant: 'denser-forecast' },
    );
    const request = { baseRunDir, headRunDir, vdiffDir, options };

    const first = await computeDiff(request);
    const second = await computeDiff(request);
    expect(second.computedAt).toBe(first.computedAt);
  });

  it('reads a stored variant-less diff as a miss for a proposal pair, never as unlabelled', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vdiff-variant-cache-'));
    dirs.push(dir);
    const stored = {
      pair: { base: '0003', head: '0007' },
      cacheKey: diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR),
    } as unknown as DiffResult & { cacheKey?: string };
    await writeFile(path.join(dir, 'findings.json'), `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

    const proposal = identity({ head: 'denser-forecast', proposal: true });
    expect(isCacheHit(stored, '0003', '0007', options, SCENARIOLESS_PAIR, proposal)).toBe(false);
    expect(
      await readCachedDiff(dir, '0003', '0007', options, SCENARIOLESS_PAIR, proposal),
    ).toBeNull();
    // Unchanged identity still hits, so the stricter key costs nothing when nothing moved.
    expect(
      await readCachedDiff(dir, '0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR),
    ).not.toBeNull();
  });
});
