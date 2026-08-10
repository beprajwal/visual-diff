/**
 * `config.yaml` → the engine, on the source axis (e2e spec §5, D27).
 *
 * Two documented features were inert in this slice, and both are the same failure: the user reads
 * the documentation, writes the setting, and is covered by nothing.
 *
 * 1. **`e2e:` was unreachable.** The block is §5's only tuning mechanism, and the config schema
 *    rejected it, so following the spec produced a hard exit-2 config error. Parsing it is not
 *    enough to call that fixed — a threshold that parses and never reaches `pixelmatch` is the same
 *    no-op with a friendlier error — so every test here asserts a *finding count*, through
 *    `computeDiff`, on run directories written to the real §6 layout.
 *
 * 2. **`ignore` could never mask an ingested run.** The measurement is at the bottom of this file
 *    and it is the reason `e2e-map.yaml` refuses the key: the identical selector that suppresses a
 *    finding on a replay pair suppresses nothing on the same pair ingested, because masking
 *    subtracts a matched node's rect and an ingested node's rect is `0×0`.
 *
 * The e2e side is built from `e2e/to-shots.ts`'s own constants rather than from zeroes typed here,
 * so if ingestion ever learns to carry geometry these tests change with it rather than fossilising
 * a limitation that has been lifted.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { UNAVAILABLE_RECT } from '../e2e/to-shots.js';
import { parseConfigSource } from '../store/config.js';
import type { NoiseAwareConfig } from '../store/config.js';
import { SOURCE_E2E } from '../store/internal/e2e.js';
import * as paths from '../store/paths.js';
import type { DiffResult, DomNode, Rect } from '../types.js';
import { computeDiff as computeDiffAtEdge, vdiffDirOf } from './edge.js';
import { diffOptionsFromConfig, e2eNoiseOf, E2E_DIFF_DEFAULTS } from './e2e-noise.js';
import type { E2eAwareDiffOptions } from './e2e-noise.js';
import { computeDiff, defaultDiffOptions } from './engine.js';
import { domNode, paintRect, solidImage, writeRunFixture } from './testkit.js';

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const RED: [number, number, number, number] = [220, 30, 30, 255];

/** 20×20 = 400 image px: above the e2e floor of 256, and well above the replay floor of 64. */
const BIG: Rect = { x: 10, y: 10, w: 20, h: 20 };
/** 10×10 = 100 image px: above the replay floor, below the e2e floor. */
const SMALL: Rect = { x: 10, y: 10, w: 10, h: 10 };

const MINIMAL_CONFIG = [
  'app:',
  '  dev: pnpm dev --port $PORT',
  '  readyOn: http://localhost:$PORT/',
].join('\n');

const temps: string[] = [];

afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tempVdiff(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vdiff-e2e-config-'));
  temps.push(dir);
  return dir;
}

