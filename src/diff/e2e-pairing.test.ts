/**
 * Pair labelling, fidelity and noise tolerance on the source axis (e2e spec §4, §5, §7, D27).
 *
 * Three decisions are under test, and they pull in different directions:
 *
 * 1. **e2e pairs with e2e, and that pair carries no warning.** It is the regression question on its
 *    own timeline — the whole point of the feature — so warning about it would print a warning on
 *    the intended use, which is the D24 mistake one axis over. Only the *mixed* pair is flagged,
 *    and at high severity, exactly as mock-versus-recorded is (D13, D27).
 * 2. **An ingested pair still cannot say everything.** A trace carries no computed styles and no
 *    accessibility tree (§4), so the result records reduced fidelity and every finding it produced
 *    is stamped with it. "We found nothing" and "we could not look" must not read alike.
 * 3. **An ingested pair is diffed under different thresholds** (§5), which makes the source axis the
 *    only one of the three that changes what the engine computes — and therefore the only one whose
 *    identity has to reach the cache key twice: once as identity, once as the resolved options.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SCENARIO_NONE } from '../types.js';
import type { DiffResult, Revision, RunMeta } from '../types.js';
import { VARIANT_NONE } from '../store/internal/variant.js';
import { SOURCE_E2E, SOURCE_REPLAY } from '../store/internal/e2e.js';
import type { MaybeE2e } from '../store/internal/e2e.js';
import {
  diffCacheKey,
  diffConfigFingerprint,
  isCacheHit,
  readCachedDiff,
  SCENARIOLESS_PAIR,
} from './cache.js';
import { computeDiff, defaultDiffOptions, diffRuns } from './engine.js';
import { e2eNoiseSettings, resolveDiffOptions, E2E_DIFF_DEFAULTS } from './e2e-noise.js';
import {
  withoutUnbackedChanges,
  DEGRADED_CAPTURES,
  DEGRADED_REASON,
  FULL_FIDELITY,
} from './fidelity.js';
import { loadRunDir } from './loadRun.js';
import {
  labelPair,
  pairSources,
  sourcePairLabels,
  PAIR_LABEL_SEVERITY,
  REPLAY_PAIR,
  SOURCE_PAIR_LABELS,
  VARIANTLESS_PAIR,
} from './pairing.js';
import type { PairSources, SourceAwareDiffResult } from './pairing.js';
import { domNode, paintRect, solidImage, writeRunFixture } from './testkit.js';
import type { FixtureRun } from './testkit.js';

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const RED: [number, number, number, number] = [220, 30, 30, 255];
const REV_1: Revision = { sha: 'rev-1', ref: 'main', dirty: false };

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempVdiff(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vdiff-e2e-pairing-'));
  dirs.push(dir);
  return path.join(dir, '.visual-diff');
}

function meta(overrides: MaybeE2e = {}): RunMeta {
  return {
    runId: '0007',
    flow: 'forecast',
    scenario: SCENARIO_NONE,
    variant: VARIANT_NONE,
    source: SOURCE_REPLAY,
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
      playwright: '1.62.1',
      chromium: '151',
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

/**
 * One step, one viewport. `changed` paints a square into the head shot: 40×40 clears both the
 * replay floor (64) and the e2e floor (256), 10×10 clears only the replay one.
 */
function runFixture(runId: string, changed: number = 0): FixtureRun {
  const image = solidImage(120, 120, WHITE);
  if (changed > 0) paintRect(image, { x: 20, y: 20, w: changed, h: changed }, RED);
  return {
    runId,
    flow: 'forecast',
    steps: [
      {
        id: 'forecast',
        spec: { goto: '/' },
        shots: [{ viewport: '1280x800', image }],
      },
    ],
  };
}

async function writePair(
  vdiffDir: string,
  base: MaybeE2e,
  head: MaybeE2e,
  changed: number = 0,
): Promise<{ baseRunDir: string; headRunDir: string }> {
  const baseRunDir = path.join(vdiffDir, 'runs', 'forecast', '0003');
  const headRunDir = path.join(vdiffDir, 'runs', 'forecast', '0007');
  await writeRunFixture(baseRunDir, { ...runFixture('0003'), meta: { revision: REV_1, ...base } });
  await writeRunFixture(headRunDir, {
    ...runFixture('0007', changed),
    meta: { revision: REV_1, ...head },
  });
  return { baseRunDir, headRunDir };
}

