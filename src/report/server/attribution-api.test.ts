/**
 * The scenario surface of the report server: the timeline's `scenario` column, the
 * `/api/attribution/:flow/:runId` route, and the reading of `network.json` off a real store tree.
 *
 * A real directory rather than a fake store, because the on-disk store *is* the interface between
 * modules (spec §5) and the thing most likely to break here is a path or a missing-file case, not
 * the fold — that is unit-tested in `attribution.test.ts`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SCENARIO_NONE, type NetworkEntry, type RunMeta } from '../../types.js';
import { handleAttribution, handleRuns } from './api.js';
import { HttpError } from './http.js';
import { FsReportStore, toRunSummary } from './store-reader.js';

const dirs: string[] = [];

async function storeDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vdiff-report-'));
  dirs.push(root);
  return join(root, '.visual-diff');
}

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function meta(runId: string, patch: Partial<RunMeta> = {}): RunMeta {
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
  };
}

function networkEntry(
  step: string,
  url: string,
  attribution?: NetworkEntry['attribution'],
): NetworkEntry {
  const entry: NetworkEntry = {
    step,
    viewport: '1280x800',
    method: 'GET',
    url,
    status: 200,
    resourceType: 'fetch',
    harMatch: 'hit',
    durationMs: 8,
  };
  if (attribution !== undefined) entry.attribution = attribution;
  return entry;
}

/** Writes `runs/forecast/<runId>/` with a meta.json and a network.json per named step. */
async function writeRun(
  dir: string,
  runId: string,
  runMeta: RunMeta,
  steps: Record<string, NetworkEntry[]> = {},
): Promise<void> {
  const runDir = join(dir, 'runs', 'forecast', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'meta.json'), JSON.stringify(runMeta), 'utf8');
  for (const [step, entries] of Object.entries(steps)) {
    const stepDir = join(runDir, 'steps', step);
    await mkdir(stepDir, { recursive: true });
    await writeFile(join(stepDir, 'network.json'), JSON.stringify(entries), 'utf8');
  }
}

/* ------------------------------------------------------------------ the timeline column */

describe('toRunSummary — the scenario column (mocking §6, §7)', () => {
  it('carries the scenario through', () => {
    expect(toRunSummary(meta('0007', { scenario: 'empty-forecast' }), null).scenario).toBe(
      'empty-forecast',
    );
  });

  it('reads a slice-1 meta.json written before the field existed as `none`', () => {
    // The cast is the point of the test: on disk the field is genuinely absent, and `RunMeta`
    // declares it required because in-memory code should never have to handle "unknown".
    const { scenario: _dropped, ...legacy } = meta('0001');
    expect(toRunSummary(legacy as RunMeta, null).scenario).toBe(SCENARIO_NONE);
  });
});

describe('GET /api/runs/:flow', () => {
  it('reports each run’s scenario, keeping run ids monotonic across scenarios', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0001', meta('0001'));
    await writeRun(dir, '0002', meta('0002', { scenario: 'empty-forecast' }));
    await writeRun(dir, '0003', meta('0003'));

    const response = await handleRuns(new FsReportStore(dir), 'forecast');
    expect(response.runs.map((run) => [run.runId, run.scenario])).toEqual([
      ['0001', SCENARIO_NONE],
      ['0002', 'empty-forecast'],
      ['0003', SCENARIO_NONE],
    ]);
  });
});

/* ------------------------------------------------------------------ attribution */

