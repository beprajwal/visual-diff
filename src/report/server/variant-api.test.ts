/**
 * The variant surface of the report server: the timeline's `variant` and `kept` columns, and
 * `GET /api/variant/:flow/:runId` read off a real store tree (variants spec §5, §7).
 *
 * A real directory rather than a fake store, for the same reason `attribution-api.test.ts` uses
 * one: the on-disk store *is* the interface between modules (spec §5), and what breaks here is a
 * path or a missing-file case rather than the fold, which is unit-tested in `variant.test.ts`.
 *
 * The route is deliberately the twin of `/api/attribution`, down to the error codes, so the two
 * axes of run identity are read the same way. Anything true of one and not the other is a bug in
 * one of them, and these assertions are what makes that checkable.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULTS, SCENARIO_NONE, type Config, type RunMeta } from '../../types.js';
import { VARIANT_NONE, type RunVariantAttribution, type VariantReportFile } from '../variant.js';
import { handleRuns, handleVariantAttribution } from './api.js';
import { HttpError } from './http.js';
import { startReportServer } from './server.js';
import { FsReportStore, toRunSummary } from './store-reader.js';

const dirs: string[] = [];

async function storeDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vdiff-report-variant-'));
  dirs.push(root);
  return join(root, '.visual-diff');
}

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function meta(runId: string, patch: Partial<RunMeta> & Record<string, unknown> = {}): RunMeta {
  return {
    runId,
    flow: 'forecast',
    scenario: SCENARIO_NONE,
    flowHash: 'sha256:0000',
    revision: { sha: 'abcdef0123', ref: 'main', dirty: false },
    mode: 'attach',
    network: 'replay',
    harHits: 4,
    harMisses: 0,
    viewports: ['1280x800'],
    status: 'ok',
    failedSteps: [],
    env: {
      tool: '0.1.0',
      node: 'v20.11.0',
      playwright: '1.49.0',
      chromium: '131',
      os: 'darwin-arm64',
      deviceScaleFactor: 2,
    },
    startedAt: '2026-08-10T10:00:00Z',
    finishedAt: '2026-08-10T10:00:20Z',
    unstable: false,
    pinned: false,
    pruned: false,
    warnings: [],
    ...patch,
  } as RunMeta;
}

/** Writes `runs/forecast/<runId>/` with a meta.json and, when given, a variant.json beside it. */
async function writeRun(
  dir: string,
  runId: string,
  runMeta: RunMeta,
  variant?: VariantReportFile,
): Promise<void> {
  const runDir = join(dir, 'runs', 'forecast', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'meta.json'), JSON.stringify(runMeta), 'utf8');
  if (variant !== undefined) {
    await writeFile(join(runDir, 'variant.json'), JSON.stringify(variant), 'utf8');
  }
}

/* ------------------------------------------------------------------ the timeline columns */

describe('toRunSummary — the variant columns (variants §5)', () => {
  it('carries the variant and the promotion flag through', () => {
    const row = toRunSummary(meta('0007', { variant: 'denser-forecast', kept: true }), null);
    expect(row.variant).toBe('denser-forecast');
    expect(row.kept).toBe(true);
  });

  /**
   * Every run recorded before this slice has no `variant` key at all. Reading one as anything but
   * `none` would badge the whole regression history as a set of proposals.
   */
  it('reads a meta.json written before the field existed as `none`, unpromoted', () => {
    const row = toRunSummary(meta('0001'), null);
    expect(row.variant).toBe(VARIANT_NONE);
    expect(row.kept).toBe(false);
  });

  it('treats a blank variant as an absence rather than as a variant named ""', () => {
    expect(toRunSummary(meta('0002', { variant: '  ' }), null).variant).toBe(VARIANT_NONE);
  });
});