const E2E = { source: SOURCE_E2E } as MaybeE2e;

describe('pairSources', () => {
  it('reports two replay runs with neither flag — every pair the tool could produce before e2e', () => {
    expect(pairSources(meta({ runId: '0003' }), meta())).toEqual(REPLAY_PAIR);
    expect(sourcePairLabels(REPLAY_PAIR)).toEqual([]);
  });

  it('reads a run written before the field existed as replay, not as unknown', () => {
    const { source: _absentBase, ...before } = meta({ runId: '0003' }) as MaybeE2e;
    const { source: _absentHead, ...alsoBefore } = meta() as MaybeE2e;
    expect(pairSources(before as RunMeta, alsoBefore as RunMeta)).toEqual(REPLAY_PAIR);
  });

  it('says nothing about two ingested runs: that is the regression question on this timeline', () => {
    const sources = pairSources(meta({ runId: '0003', ...E2E }), meta(E2E));
    expect(sources.base).toBe(SOURCE_E2E);
    expect(sources.head).toBe(SOURCE_E2E);
    expect(sources.crossSource).toBe(false);
    expect(sourcePairLabels(sources)).toEqual([]);
  });

  it('crosses when exactly one side was ingested, in either direction', () => {
    const headIngested = pairSources(meta({ runId: '0003' }), meta(E2E));
    const baseIngested = pairSources(meta({ runId: '0003', ...E2E }), meta());
    expect(headIngested.crossSource).toBe(true);
    expect(baseIngested.crossSource).toBe(true);
    expect(sourcePairLabels(headIngested)).toEqual(['e2e-vs-replay']);
    expect(sourcePairLabels(baseIngested)).toEqual(['e2e-vs-replay']);
  });

  it('enumerates the label set, which has one member, at mock-vs-recorded severity', () => {
    expect([...SOURCE_PAIR_LABELS]).toEqual(['e2e-vs-replay']);
    expect(PAIR_LABEL_SEVERITY['e2e-vs-replay']).toBe('high');
    expect(PAIR_LABEL_SEVERITY['e2e-vs-replay']).toBe(PAIR_LABEL_SEVERITY['mock-vs-recorded']);
  });
});

describe('fidelity', () => {
  it('calls a replay pair full, and names nothing as missing', () => {
    const sources = pairSources(meta({ runId: '0003' }), meta());
    expect(sources.fidelity).toEqual(FULL_FIDELITY);
    expect(sources.fidelity.missing).toEqual([]);
    expect(sources.fidelity.note).toContain('property-level findings');
  });

  it('degrades an e2e pair even though nothing about the pairing is wrong', () => {
    const sources = pairSources(meta({ runId: '0003', ...E2E }), meta(E2E));
    expect(sources.crossSource).toBe(false);
    expect(sources.fidelity.level).toBe('degraded');
    expect(sources.fidelity.missing).toEqual([...DEGRADED_CAPTURES]);
  });

  it('degrades a mixed pair too: a comparison is only as detailed as its poorer side', () => {
    expect(pairSources(meta({ runId: '0003' }), meta(E2E)).fidelity.level).toBe('degraded');
    expect(pairSources(meta({ runId: '0003', ...E2E }), meta()).fidelity.level).toBe('degraded');
  });

  it('says in one sentence what an e2e diff cannot report, in the spec’s own example', () => {
    const note = pairSources(meta({ runId: '0003', ...E2E }), meta(E2E)).fidelity.note;
    expect(note).toBe(
      'one or both runs were ingested from a Playwright trace, which carries no computed styles ' +
        'and no accessibility tree — pixel regions and DOM attribution still apply, ' +
        'property-level findings do not, so this diff cannot report a change like ' +
        '"padding 8px → 12px"',
    );
  });
});