describe('GET /api/attribution/:flow/:runId (mocking §8)', () => {
  it('folds every step’s network.json into per-rule rows', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0007', meta('0007', { scenario: 'empty-forecast' }), {
      forecast: [
        networkEntry('forecast', 'https://api/v1/forecast', {
          scenario: 'empty-forecast',
          ruleId: 'forecast-empty',
          action: 'patch',
          bodyChanged: true,
        }),
        networkEntry('forecast', 'https://api/v1/units', {
          scenario: 'empty-forecast',
          ruleId: null,
          action: 'passthrough',
          bodyChanged: false,
        }),
      ],
      home: [
        networkEntry('home', 'https://api/analytics/hit', {
          scenario: 'empty-forecast',
          ruleId: 'no-analytics',
          action: 'abort',
          bodyChanged: false,
        }),
      ],
    });

    const attribution = await handleAttribution(new FsReportStore(dir), 'forecast', '0007');

    expect(attribution.flow).toBe('forecast');
    expect(attribution.runId).toBe('0007');
    expect(attribution.scenario).toBe('empty-forecast');
    // Steps are keyed by id and never by ordinal (spec §6), so they come back sorted by id.
    expect(attribution.steps.map((step) => step.step)).toEqual(['forecast', 'home']);
    expect(attribution.steps[0]?.rules).toEqual([
      {
        scenario: 'empty-forecast',
        ruleId: 'forecast-empty',
        action: 'patch',
        requests: 1,
        bodyChanged: 1,
        urls: ['https://api/v1/forecast'],
      },
    ]);
    expect(attribution.steps[0]?.passthroughs).toBe(1);
    expect(attribution.steps[1]?.rules[0]?.action).toBe('abort');
  });

  it('answers with empty rows for a run captured without a scenario', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0003', meta('0003'), {
      forecast: [networkEntry('forecast', 'https://api/v1/forecast')],
    });

    const attribution = await handleAttribution(new FsReportStore(dir), 'forecast', '0003');
    expect(attribution.scenario).toBe(SCENARIO_NONE);
    expect(attribution.steps).toEqual([
      { step: 'forecast', rules: [], passthroughs: 0, misses: 0 },
    ]);
  });

  it('reports mock-mode misses, which is the whole point of badging a mock run (D13)', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0009', meta('0009', { scenario: 'offline', network: 'mock' }), {
      home: [
        networkEntry('home', 'https://api/v1/forecast', {
          scenario: 'offline',
          ruleId: null,
          action: 'miss',
          bodyChanged: false,
        }),
      ],
    });

    const attribution = await handleAttribution(new FsReportStore(dir), 'forecast', '0009');
    expect(attribution.steps[0]?.misses).toBe(1);
  });

  it('skips a step whose network.json is missing or unreadable rather than failing the run', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0007', meta('0007', { scenario: 'empty-forecast' }));
    await mkdir(join(dir, 'runs', 'forecast', '0007', 'steps', 'home'), { recursive: true });
    await mkdir(join(dir, 'runs', 'forecast', '0007', 'steps', 'broken'), { recursive: true });
    await writeFile(
      join(dir, 'runs', 'forecast', '0007', 'steps', 'broken', 'network.json'),
      '{ not json',
      'utf8',
    );

    const attribution = await handleAttribution(new FsReportStore(dir), 'forecast', '0007');
    expect(attribution.steps).toEqual([]);
  });

  it('404s an unknown run rather than answering with an empty attribution', async () => {
    const dir = await storeDir();
    await writeRun(dir, '0007', meta('0007'));
    const store = new FsReportStore(dir);

    await expect(handleAttribution(store, 'forecast', '0099')).rejects.toMatchObject({
      status: 404,
      code: 'unknown-run',
      message: 'No run 0099 in flow "forecast".',
    });
  });

  it('rejects a run id that is not a run number, and a flow name that is not a flow name', async () => {
    const store = new FsReportStore(await storeDir());

    await expect(handleAttribution(store, 'forecast', '../etc')).rejects.toBeInstanceOf(HttpError);
    await expect(handleAttribution(store, 'forecast', '../etc')).rejects.toMatchObject({
      status: 400,
      code: 'bad-run-id',
    });
    await expect(handleAttribution(store, '../etc', '0007')).rejects.toMatchObject({
      status: 400,
      code: 'bad-flow',
    });
  });
});