describe('GET /api/runs/:flow', () => {
  it('reports each run’s variant, keeping run ids monotonic across variants', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0001', meta('0001'));
    await writeRun(dir, '0002', meta('0002', { variant: 'denser-forecast' }));
    await writeRun(dir, '0003', meta('0003', { variant: 'sidebar-upsell', kept: true }));

    const response = await handleRuns(new FsReportStore(dir), 'forecast');
    expect(
      response.runs.map((run) => [
        run.runId,
        (run as { variant?: string }).variant,
        (run as { kept?: boolean }).kept,
      ]),
    ).toEqual([
      ['0001', VARIANT_NONE, false],
      ['0002', 'denser-forecast', false],
      ['0003', 'sidebar-upsell', true],
    ]);
  });
});

/* ------------------------------------------------------------------ attribution */

describe('GET /api/variant/:flow/:runId (variants §7)', () => {
  it('folds variant.json into per-step, per-rule rows', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0007', meta('0007', { variant: 'denser-forecast' }), {
      variant: 'denser-forecast',
      file: '.visual-diff/variants/denser-forecast.yaml',
      rules: [
        { ruleId: 'tighter-cards', verb: 'style', outcome: 'applied', matched: 2, changed: 2, verified: 2 },
        { ruleId: 'hide-air-quality', verb: 'hide', outcome: 'applied', matched: 1, changed: 1, verified: 1 },
      ],
      elements: [
        {
          step: 'forecast',
          viewport: '1280x800',
          target: '[data-test=forecast-card]:nth-child(1)',
          ruleId: 'tighter-cards',
          verb: 'style',
        },
        {
          step: 'forecast',
          viewport: '1280x800',
          target: '[data-test=forecast-card]:nth-child(2)',
          ruleId: 'tighter-cards',
          verb: 'style',
        },
        {
          step: 'home',
          viewport: '1280x800',
          target: '[data-test=air-quality]',
          ruleId: 'hide-air-quality',
          verb: 'hide',
        },
      ],
    });

    const attribution = await handleVariantAttribution(new FsReportStore(dir), 'forecast', '0007');

    expect(attribution.flow).toBe('forecast');
    expect(attribution.runId).toBe('0007');
    expect(attribution.variant).toBe('denser-forecast');
    expect(attribution.steps.map((step) => step.step)).toEqual(['forecast', 'home']);
    expect(attribution.steps[0]?.rules).toEqual([
      {
        variant: 'denser-forecast',
        ruleId: 'tighter-cards',
        verb: 'style',
        elements: 2,
        viewports: ['1280x800'],
      },
    ]);
    expect(attribution.unmatchedRules).toEqual([]);
    expect(attribution.revertedRules).toEqual([]);
  });

  /** The D22 hazard, as the page has to be able to name it: applied, then re-rendered away. */
  it('reports which rules matched nothing and which were reverted before capture', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0008', meta('0008', { variant: 'denser-forecast' }), {
      variant: 'denser-forecast',
      file: '.visual-diff/variants/denser-forecast.yaml',
      rules: [
        { ruleId: 'hide-air-quality', verb: 'hide', outcome: 'unmatched', matched: 0, changed: 0, verified: 0 },
        { ruleId: 'chart-first', verb: 'order', outcome: 'reverted', matched: 3, changed: 3, verified: 0 },
      ],
      elements: [],
    });

    const attribution = await handleVariantAttribution(new FsReportStore(dir), 'forecast', '0008');
    expect(attribution.unmatchedRules).toEqual(['hide-air-quality']);
    expect(attribution.revertedRules).toEqual(['chart-first']);
  });

  it('answers with empty rows for a run captured without a variant', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0003', meta('0003'));

    const attribution = await handleVariantAttribution(new FsReportStore(dir), 'forecast', '0003');
    expect(attribution).toEqual({
      flow: 'forecast',
      runId: '0003',
      variant: VARIANT_NONE,
      steps: [],
      unmatchedRules: [],
      revertedRules: [],
    });
  });

  it('renders a run whose variant.json is unreadable rather than failing the page', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0009', meta('0009', { variant: 'denser-forecast' }));
    await writeFile(
      join(dir, 'runs', 'forecast', '0009', 'variant.json'),
      '{ not json',
      'utf8',
    );

    const attribution = await handleVariantAttribution(new FsReportStore(dir), 'forecast', '0009');
    expect(attribution.variant).toBe('denser-forecast');
    expect(attribution.steps).toEqual([]);
  });

  it('404s an unknown run rather than answering with an empty attribution', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0007', meta('0007'));

    await expect(
      handleVariantAttribution(new FsReportStore(dir), 'forecast', '0099'),
    ).rejects.toMatchObject({
      status: 404,
      code: 'unknown-run',
      message: 'No run 0099 in flow "forecast".',
    });
  });

  it('rejects a run id that is not a run number, and a flow name that is not a flow name', async () => {
    const store = new FsReportStore(await storeDir());

    await expect(handleVariantAttribution(store, 'forecast', '../etc')).rejects.toBeInstanceOf(
      HttpError,
    );
    await expect(handleVariantAttribution(store, 'forecast', '../etc')).rejects.toMatchObject({
      status: 400,
      code: 'bad-run-id',
      message: 'Run ids must be zero-padded numbers, got "../etc".',
    });
    await expect(handleVariantAttribution(store, '../etc', '0007')).rejects.toMatchObject({
      status: 400,
      code: 'bad-flow',
      message: '"../etc" is not a valid flow name.',
    });
  });
});