describe('labelPair on the source axis', () => {
  it('says nothing at all about an e2e pair, and still records the reduced fidelity', () => {
    const labelling = labelPair(meta({ runId: '0003', ...E2E }), meta(E2E));
    expect(labelling.flags).toEqual([]);
    expect(labelling.sources.fidelity.level).toBe('degraded');
  });

  it('names the ingested run and the replayed one when the pair is mixed', () => {
    expect(labelPair(meta({ runId: '0003' }), meta(E2E)).flags).toEqual([
      {
        label: 'e2e-vs-replay',
        severity: 'high',
        message:
          'e2e-vs-replay pair: run 0007 is an ingested e2e trace while run 0003 is a replay ' +
          'capture — two capture paths, so a difference between them may be the application or ' +
          'may be the machinery that recorded it',
      },
    ]);
  });

  it('names the ingested side first whichever side it is', () => {
    const message = labelPair(meta({ runId: '0003', ...E2E }), meta()).flags[0]?.message;
    expect(message).toContain('run 0003 is an ingested e2e trace while run 0007 is a replay capture');
  });

  it('reads a source it cannot name as replay, and does not flag the pair for it', () => {
    const labelling = labelPair(meta({ runId: '0003' }), {
      ...meta(),
      source: 'cypress',
    } as unknown as RunMeta);
    // Not a flag: the pair is not mislabelled. The assumption is stated by the reader that made
    // it — `loadRunDir`, which still has the raw value — and asserted below.
    expect(labelling.flags).toEqual([]);
    expect(labelling.sources.head).toBe(SOURCE_REPLAY);
  });

  it('carries a label from each axis when a pair crosses all three', () => {
    const flags = labelPair(
      meta({ runId: '0003', variant: 'denser-forecast' }),
      meta({ scenario: 'empty-forecast', variant: 'wider-forecast', ...E2E }),
    ).flags;
    expect(flags.map((flag) => flag.label)).toEqual([
      'cross-scenario',
      'cross-variant',
      'e2e-vs-replay',
    ]);
  });
});

