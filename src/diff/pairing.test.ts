/**
 * Pair labelling on the scenario axis (mocking spec §6).
 *
 * Two properties are under test, and they pull in opposite directions on purpose:
 *
 * 1. a same-scenario pair — the overwhelmingly common one, and every slice-1 pair — is labelled
 *    with nothing at all, so the feature is invisible until it has something to say;
 * 2. the two pairings the tool permits but must not let read as ordinary regressions are always
 *    labelled, at the severity the spec assigns, and are *still computed* — permitted, not refused.
 *
 * The cache tests at the bottom are the ones that matter most. A pair whose findings were computed
 * and stored before the labelling existed, or under a different scenario identity, must not be
 * served back unlabelled: that is the stale-findings failure, one axis over from the configuration
 * one `cache.ts` already guards.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SCENARIO_NONE } from '../types.js';
import type { DiffResult, PairScenarios, RunMeta } from '../types.js';
import { diffCacheKey, diffConfigFingerprint, SCENARIOLESS_PAIR } from './cache.js';
import { computeDiff, defaultDiffOptions, diffRuns } from './engine.js';
import { loadRunDir } from './loadRun.js';
import {
  isMockOnly,
  labelPair,
  pairLabels,
  pairScenarios,
  PAIR_LABEL_SEVERITY,
} from './pairing.js';
import { solidImage, writeRunFixture } from './testkit.js';
import type { FixtureRun } from './testkit.js';

const WHITE: [number, number, number, number] = [255, 255, 255, 255];

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempVdiff(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vdiff-pairing-'));
  dirs.push(dir);
  return path.join(dir, '.visual-diff');
}

function meta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: '0007',
    flow: 'forecast',
    scenario: SCENARIO_NONE,
    flowHash: 'sha256:fixture',
    revision: { sha: '9f8e7d6', ref: 'main', dirty: false },
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
  };
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
  base: Partial<RunMeta>,
  head: Partial<RunMeta>,
): Promise<{ baseRunDir: string; headRunDir: string }> {
  const baseRunDir = path.join(vdiffDir, 'runs', 'forecast', '0003');
  const headRunDir = path.join(vdiffDir, 'runs', 'forecast', '0007');
  await writeRunFixture(baseRunDir, { ...runFixture('0003'), meta: base });
  await writeRunFixture(headRunDir, { ...runFixture('0007'), meta: head });
  return { baseRunDir, headRunDir };
}

describe('pairScenarios', () => {
  it('reports a same-scenario pair with neither flag — the regression question', () => {
    const scenarios = pairScenarios(
      meta({ runId: '0003', scenario: 'empty-forecast' }),
      meta({ scenario: 'empty-forecast' }),
    );
    expect(scenarios).toEqual({
      base: 'empty-forecast',
      head: 'empty-forecast',
      crossScenario: false,
      mockVsRecorded: false,
    });
    expect(pairLabels(scenarios)).toEqual([]);
  });

  it('reads two slice-1 runs as a none-vs-none pair, not as unknown', () => {
    const { scenario: _absentBase, ...sliceOneBase } = meta({ runId: '0003' });
    const { scenario: _absentHead, ...sliceOneHead } = meta();
    const scenarios = pairScenarios(sliceOneBase as RunMeta, sliceOneHead as RunMeta);
    expect(scenarios).toEqual(SCENARIOLESS_PAIR);
  });

  it('labels different scenarios cross-scenario', () => {
    const scenarios = pairScenarios(meta({ runId: '0003' }), meta({ scenario: 'empty-forecast' }));
    expect(scenarios.crossScenario).toBe(true);
    expect(scenarios.mockVsRecorded).toBe(false);
    expect(pairLabels(scenarios)).toEqual(['cross-scenario']);
  });

  it('decides mock-vs-recorded by the network mode, not by the scenario name', () => {
    const bothMocked = pairScenarios(
      meta({ runId: '0003', scenario: 'wireframe', network: 'mock' }),
      meta({ scenario: 'wireframe', network: 'mock' }),
    );
    // Two fictions produced by the same rules are as comparable as any like-for-like pair.
    expect(bothMocked.mockVsRecorded).toBe(false);
    expect(pairLabels(bothMocked)).toEqual([]);

    const oneMocked = pairScenarios(
      meta({ runId: '0003', scenario: 'wireframe', network: 'mock' }),
      meta({ scenario: 'wireframe', network: 'replay' }),
    );
    expect(oneMocked.crossScenario).toBe(false);
    expect(oneMocked.mockVsRecorded).toBe(true);
    expect(pairLabels(oneMocked)).toEqual(['mock-vs-recorded']);
  });

  it('carries both labels when a mock-only run is paired against another scenario', () => {
    const scenarios = pairScenarios(
      meta({ runId: '0003', scenario: 'wireframe', network: 'mock', harHits: 0 }),
      meta(),
    );
    expect(pairLabels(scenarios)).toEqual(['cross-scenario', 'mock-vs-recorded']);
  });

  it('knows a mock-only run from its network mode', () => {
    expect(isMockOnly(meta({ network: 'mock' }))).toBe(true);
    expect(isMockOnly(meta({ network: 'replay' }))).toBe(false);
    expect(isMockOnly(meta({ network: 'off' }))).toBe(false);
  });
});

describe('labelPair', () => {
  it('says nothing about a same-scenario pair', () => {
    expect(labelPair(meta({ runId: '0003' }), meta()).flags).toEqual([]);
  });

  it('names both runs and both scenarios, and calls the comparison what it is', () => {
    const flags = labelPair(
      meta({ runId: '0003' }),
      meta({ scenario: 'empty-forecast' }),
    ).flags;

    expect(flags).toEqual([
      {
        label: 'cross-scenario',
        severity: 'med',
        message:
          "cross-scenario pair: base run 0003 ran no scenario, head run 0007 ran scenario 'empty-forecast' — " +
          'this compares two states, not two revisions',
      },
    ]);
  });

  it('flags a mock-only run against a recorded one at high severity, whichever side is mocked', () => {
    const headMocked = labelPair(
      meta({ runId: '0003', scenario: 'wireframe' }),
      meta({ scenario: 'wireframe', network: 'mock', harHits: 0 }),
    ).flags;
    expect(headMocked).toEqual([
      {
        label: 'mock-vs-recorded',
        severity: 'high',
        message:
          "mock-vs-recorded pair: run 0007 is mock-only (scenario 'wireframe') while run 0003 ran " +
          'against a recording — a fiction compared against a measurement',
      },
    ]);

    const baseMocked = labelPair(
      meta({ runId: '0003', scenario: 'wireframe', network: 'mock', harHits: 0 }),
      meta({ scenario: 'wireframe' }),
    ).flags;
    expect(baseMocked[0]?.message).toContain('run 0003 is mock-only');
    expect(baseMocked[0]?.message).toContain('run 0007 ran against a recording');
  });

  it('assigns mock-vs-recorded the higher severity of the two labels', () => {
    expect(PAIR_LABEL_SEVERITY['mock-vs-recorded']).toBe('high');
    expect(PAIR_LABEL_SEVERITY['cross-scenario']).toBe('med');
  });
});

describe('diffRuns', () => {
  async function diffOf(base: Partial<RunMeta>, head: Partial<RunMeta>): Promise<DiffResult> {
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

  it('records an all-false scenarios block on a same-scenario pair, and warns about nothing', async () => {
    const result = await diffOf({ scenario: 'empty-forecast' }, { scenario: 'empty-forecast' });
    expect(result.scenarios).toEqual({
      base: 'empty-forecast',
      head: 'empty-forecast',
      crossScenario: false,
      mockVsRecorded: false,
    });
    expect(result.warnings).toEqual([]);
  });

  it('labels a cross-scenario pair in findings.json and in the warnings', async () => {
    const result = await diffOf({}, { scenario: 'empty-forecast' });
    expect(result.scenarios?.crossScenario).toBe(true);
    expect(result.warnings).toEqual([
      "cross-scenario pair: base run 0003 ran no scenario, head run 0007 ran scenario 'empty-forecast' — " +
        'this compares two states, not two revisions',
    ]);
  });

  it('warns about a mock-only run paired against a recorded one', async () => {
    const result = await diffOf({}, { scenario: 'wireframe', network: 'mock', harHits: 0 });
    expect(result.scenarios?.mockVsRecorded).toBe(true);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[1]).toContain('a fiction compared against a measurement');
    // Both runs are badged: the metas the report reads carry the mode that decided the flag.
    expect(result.baseMeta.network).toBe('replay');
    expect(result.headMeta.network).toBe('mock');
  });

  it('changes nothing else: a labelled pair is diffed exactly like any other', async () => {
    const same = await diffOf({ scenario: 'empty-forecast' }, { scenario: 'empty-forecast' });
    const crossed = await diffOf({}, { scenario: 'empty-forecast' });
    expect(crossed.summary).toEqual(same.summary);
    expect(crossed.steps).toEqual(same.steps);
    expect(crossed.flowDiff).toEqual(same.flowDiff);
  });
});

describe('the diff cache on the scenario axis', () => {
  const options = defaultDiffOptions({ deviceScaleFactor: 1 });

  const identity = (overrides: Partial<PairScenarios> = {}): PairScenarios => ({
    ...SCENARIOLESS_PAIR,
    ...overrides,
  });

  it('keys a scenario-less pair exactly as it always did', () => {
    expect(diffCacheKey('0003', '0007', options)).toBe(
      diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR),
    );
    expect(diffConfigFingerprint(options)).toBe(
      diffConfigFingerprint(options, SCENARIOLESS_PAIR),
    );
  });

  it('gives the same two run ids a different key under a different scenario', () => {
    const scenarioLess = diffCacheKey('0003', '0007', options);
    const underEmpty = diffCacheKey(
      '0003',
      '0007',
      options,
      identity({ base: 'empty-forecast', head: 'empty-forecast' }),
    );
    const underSlow = diffCacheKey(
      '0003',
      '0007',
      options,
      identity({ base: 'slow-forecast', head: 'slow-forecast' }),
    );

    expect(underEmpty).not.toBe(scenarioLess);
    expect(underSlow).not.toBe(underEmpty);
  });

  it('distinguishes the two sides, so a swapped pairing is not a hit', () => {
    expect(
      diffCacheKey('0003', '0007', options, identity({ base: 'empty-forecast', crossScenario: true })),
    ).not.toBe(
      diffCacheKey('0003', '0007', options, identity({ head: 'empty-forecast', crossScenario: true })),
    );
  });

  it('folds the labels in as well as the names, so a changed derivation cannot be reused', () => {
    const names = identity({ base: 'a', head: 'b' });
    expect(diffCacheKey('0003', '0007', options, names)).not.toBe(
      diffCacheKey('0003', '0007', options, { ...names, crossScenario: true }),
    );
    expect(diffCacheKey('0003', '0007', options, names)).not.toBe(
      diffCacheKey('0003', '0007', options, { ...names, mockVsRecorded: true }),
    );
  });

  /*
   * The end-to-end version of the same defect: `findings.json` for 0003..0007 already exists,
   * computed when neither run had a scenario. The runs are then re-captured under a scenario at the
   * same ids. Serving the stored result would drop the `scenarios` block and the label with it.
   */
  it('recomputes rather than serving a stored diff whose scenario identity has changed', async () => {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(vdiffDir, {}, {});
    const request = { baseRunDir, headRunDir, vdiffDir, options };

    const first = await computeDiff(request);
    expect(first.scenarios).toEqual(SCENARIOLESS_PAIR);

    // Same run ids, different scenario identity.
    await writeRunFixture(headRunDir, {
      ...runFixture('0007'),
      meta: { scenario: 'empty-forecast' },
    });

    const second = await computeDiff(request);
    expect(second.scenarios?.head).toBe('empty-forecast');
    expect(second.scenarios?.crossScenario).toBe(true);
    expect(second.warnings.some((w) => w.startsWith('cross-scenario pair'))).toBe(true);

    const stored = JSON.parse(
      await readFile(path.join(vdiffDir, 'diffs', 'forecast', '0003..0007', 'findings.json'), 'utf8'),
    ) as DiffResult & { cacheKey?: string };
    expect(stored.scenarios?.crossScenario).toBe(true);
    expect(stored.cacheKey).toBe(
      diffCacheKey('0003', '0007', options, {
        base: SCENARIO_NONE,
        head: 'empty-forecast',
        crossScenario: true,
        mockVsRecorded: false,
      }),
    );
  });

  it('still hits when nothing on the scenario axis moved', async () => {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(
      vdiffDir,
      { scenario: 'empty-forecast' },
      { scenario: 'empty-forecast' },
    );
    const request = { baseRunDir, headRunDir, vdiffDir, options };

    const first = await computeDiff(request);
    const findings = path.join(vdiffDir, 'diffs', 'forecast', '0003..0007', 'findings.json');
    const marked = JSON.parse(await readFile(findings, 'utf8')) as DiffResult;
    marked.warnings = ['served from cache'];
    await writeFile(findings, `${JSON.stringify(marked, null, 2)}\n`, 'utf8');

    const second = await computeDiff(request);
    expect(second.warnings).toEqual(['served from cache']);
    expect(second.computedAt).toBe(first.computedAt);
  });
});