/** A config as a project would actually get one: parsed from YAML, not hand-built. */
function configFrom(...lines: string[]): NoiseAwareConfig {
  const result = parseConfigSource(
    [MINIMAL_CONFIG, ...lines].join('\n'),
    '/project/.visual-diff/config.yaml',
    '/project',
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

interface PairInput {
  /** True to build both sides as a trace ingest would: `source: 'e2e'`, and no box metrics. */
  ingested: boolean;
  /** The block of pixels that differs between base and head. */
  changed: Rect;
  /** Selectors the engine is told to ignore. */
  ignore?: string[];
  /** The `e2e:` overrides, as a config carries them. */
  config?: NoiseAwareConfig;
}

/**
 * Writes a two-run pair whose head differs from its base by one painted block, covered by one
 * `[data-test="clock"]` element, and returns the diff.
 */
async function diffPair(input: PairInput): Promise<DiffResult> {
  const vdiffDir = await tempVdiff();
  // The whole of the difference between the two sides: an ingested node knows *what* it is and not
  // *where* it is. Everything else about the fixture is identical.
  const rect: Rect = input.ingested ? { ...UNAVAILABLE_RECT } : input.changed;
  const node: DomNode = domNode({
    path: 'html>body>div',
    rect,
    attrs: { 'data-test': 'clock' },
    testId: 'clock',
  });

  const write = async (runId: string, painted: boolean): Promise<string> => {
    const image = solidImage(60, 60, WHITE);
    if (painted) paintRect(image, input.changed, RED);
    const dir = path.join(vdiffDir, 'runs', 'checkout', runId);
    await writeRunFixture(dir, {
      runId,
      meta: input.ingested ? { source: SOURCE_E2E } : {},
      steps: [{ id: 'open', shots: [{ viewport: '1280x800', image, nodes: [node] }] }],
    });
    return dir;
  };

  const options: E2eAwareDiffOptions = diffOptionsFromConfig(input.config ?? configFrom(), {
    deviceScaleFactor: 1,
    ...(input.ignore === undefined ? {} : { ignore: input.ignore }),
  });

  return computeDiff({
    baseRunDir: await write('0001', false),
    headRunDir: await write('0002', true),
    vdiffDir,
    options,
  });
}

describe('the `e2e:` config block reaches the engine (§5)', () => {
  it('builds engine options a caller cannot accidentally strip the block out of', () => {
    const config = configFrom('e2e:', '  minRegionArea: 900', '  antialiasTolerance: 0.4');
    const options = diffOptionsFromConfig(config);
    expect(options.e2e).toEqual({ minRegionArea: 900, antialiasTolerance: 0.4 });
    // The replay knobs are still the `diff:` ones: `e2e:` overrides at diff time, per pair.
    expect(options.minRegionArea).toBe(config.diff.minRegionArea);
    expect(options.antialiasTolerance).toBe(config.diff.antialiasTolerance);
  });

  it('reads no block from a config that has none, rather than inventing an empty one', () => {
    expect(diffOptionsFromConfig(configFrom()).e2e).toBeUndefined();
    expect(e2eNoiseOf(configFrom())).toBeUndefined();
    expect(e2eNoiseOf({ diff: {} })).toBeUndefined();
    expect(e2eNoiseOf(undefined)).toBeUndefined();
    // A config written by hand, or off disk, may carry anything. Nonsense is *no overrides*, not a
    // crash and not a silently applied garbage threshold.
    expect(e2eNoiseOf({ e2e: 'loose' })).toBeUndefined();
    expect(e2eNoiseOf({ e2e: [256] })).toBeUndefined();
  });

  it('applies the documented default when the project says nothing', async () => {
    // 100 image px: reported for a replay pair, dropped for an ingested one by the e2e floor of 256.
    const replay = await diffPair({ ingested: false, changed: SMALL });
    const ingested = await diffPair({ ingested: true, changed: SMALL });
    expect(replay.summary.totalFindings).toBeGreaterThan(0);
    expect(ingested.summary.totalFindings).toBe(0);
    expect(E2E_DIFF_DEFAULTS.minRegionArea).toBeGreaterThan(100);
  });

  it('lowering `e2e.minRegionArea` brings back a change the default suppressed', async () => {
    const config = configFrom('e2e:', '  minRegionArea: 64');
    const tuned = await diffPair({ ingested: true, changed: SMALL, config });
    // The same pair that produced nothing above now produces a finding, and it is the *config* that
    // did it. This is the assertion the whole block exists for.
    expect(tuned.summary.totalFindings).toBeGreaterThan(0);
  });

  it('raising `e2e.minRegionArea` suppresses a change the default reported', async () => {
    const byDefault = await diffPair({ ingested: true, changed: BIG });
    expect(byDefault.summary.totalFindings).toBeGreaterThan(0);

    const raised = await diffPair({
      ingested: true,
      changed: BIG,
      config: configFrom('e2e:', '  minRegionArea: 900'),
    });
    expect(raised.summary.totalFindings).toBe(0);
    // Still compared, not skipped: the pixels moved either way, the threshold decided what to say
    // about them.
    expect(raised.summary.maxPixelChangedRatio).toBeCloseTo(byDefault.summary.maxPixelChangedRatio, 10);
    expect(raised.summary.maxPixelChangedRatio).toBeGreaterThan(0);
  });

  it('leaves a replay pair alone, however the e2e block is tuned', async () => {
    const config = configFrom('e2e:', '  minRegionArea: 100000', '  antialiasTolerance: 1');
    const tuned = await diffPair({ ingested: false, changed: BIG, config });
    const untuned = await diffPair({ ingested: false, changed: BIG });
    // §1: "nothing about `vdiff run` changes". A setting that leaked into replay diffs would be a
    // silent behaviour change for every project that never asked for e2e mode.
    expect(tuned.summary.totalFindings).toBe(untuned.summary.totalFindings);
    expect(tuned.summary.totalFindings).toBeGreaterThan(0);
  });
});

/**
 * The block reaching the engine through the *edge* — `diff/index.ts#computeDiff`, which is what
 * `cli/ports.ts` and `report/server/deps.ts` both resolve to.
 *
 * This is the part that was actually broken. Every caller assembled `DiffEngineOptions` field by
 * field from `config.diff`, so the `e2e:` block had no route to the engine even once the schema
 * accepted it. These tests use the real §6 project layout — a `config.yaml` on disk, runs under
 * `.visual-diff/runs/<flow>/<runId>` — and pass the options a caller that has never heard of the
 * block would pass.
 */
describe('a project’s config.yaml reaches the engine through the diff edge', () => {
  /** A whole project on disk: `.visual-diff/config.yaml` plus a two-run pair. */
  async function project(configLines: string[], changed: Rect): Promise<{ head: string; base: string }> {
    const root = await tempVdiff();
    await mkdir(paths.vdiffDir(root), { recursive: true });
    await writeFile(paths.configFile(root), [MINIMAL_CONFIG, ...configLines].join('\n'));

    const node = domNode({ path: 'html>body>div', rect: { ...UNAVAILABLE_RECT } });
    const write = async (runId: string, painted: boolean): Promise<string> => {
      const image = solidImage(60, 60, WHITE);
      if (painted) paintRect(image, changed, RED);
      const dir = path.join(paths.vdiffDir(root), 'runs', 'checkout', runId);
      await writeRunFixture(dir, {
        runId,
        meta: { source: SOURCE_E2E },
        steps: [{ id: 'open', shots: [{ viewport: '1280x800', image, nodes: [node] }] }],
      });
      return dir;
    };
    return { base: await write('0001', false), head: await write('0002', true) };
  }

  /** What a caller that only knows `DiffEngineOptions` hands in — no `e2e` field anywhere. */
  const callerOptions = defaultDiffOptions({ deviceScaleFactor: 1 });

  it('derives the project root from the run directory it was handed', async () => {
    const { head } = await project([], BIG);
    expect(vdiffDirOf(head)).toBe(path.resolve(head, '..', '..', '..'));
    expect(path.basename(vdiffDirOf(head))).toBe(paths.VISUAL_DIFF_DIRNAME);
  });

  it('applies an `e2e:` override the caller never copied into its options', async () => {
    const { base, head } = await project(['e2e:', '  minRegionArea: 64'], SMALL);
    // 100 image px: below the e2e default of 256, above the 64 this project asked for.
    const result = await computeDiffAtEdge(base, head, callerOptions);
    expect(result.summary.totalFindings).toBeGreaterThan(0);
  });

  it('keeps the documented default for a project whose config says nothing about e2e', async () => {
    const { base, head } = await project([], SMALL);
    const result = await computeDiffAtEdge(base, head, callerOptions);
    expect(result.summary.totalFindings).toBe(0);
  });

  it('lets an explicit `e2e` on the options win over the file, and reads no file at all', async () => {
    // The project asks for 64; the caller — `diffOptionsFromConfig`, or a test — says 900. An edge
    // that overwrote the caller would make the option it was given a suggestion.
    const { base, head } = await project(['e2e:', '  minRegionArea: 64'], BIG);
    const result = await computeDiffAtEdge(base, head, {
      ...callerOptions,
      e2e: { minRegionArea: 900 },
    });
    expect(result.summary.totalFindings).toBe(0);
  });

  it('diffs normally when there is no config.yaml to read', async () => {
    const root = await tempVdiff();
    const node = domNode({ path: 'html>body>div', rect: { ...UNAVAILABLE_RECT } });
    const write = async (runId: string, painted: boolean): Promise<string> => {
      const image = solidImage(60, 60, WHITE);
      if (painted) paintRect(image, BIG, RED);
      const dir = path.join(root, '.visual-diff', 'runs', 'checkout', runId);
      await writeRunFixture(dir, {
        runId,
        meta: { source: SOURCE_E2E },
        steps: [{ id: 'open', shots: [{ viewport: '1280x800', image, nodes: [node] }] }],
      });
      return dir;
    };
    const result = await computeDiffAtEdge(await write('0001', false), await write('0002', true), callerOptions);
    expect(result.summary.totalFindings).toBeGreaterThan(0);
  });

  it('does not fail a diff over a config.yaml it cannot parse', async () => {
    // The CLI already loaded and rejected this file with exit 2 before any diff was asked for
    // (spec §9). Failing again here would turn a diff into a config command; the defaults stand.
    const { base, head } = await project(['e2e:', '  minRegionArea: ['], BIG);
    const result = await computeDiffAtEdge(base, head, callerOptions);
    expect(result.summary.totalFindings).toBeGreaterThan(0);
  });
});

describe('masking cannot be applied to an ingested run (§5, and why e2e-map refuses `ignore`)', () => {
  const CLOCK_SELECTOR = '[data-test="clock"]';

  it('suppresses the finding on a replay pair — the mechanism itself works', async () => {
    const seen = await diffPair({ ingested: false, changed: BIG });
    const masked = await diffPair({ ingested: false, changed: BIG, ignore: [CLOCK_SELECTOR] });
    expect(seen.summary.totalFindings).toBeGreaterThan(0);
    expect(masked.summary.totalFindings).toBe(0);
  });

  it('suppresses nothing on the same pair ingested, because the rect it would subtract is 0×0', async () => {
    const seen = await diffPair({ ingested: true, changed: BIG });
    const masked = await diffPair({ ingested: true, changed: BIG, ignore: [CLOCK_SELECTOR] });
    expect(seen.summary.totalFindings).toBeGreaterThan(0);
    // Identical, not merely non-zero: the selector matched the node and changed nothing at all.
    expect(masked.summary.totalFindings).toBe(seen.summary.totalFindings);
    // And it is geometry that is missing, not the match: the ingested node carries the attribute the
    // selector asks for, and no box to subtract.
    expect(UNAVAILABLE_RECT).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('raises no warning about the selector, because the selector is not the problem', async () => {
    const masked = await diffPair({ ingested: true, changed: BIG, ignore: [CLOCK_SELECTOR] });
    // `ignoreSelectorWarnings` covers selectors the matcher cannot *evaluate*. This one evaluates
    // fine and still masks nothing, which is why the refusal has to happen at the file that offers
    // the feature — `store/e2e-map.ts` — rather than here.
    expect(masked.warnings.filter((w) => w.includes('not supported'))).toEqual([]);
  });
});