describe('diffRuns on the source axis', () => {
  async function diffOf(
    base: MaybeE2e,
    head: MaybeE2e,
    changed = 0,
  ): Promise<SourceAwareDiffResult> {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(vdiffDir, base, head, changed);
    const [baseLoad, headLoad] = await Promise.all([loadRunDir(baseRunDir), loadRunDir(headRunDir)]);
    const { result } = await diffRuns(
      baseLoad.run,
      headLoad.run,
      defaultDiffOptions({ deviceScaleFactor: 1 }),
    );
    return result;
  }

  it('records a replay-pair sources block on an unchanged pair, and warns about nothing', async () => {
    const result = await diffOf({}, {});
    expect(result.sources).toEqual(REPLAY_PAIR);
    expect(result.warnings).toEqual([]);
  });

  it('records an e2e pair without warning about it — the D27 default pairing', async () => {
    const result = await diffOf(E2E, E2E);
    expect(result.sources?.crossSource).toBe(false);
    expect(result.sources?.fidelity.level).toBe('degraded');
    expect(result.warnings).toEqual([]);
    // The report badges both runs off the metas, so the axis has to survive the load.
    expect((result.baseMeta as MaybeE2e).source).toBe(SOURCE_E2E);
    expect((result.headMeta as MaybeE2e).source).toBe(SOURCE_E2E);
  });

  it('labels a mixed pair in findings.json and in the warnings', async () => {
    const result = await diffOf({}, E2E);
    expect(result.sources?.crossSource).toBe(true);
    expect(result.warnings).toEqual([
      'e2e-vs-replay pair: run 0007 is an ingested e2e trace while run 0003 is a replay capture — ' +
        'two capture paths, so a difference between them may be the application or may be the ' +
        'machinery that recorded it',
    ]);
  });

  it('warns when a run records a source it cannot read, naming the value and the fallback', async () => {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(vdiffDir, {}, {});
    const metaPath = path.join(headRunDir, 'meta.json');
    const stored = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    stored.source = 'webdriverio';
    await writeFile(metaPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

    const [baseLoad, headLoad] = await Promise.all([loadRunDir(baseRunDir), loadRunDir(headRunDir)]);
    const message =
      "run 0007 records source 'webdriverio', which this version does not recognise — treated as " +
      "'replay'; known sources: replay, e2e";
    expect(headLoad.warnings).toEqual([message]);
    expect(baseLoad.warnings).toEqual([]);

    const { result } = await diffRuns(
      baseLoad.run,
      headLoad.run,
      defaultDiffOptions({ deviceScaleFactor: 1 }),
      [...baseLoad.warnings, ...headLoad.warnings],
    );

    // Said once, by the reader that made the assumption, and not again by the labeller.
    expect(result.warnings).toEqual([message]);
    expect((result as SourceAwareDiffResult).sources).toEqual(REPLAY_PAIR);
    // And the normalised meta carries a source every consumer can name.
    expect((result.headMeta as MaybeE2e).source).toBe(SOURCE_REPLAY);
  });

  it('marks every finding of an ingested pair as lacking property-level detail (§4)', async () => {
    const result = await diffOf(E2E, E2E, 40);
    const findings = result.steps.flatMap((step) => [
      ...step.findings,
      ...Object.values(step.viewports).flatMap((vp) => vp.findings),
    ]);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(finding.reasons).toContain(DEGRADED_REASON);
    // Appended last, so it never displaces the heuristic that actually fired.
    for (const finding of findings) {
      expect(finding.reasons[finding.reasons.length - 1]).toBe(DEGRADED_REASON);
      expect(finding.reasons.length).toBeGreaterThan(1);
    }
  });

  it('marks a mixed pair too, and leaves a replay pair’s findings untouched', async () => {
    const mixed = await diffOf({}, E2E, 40);
    const replay = await diffOf({}, {}, 40);
    const reasonsOf = (result: SourceAwareDiffResult): string[] =>
      result.steps.flatMap((step) =>
        Object.values(step.viewports).flatMap((vp) => vp.findings.flatMap((f) => f.reasons)),
      );
    expect(reasonsOf(mixed)).toContain(DEGRADED_REASON);
    expect(reasonsOf(replay)).not.toContain(DEGRADED_REASON);
    expect(reasonsOf(replay).length).toBeGreaterThan(0);
  });
});

/*
 * The half of §4 that is easy to get wrong. A trace has no computed styles and no accessibility
 * tree, so on a *mixed* pair the replay side has both and the ingested side has neither — and a
 * node diff that does not know this reports every style property as changing to "" and every named
 * element as having lost its accessible name, at high severity. Every one of those findings would
 * be an artefact of the capture, sitting directly beneath a note saying property-level findings are
 * unavailable.
 */
describe('property-level findings on a degraded pair (§4)', () => {
  const options = defaultDiffOptions({ deviceScaleFactor: 1 });

  /** A pair whose head shot has no styles and no accessible name — what an ingested run looks like. */
  async function diffOfStyled(head: MaybeE2e): Promise<DiffResult> {
    const vdiffDir = await tempVdiff();
    const rect = { x: 10, y: 10, w: 60, h: 40 };
    const withStyles = domNode({
      path: 'html>body>button',
      rect,
      tag: 'button',
      role: 'button',
      name: 'Pay now',
      styles: { color: 'rgb(15, 23, 42)', backgroundColor: 'rgb(255, 255, 255)' },
    });
    const withoutStyles = domNode({ path: 'html>body>button', rect, tag: 'button' });

    const shot = (nodes: typeof withStyles[], changed: boolean): FixtureRun['steps'][number] => ({
      id: 'forecast',
      spec: { goto: '/' },
      shots: [
        {
          viewport: '1280x800',
          image: (() => {
            const image = solidImage(120, 120, WHITE);
            if (changed) paintRect(image, { x: 10, y: 10, w: 60, h: 40 }, RED);
            return image;
          })(),
          nodes,
        },
      ],
    });

    const baseRunDir = path.join(vdiffDir, 'runs', 'forecast', '0003');
    const headRunDir = path.join(vdiffDir, 'runs', 'forecast', '0007');
    await writeRunFixture(baseRunDir, {
      runId: '0003',
      flow: 'forecast',
      steps: [shot([withStyles], false)],
      meta: { revision: REV_1 },
    });
    await writeRunFixture(headRunDir, {
      runId: '0007',
      flow: 'forecast',
      steps: [shot([withoutStyles], true)],
      meta: { revision: REV_1, ...head },
    });
    return computeDiff({ baseRunDir, headRunDir, vdiffDir, options });
  }

  it('reports the style and accessible-name changes when both runs are replays', async () => {
    const result = await diffOfStyled({});
    const findings = result.steps.flatMap((step) =>
      Object.values(step.viewports).flatMap((vp) => vp.findings),
    );
    expect(findings.some((f) => f.kind === 'style')).toBe(true);
    expect(findings.some((f) => f.reasons.includes('lost-accessible-name'))).toBe(true);
  });

  it('reports neither when one side was ingested and never recorded them', async () => {
    const result = await diffOfStyled(E2E);
    const findings = result.steps.flatMap((step) =>
      Object.values(step.viewports).flatMap((vp) => vp.findings),
    );
    expect(findings.some((f) => f.kind === 'style')).toBe(false);
    expect(findings.some((f) => f.reasons.includes('lost-accessible-name'))).toBe(false);
    for (const finding of findings) {
      expect(finding.changes.map((c) => c.prop)).not.toContain('color');
      expect(finding.changes.map((c) => c.prop)).not.toContain('name');
    }
    // The region is still reported, and still attributed: §4's "which region changed and which
    // element is responsible" is what survives the degradation.
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.region !== undefined && f.element !== undefined)).toBe(true);
  });

  it('keeps the attribute changes a trace snapshot genuinely records', () => {
    const kept = withoutUnbackedChanges([
      {
        kind: 'attr',
        key: 'k',
        keyKind: 'path',
        base: null,
        head: null,
        changes: [
          { prop: 'name', from: 'Pay now', to: null },
          { prop: 'data-test', from: 'pay', to: 'pay-now' },
        ],
      },
      {
        kind: 'style',
        key: 'k',
        keyKind: 'path',
        base: null,
        head: null,
        changes: [{ prop: 'color', from: 'rgb(15, 23, 42)', to: '' }],
      },
      {
        kind: 'text',
        key: 'k',
        keyKind: 'path',
        base: null,
        head: null,
        changes: [{ prop: 'text', from: 'Pay', to: 'Pay now' }],
      },
    ]);

    expect(kept.map((change) => change.kind)).toEqual(['attr', 'text']);
    expect(kept[0]?.changes).toEqual([{ prop: 'data-test', from: 'pay', to: 'pay-now' }]);
  });
});