/* ------------------------------------------------------------------ the route itself */

/**
 * The route as an HTTP surface, not just a handler: `/api/variant/:flow/:runId` has to be reachable
 * through the same token gate as every other route, and a request that names no run must say what
 * the path should have looked like rather than 404 as "no such endpoint" (spec §9, D6).
 */
describe('GET /api/variant over the wire', () => {
  function config(dir: string): Config {
    return {
      root: dir.replace(/\/\.visual-diff$/, ''),
      dir,
      app: {
        install: 'npm ci',
        dev: 'npm run dev -- --port $PORT',
        readyOn: 'http://localhost:$PORT/',
        readyTimeoutMs: DEFAULTS.readyTimeoutMs,
      },
      diff: {
        minRegionArea: DEFAULTS.diff.minRegionArea,
        maxRegions: DEFAULTS.diff.maxRegions,
        antialiasTolerance: DEFAULTS.diff.antialiasTolerance,
        ignore: [...DEFAULTS.diff.ignore],
      },
      network: { redact: [...DEFAULTS.network.redact], scrub: DEFAULTS.network.scrub },
      retention: { keepRuns: DEFAULTS.retention.keepRuns },
    };
  }

  it('serves the attribution behind the session token, and states the shape of a bad path', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0007', meta('0007', { variant: 'denser-forecast' }), {
      variant: 'denser-forecast',
      file: '.visual-diff/variants/denser-forecast.yaml',
      rules: [
        { ruleId: 'tighter-cards', verb: 'style', outcome: 'applied', matched: 1, changed: 1, verified: 1 },
      ],
      elements: [
        {
          step: 'forecast',
          viewport: '1280x800',
          target: '[data-test=forecast-card]',
          ruleId: 'tighter-cards',
          verb: 'style',
        },
      ],
    });

    const server = await startReportServer({
      config: config(dir),
      sessionToken: 'tok',
      watch: false,
      writeServeInfo: false,
    });

    try {
      const url = `http://127.0.0.1:${server.info.port}`;

      const ok = await fetch(`${url}/api/variant/forecast/0007?token=tok`);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as RunVariantAttribution;
      expect(body.variant).toBe('denser-forecast');
      expect(body.steps[0]?.rules[0]?.ruleId).toBe('tighter-cards');

      const gated = await fetch(`${url}/api/variant/forecast/0007`);
      expect(gated.status).toBe(401);

      const badPath = await fetch(`${url}/api/variant/forecast?token=tok`);
      expect(badPath.status).toBe(400);
      expect(await badPath.json()).toMatchObject({
        error: 'bad-path',
        message: 'Expected /api/variant/<flow>/<runId>.',
      });

      const missing = await fetch(`${url}/api/variant/forecast/0099?token=tok`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({
        error: 'unknown-run',
        message: 'No run 0099 in flow "forecast".',
      });
    } finally {
      await server.close();
    }
  });
});