describe('e2e noise settings (§5, D27)', () => {
  const options = defaultDiffOptions({ deviceScaleFactor: 1 });

  it('states the provisional defaults in exactly one place', () => {
    expect(E2E_DIFF_DEFAULTS).toEqual({ minRegionArea: 256, antialiasTolerance: 0.25 });
    // Both are raised relative to replay, which is the whole of §5's table.
    expect(E2E_DIFF_DEFAULTS.minRegionArea).toBeGreaterThan(options.minRegionArea);
    expect(E2E_DIFF_DEFAULTS.antialiasTolerance).toBeGreaterThan(options.antialiasTolerance);
  });

  it('leaves a replay pair’s options untouched, by reference', () => {
    const resolved = resolveDiffOptions(options, meta({ runId: '0003' }), meta());
    expect(resolved.e2e).toBe(false);
    expect(resolved.options).toBe(options);
    expect(resolved.warnings).toEqual([]);
  });

  it('applies the e2e settings when either side was ingested', () => {
    for (const [base, head] of [
      [meta({ runId: '0003', ...E2E }), meta(E2E)],
      [meta({ runId: '0003' }), meta(E2E)],
      [meta({ runId: '0003', ...E2E }), meta()],
    ] as Array<[RunMeta, RunMeta]>) {
      const resolved = resolveDiffOptions(options, base, head);
      expect(resolved.e2e).toBe(true);
      expect(resolved.options.minRegionArea).toBe(E2E_DIFF_DEFAULTS.minRegionArea);
      expect(resolved.options.antialiasTolerance).toBe(E2E_DIFF_DEFAULTS.antialiasTolerance);
    }
  });

  it('lets a project override them under `e2e:`, which is what makes them tunable', () => {
    const resolved = resolveDiffOptions(
      { ...options, e2e: { minRegionArea: 900, antialiasTolerance: 0.4 } },
      meta({ runId: '0003', ...E2E }),
      meta(E2E),
    );
    expect(resolved.options.minRegionArea).toBe(900);
    expect(resolved.options.antialiasTolerance).toBe(0.4);
    expect(resolved.warnings).toEqual([]);
  });

  it('names an unusable override rather than applying it silently', () => {
    const { settings, warnings } = e2eNoiseSettings({
      minRegionArea: -5,
      antialiasTolerance: 3,
    });
    expect(warnings).toEqual([
      'e2e.minRegionArea must be a non-negative integer, got -5 — using the default 256',
      'e2e.antialiasTolerance must be a number between 0 and 1, got 3 — using the default 0.25',
    ]);
    expect(settings).toEqual(E2E_DIFF_DEFAULTS);
  });

  it('reports an unusable override through the diff’s warnings, once', async () => {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(vdiffDir, E2E, E2E);
    const result = (await computeDiff({
      baseRunDir,
      headRunDir,
      vdiffDir,
      options: { ...options, e2e: { antialiasTolerance: 'loose' as unknown as number } },
    })) as SourceAwareDiffResult;

    expect(result.warnings).toEqual([
      'e2e.antialiasTolerance must be a number between 0 and 1, got "loose" — using the default 0.25',
    ]);
  });

  it('appends the map’s ignore list, and appending twice is appending once', () => {
    const withIgnore = { ...options, ignore: ['.clock'], e2e: { ignore: ['.clock', '.spinner'] } };
    const once = resolveDiffOptions(withIgnore, meta({ runId: '0003', ...E2E }), meta(E2E));
    expect(once.options.ignore).toEqual(['.clock', '.spinner']);

    const twice = resolveDiffOptions(
      { ...once.options, e2e: withIgnore.e2e },
      meta({ runId: '0003', ...E2E }),
      meta(E2E),
    );
    expect(twice.options.ignore).toEqual(['.clock', '.spinner']);
  });

  it('drops a change an ingested pair cannot vouch for, and keeps it for a replay pair', async () => {
    // 10×10 = 100 image px: above the replay floor of 64, below the e2e floor of 256.
    const diffOf = async (side: MaybeE2e): Promise<DiffResult> => {
      const vdiffDir = await tempVdiff();
      const { baseRunDir, headRunDir } = await writePair(vdiffDir, side, side, 10);
      return computeDiff({ baseRunDir, headRunDir, vdiffDir, options });
    };
    const replay = await diffOf({});
    const ingested = await diffOf(E2E);

    expect(replay.summary.totalFindings).toBeGreaterThan(0);
    expect(ingested.summary.totalFindings).toBe(0);
    // And the pixels were compared either way: this is a threshold, not a skipped comparison.
    const ratioOf = (r: DiffResult): number => r.summary.maxPixelChangedRatio;
    expect(ratioOf(ingested)).toBeCloseTo(ratioOf(replay), 10);
    expect(ratioOf(ingested)).toBeGreaterThan(0);
  });
});

describe('the diff cache on the source axis', () => {
  const options = defaultDiffOptions({ deviceScaleFactor: 1 });

  const identity = (overrides: Partial<PairSources> = {}): PairSources => ({
    ...REPLAY_PAIR,
    ...overrides,
  });

  it('keys a replay pair exactly as it did before the axis existed', () => {
    expect(diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR)).toBe(
      diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR, REPLAY_PAIR),
    );
    expect(diffConfigFingerprint(options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR)).toBe(
      diffConfigFingerprint(options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR, REPLAY_PAIR),
    );
  });

  it('gives the same two run ids a different key once a side is ingested', () => {
    const replay = diffCacheKey('0003', '0007', options);
    const mixed = diffCacheKey(
      '0003',
      '0007',
      options,
      SCENARIOLESS_PAIR,
      VARIANTLESS_PAIR,
      identity({
        head: SOURCE_E2E,
        crossSource: true,
        fidelity: { level: 'degraded', missing: [...DEGRADED_CAPTURES], note: 'x' },
      }),
    );
    expect(mixed).not.toBe(replay);
  });

  it('distinguishes the two sides, so a swapped mixed pair is not a hit', () => {
    const degraded = { level: 'degraded' as const, missing: [...DEGRADED_CAPTURES], note: 'x' };
    expect(
      diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR, identity({ base: SOURCE_E2E, crossSource: true, fidelity: degraded })),
    ).not.toBe(
      diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR, identity({ head: SOURCE_E2E, crossSource: true, fidelity: degraded })),
    );
  });

  it('reads a stored replay diff as a miss for an ingested pair, never as unlabelled', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vdiff-e2e-cache-'));
    dirs.push(dir);
    const stored = {
      pair: { base: '0003', head: '0007' },
      cacheKey: diffCacheKey('0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR, REPLAY_PAIR),
    } as unknown as DiffResult & { cacheKey?: string };
    await writeFile(path.join(dir, 'findings.json'), `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

    const ingested = identity({
      base: SOURCE_E2E,
      head: SOURCE_E2E,
      fidelity: { level: 'degraded', missing: [...DEGRADED_CAPTURES], note: 'x' },
    });
    expect(
      isCacheHit(stored, '0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR, ingested),
    ).toBe(false);
    expect(
      await readCachedDiff(dir, '0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR, ingested),
    ).toBeNull();
    // Unchanged identity still hits, so the stricter key costs nothing when nothing moved.
    expect(
      await readCachedDiff(dir, '0003', '0007', options, SCENARIOLESS_PAIR, VARIANTLESS_PAIR, REPLAY_PAIR),
    ).not.toBeNull();
  });

  /*
   * The reason the source key is not redundant with the source *names*: it also decides the
   * thresholds. A stored diff computed under the replay floor must not be served for a pair that is
   * now ingested and would be computed under a floor four times larger.
   */
  it('recomputes rather than serving a stored diff whose source identity has changed', async () => {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(vdiffDir, {}, {}, 10);
    const request = { baseRunDir, headRunDir, vdiffDir, options };

    const first = (await computeDiff(request)) as SourceAwareDiffResult;
    expect(first.sources).toEqual(REPLAY_PAIR);
    expect(first.summary.totalFindings).toBeGreaterThan(0);

    // Same run ids, same revision, same pixels: only where the runs came from changes.
    await writeRunFixture(baseRunDir, { ...runFixture('0003'), meta: { revision: REV_1, ...E2E } });
    await writeRunFixture(headRunDir, {
      ...runFixture('0007', 10),
      meta: { revision: REV_1, ...E2E },
    });

    const second = (await computeDiff(request)) as SourceAwareDiffResult;
    expect(second.sources?.base).toBe(SOURCE_E2E);
    expect(second.sources?.fidelity.level).toBe('degraded');
    expect(second.summary.totalFindings).toBe(0);

    const storedRaw = JSON.parse(
      await readFile(path.join(vdiffDir, 'diffs', 'forecast', '0003..0007', 'findings.json'), 'utf8'),
    ) as SourceAwareDiffResult & { cacheKey?: string };
    expect(storedRaw.sources?.fidelity.missing).toEqual([...DEGRADED_CAPTURES]);
    // Stamped under the *resolved* options, so retuning `e2e:` invalidates exactly these diffs.
    expect(storedRaw.cacheKey).toBe(
      diffCacheKey(
        '0003',
        '0007',
        { ...options, ...E2E_DIFF_DEFAULTS },
        SCENARIOLESS_PAIR,
        VARIANTLESS_PAIR,
        storedRaw.sources as PairSources,
      ),
    );
  });

  it('still hits when nothing on the source axis moved', async () => {
    const vdiffDir = await tempVdiff();
    const { baseRunDir, headRunDir } = await writePair(vdiffDir, E2E, E2E, 40);
    const request = { baseRunDir, headRunDir, vdiffDir, options };

    const first = await computeDiff(request);
    const second = await computeDiff(request);
    expect(second.computedAt).toBe(first.computedAt);
  });
});
