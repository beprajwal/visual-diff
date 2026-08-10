/**
 * Archives become runs (e2e spec §6, §7, §8, D26, D27) — the whole of §9's list that is not the
 * reader's.
 *
 * These tests build archives rather than reading the committed ones, for the reason the reader's own
 * tests do: the interesting cases here are *pairs* and *sequences* — the same archive twice, two
 * archives of one title, a batch large enough to hit retention — and a committed fixture can be one
 * of those things at a time. `fixtures/app/traces/` proves the reader handles what Playwright really
 * writes; this file proves what the store ends up holding.
 *
 * The frames are real JPEGs (`realJpeg`), not the header-only ones the reader's tests use, because
 * ingestion decodes every frame into the PNG the diff engine reads. An ingest test that could not
 * tell a decodable frame from an undecodable one would be testing the wrong half.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildConfig } from '../store/config.js';
import { openStore } from '../store/index.js';
import type { Config, RunMeta } from '../types.js';
import { ingestTraces, planIngest } from './ingest.js';
import type { E2eIngestRequest } from './ingest.js';
import {
  action,
  buildTraceArchive,
  contextOptions,
  frameSnapshot,
  realJpeg,
  screencastFrame,
} from './testkit.js';
import type { TraceLine } from './testkit.js';

/* ------------------------------------------------------------------ fixtures */

const WALL = 1_700_000_000_000;
const MONO = 100;
const epoch = (monotonic: number): number => WALL + (monotonic - MONO);

const PAGE = 'page@aaaa';
const SHOT_ONE = `${PAGE}-1700000000200.jpeg`;
const SHOT_TWO = `${PAGE}-1700000000400.jpeg`;

const TITLE = 'weather.spec.ts:12 › weather dashboard › shows the forecast';

const html = (label: string): unknown => [
  'HTML',
  {},
  ['HEAD', {}, ['TITLE', {}, 'Probe']],
  ['BODY', {}, ['H1', { id: 'title' }, 'Weather'], ['DIV', { 'data-testid': 'out' }, label]],
];

interface ArchiveInput {
  title?: string;
  /** Repeat the second step's title, which is what §8's duplicate-title notice is about. */
  duplicateTitles?: boolean;
  label?: string;
  colour?: readonly [number, number, number];
}

function archiveBytes(input: ArchiveInput = {}): Buffer {
  const title = input.title ?? TITLE;
  const label = input.label ?? 'idle';
  const secondTitle = input.duplicateTitles === true ? 'open the dashboard' : 'run the search';
  const events: TraceLine[] = [
    contextOptions({ title, wallTime: WALL, monotonicTime: MONO }),
    ...action({
      callId: 'call@8',
      class: 'Tracing',
      method: 'tracingGroup',
      title: 'open the dashboard',
      startTime: 110,
      endTime: 200,
    }),
    ...action({
      callId: 'call@10',
      class: 'Frame',
      method: 'goto',
      parentId: 'call@8',
      pageId: PAGE,
      params: { url: 'http://localhost:3000/' },
      startTime: 115,
      endTime: 190,
      afterSnapshot: 'after@call@10',
    }),
    frameSnapshot({
      callId: 'call@10',
      snapshotName: 'after@call@10',
      pageId: PAGE,
      html: html(label),
      timestamp: 189,
      wallTime: epoch(189),
      frameUrl: 'http://localhost:3000/',
    }),
    screencastFrame({ pageId: PAGE, sha1: SHOT_ONE, timestamp: 190, frameSwapWallTime: epoch(190) }),
    ...action({
      callId: 'call@16',
      class: 'Tracing',
      method: 'tracingGroup',
      title: secondTitle,
      startTime: 210,
      endTime: 400,
    }),
    ...action({
      callId: 'call@18',
      class: 'Frame',
      method: 'click',
      parentId: 'call@16',
      pageId: PAGE,
      params: { selector: '#go' },
      startTime: 215,
      endTime: 395,
      afterSnapshot: 'after@call@18',
    }),
    frameSnapshot({
      callId: 'call@18',
      snapshotName: 'after@call@18',
      pageId: PAGE,
      html: html(`${label}-2`),
      timestamp: 394,
      wallTime: epoch(394),
      frameUrl: 'http://localhost:3000/?q=oslo',
    }),
    screencastFrame({ pageId: PAGE, sha1: SHOT_TWO, timestamp: 396, frameSwapWallTime: epoch(396) }),
  ];

  const colour = input.colour ?? ([200, 210, 220] as const);
  return buildTraceArchive({
    prefixes: [{ prefix: 'trace', events, network: [] }],
    resources: {
      [`resources/${SHOT_ONE}`]: realJpeg(64, 48, colour),
      [`resources/${SHOT_TWO}`]: realJpeg(64, 48, colour, { y: 10, h: 8, colour: [220, 30, 30] }),
    },
  });
}

/* ------------------------------------------------------------------ harness */

const roots: string[] = [];

interface Project {
  config: Config;
  root: string;
  /** Write an archive into the project and return its absolute path. */
  archive(name: string, input?: ArchiveInput): Promise<string>;
}

async function project(
  retention: { keepRuns?: number; keepVariantRuns?: number; keepE2eRuns?: number } = {},
): Promise<Project> {
  const root = await mkdtemp(path.join(tmpdir(), 'vdiff-e2e-ingest-'));
  roots.push(root);
  const config = buildConfig(
    root,
    { app: { dev: 'noop', readyOn: 'http://localhost:1/' }, retention },
    1000,
  );
  return {
    config,
    root,
    async archive(name: string, input: ArchiveInput = {}): Promise<string> {
      const target = path.join(root, name);
      await writeFile(target, archiveBytes(input));
      return target;
    },
  };
}

function request(pattern: string, overrides: Partial<E2eIngestRequest> = {}): E2eIngestRequest {
  return { from: 'trace', pattern, cwd: '/', ...overrides };
}

async function metaOf(config: Config, flow: string, runId: string): Promise<RunMeta> {
  return openStore(config).readMeta(flow, runId);
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ planning (§6) */

describe('planIngest', () => {
  it('reports what would be ingested and writes nothing', async () => {
    const app = await project();
    const file = await app.archive('trace.zip');

    const plan = await planIngest(app.config, request(file));

    expect(plan.from).toBe('trace');
    expect(plan.archives).toHaveLength(1);
    const archive = plan.archives[0];
    expect(archive?.flow).toBe('weather-weather-dashboard-shows-the-forecast');
    expect(archive?.title).toBe(TITLE);
    expect(archive?.steps).toEqual(['open-the-dashboard', 'run-the-search']);
    expect(archive?.shots).toBe(2);
    expect(archive?.traceVersion).toBe(8);
    expect(archive?.alreadyIngested).toBe(false);
    expect(archive?.runId).toBeNull();
    expect(archive?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Not one byte: `vdiff e2e list` promises a preview, and the store has no runs directory at all.
    await expect(readdir(path.join(app.root, '.visual-diff'))).rejects.toThrow();
  });

  it('records the capture conditions the archive really carries, and nothing else', async () => {
    const app = await project();
    const plan = await planIngest(app.config, request(await app.archive('trace.zip')));
    expect(plan.archives[0]?.origin).toMatchObject({
      browser: 'chromium',
      playwrightVersion: '1.62.1',
      platform: 'darwin',
      traceVersion: 8,
      title: TITLE,
    });
    // Neither is in a trace archive at any version, so neither may appear here (§7).
    expect(plan.archives[0]?.origin.project).toBeUndefined();
    expect(plan.archives[0]?.origin.retry).toBeUndefined();
  });

  it('is empty for a pattern that named nothing, leaving the exit-2 message to the CLI', async () => {
    const app = await project();
    const plan = await planIngest(app.config, request(path.join(app.root, 'missing-*.zip')));
    expect(plan.archives).toEqual([]);
  });

  it('says an archive is already ingested rather than letting a re-run look like a no-op', async () => {
    const app = await project();
    const file = await app.archive('trace.zip');
    const report = await ingestTraces(app.config, request(file));

    const plan = await planIngest(app.config, request(file));
    expect(plan.archives[0]?.alreadyIngested).toBe(true);
    expect(plan.archives[0]?.runId).toBe(report.runs[0]?.runId);
  });
});

/* ------------------------------------------------------------------ ingesting (§6, §7) */

describe('ingestTraces', () => {
  it('writes a run whose meta records the source, the trace hash and an unknown revision', async () => {
    const app = await project();
    const file = await app.archive('trace.zip');

    const report = await ingestTraces(app.config, request(file));
    const run = report.runs[0];
    expect(run?.reused).toBe(false);
    expect(run?.flow).toBe('weather-weather-dashboard-shows-the-forecast');

    const meta = (await metaOf(app.config, run?.flow as string, run?.runId as string)) as RunMeta & {
      source: string;
      e2e: { traceHash: string; testTitle: string; titleKey: string; archive?: string };
    };
    expect(meta.source).toBe('e2e');
    expect(meta.e2e.traceHash).toBe(run?.hash);
    expect(meta.e2e.testTitle).toBe(TITLE);
    expect(meta.e2e.titleKey).toBe('weather.spec.ts › weather dashboard › shows the forecast');
    expect(meta.e2e.archive).toBe(file);
    // §7: a trace records no git metadata, so this is unknown rather than whatever is checked out.
    expect(meta.revision).toEqual({ sha: 'unknown', ref: null, dirty: false });
    expect(meta.scenario).toBe('none');
    expect(meta.status).toBe('ok');
    expect(meta.viewports).toEqual(['900x600']);
  });

  it('carries the unknown-revision warning on the run, where a reader of the timeline sees it', async () => {
    const app = await project();
    const report = await ingestTraces(app.config, request(await app.archive('trace.zip')));
    const meta = await metaOf(
      app.config,
      report.runs[0]?.flow as string,
      report.runs[0]?.runId as string,
    );
    const warning = meta.warnings.find((entry) => (entry.kind as string) === 'e2e-revision-unknown');
    expect(warning?.message).toBe(
      'revision unknown: a Playwright trace records no git metadata at any format version, so this' +
        ' run is not attributed to a commit rather than being attributed to the wrong one',
    );
  });

  it('writes every step as a PNG the diff engine can read, at the frame’s true size', async () => {
    const app = await project();
    const report = await ingestTraces(app.config, request(await app.archive('trace.zip')));
    const store = openStore(app.config);
    const loaded = await store.loadRun(report.runs[0]?.flow as string, report.runs[0]?.runId as string);

    expect(loaded.steps.map((step) => step.result.id)).toEqual([
      'open-the-dashboard',
      'run-the-search',
    ]);
    for (const step of loaded.steps) {
      const shot = step.shots['900x600'];
      expect(shot).toBeDefined();
      const bytes = await readFile(shot?.screenshotPath as string);
      // The PNG magic: everything downstream decodes with pngjs, so a JPEG here breaks every diff.
      expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(shot?.dom.nodes.length).toBeGreaterThan(0);
      // §4: no accessibility tree exists in a trace, at any version. The store writes the empty
      // snapshot it writes for any shot without one, so the *tree* is null rather than the file.
      expect(shot?.a11y?.root).toBeNull();
    }
  });

  it('produces one run for the same archive ingested twice (§6)', async () => {
    const app = await project();
    const file = await app.archive('trace.zip');

    const first = await ingestTraces(app.config, request(file));
    const second = await ingestTraces(app.config, request(file));

    expect(first.runs[0]?.reused).toBe(false);
    expect(second.runs[0]?.reused).toBe(true);
    expect(second.runs[0]?.runId).toBe(first.runs[0]?.runId);

    const store = openStore(app.config);
    expect(await store.listRunIds(first.runs[0]?.flow as string)).toEqual([
      first.runs[0]?.runId as string,
    ]);
  });

  it('is idempotent on content, not on path: the same bytes under a new name are the same run', async () => {
    const app = await project();
    const first = await ingestTraces(app.config, request(await app.archive('a.zip')));
    const second = await ingestTraces(app.config, request(await app.archive('b.zip')));
    expect(second.runs[0]?.reused).toBe(true);
    expect(second.runs[0]?.runId).toBe(first.runs[0]?.runId);
  });

  it('puts a second archive of the same test on the same flow, as the next run', async () => {
    const app = await project();
    const base = await ingestTraces(app.config, request(await app.archive('base.zip')));
    const head = await ingestTraces(
      app.config,
      request(await app.archive('head.zip', { label: 'ready', colour: [30, 40, 50] })),
    );

    expect(head.runs[0]?.flow).toBe(base.runs[0]?.flow);
    expect(await openStore(app.config).listRunIds(base.runs[0]?.flow as string)).toEqual([
      '0000',
      '0001',
    ]);
  });

  it('gives two different tests two different flows', async () => {
    const app = await project();
    const first = await ingestTraces(app.config, request(await app.archive('a.zip')));
    const second = await ingestTraces(
      app.config,
      request(await app.archive('b.zip', { title: 'search.spec.ts:4 › search › finds a place' })),
    );
    expect(second.runs[0]?.flow).not.toBe(first.runs[0]?.flow);
    expect(second.runs[0]?.flow).toBe('search-search-finds-a-place');
  });

  it('keeps a title on the flow it was first ingested into, whatever the derivation would give', async () => {
    const app = await project();
    const first = await ingestTraces(
      app.config,
      request(await app.archive('a.zip'), { flow: 'dashboard' }),
    );
    expect(first.runs[0]?.flow).toBe('dashboard');

    // Same title, no override this time: the flow index is what keeps the timeline together.
    const second = await ingestTraces(
      app.config,
      request(await app.archive('b.zip', { label: 'ready' })),
    );
    expect(second.runs[0]?.flow).toBe('dashboard');
  });

  it('ingests a batch in sorted order, so run ids do not depend on the filesystem', async () => {
    const app = await project();
    await app.archive('c.zip', { label: 'c', colour: [10, 10, 10] });
    await app.archive('a.zip', { label: 'a', colour: [20, 20, 20] });
    await app.archive('b.zip', { label: 'b', colour: [30, 30, 30] });

    const report = await ingestTraces(app.config, request(path.join(app.root, '*.zip')));
    expect(report.runs.map((run) => path.basename(run.path))).toEqual([
      'a.zip',
      'b.zip',
      'c.zip',
    ]);
    expect(report.runs.map((run) => run.runId)).toEqual(['0000', '0001', '0002']);
  });

  it('reports the duplicate-step-title notice as a run warning, once (§8)', async () => {
    const app = await project();
    const report = await ingestTraces(
      app.config,
      request(await app.archive('trace.zip', { duplicateTitles: true })),
    );
    expect(report.runs[0]?.steps).toEqual(['open-the-dashboard', 'open-the-dashboard-2']);

    const meta = await metaOf(
      app.config,
      report.runs[0]?.flow as string,
      report.runs[0]?.runId as string,
    );
    const warnings = meta.warnings.filter((entry) => (entry.kind as string) === 'e2e-step-title-duplicate');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      `1 step title repeats within "${TITLE}"; the repeats were numbered rather than merged: ` +
        '"open the dashboard" → open-the-dashboard-2',
    );
  });
});

/* ------------------------------------------------------------------ the map (D26, §8) */

describe('e2e-map.yaml', () => {
  async function withMap(app: Project, yaml: string): Promise<void> {
    const dir = path.join(app.root, '.visual-diff');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'e2e-map.yaml'), yaml);
  }

  it('pins a flow name and a step id, and the pins reach the store', async () => {
    const app = await project();
    await withMap(
      app,
      [
        'flows:',
        `  "${TITLE}": dashboard`,
        'steps:',
        `  "${TITLE}":`,
        '    "open the dashboard": landing',
        '',
      ].join('\n'),
    );

    const report = await ingestTraces(app.config, request(await app.archive('trace.zip')));
    expect(report.runs[0]?.flow).toBe('dashboard');
    expect(report.runs[0]?.steps).toEqual(['landing', 'run-the-search']);
    expect(report.unmatchedMapEntries).toEqual([]);

    const steps = await readdir(path.join(app.root, '.visual-diff/runs/dashboard/0000/steps'));
    expect(steps.sort()).toEqual(['landing', 'run-the-search']);
  });

  it('matches a pin written with the line number still in it, since keys are normalised', async () => {
    const app = await project();
    // The pin says `:99`; the archive says `:12`. D26 strips the location before keying, so this
    // must still match — a pin that silently stopped working after an unrelated edit is the exact
    // failure the normalisation exists to prevent.
    await withMap(
      app,
      ['flows:', '  "weather.spec.ts:99 › weather dashboard › shows the forecast": dashboard', ''].join('\n'),
    );
    const report = await ingestTraces(app.config, request(await app.archive('trace.zip')));
    expect(report.runs[0]?.flow).toBe('dashboard');
    expect(report.unmatchedMapEntries).toEqual([]);
  });

  it('lists a pin no trace carries, and records it as a run warning (§8)', async () => {
    const app = await project();
    await withMap(
      app,
      [
        'steps:',
        `  "${TITLE}":`,
        '    "read the weather report": report',
        '  "checkout.spec.ts › checkout › shows the cart":',
        '    "open the cart": cart',
        '',
      ].join('\n'),
    );

    const report = await ingestTraces(app.config, request(await app.archive('trace.zip')));
    expect(report.unmatchedMapEntries).toEqual([
      'weather.spec.ts › weather dashboard › shows the forecast › read the weather report',
      'checkout.spec.ts › checkout › shows the cart › open the cart',
    ]);

    const meta = await metaOf(
      app.config,
      report.runs[0]?.flow as string,
      report.runs[0]?.runId as string,
    );
    const warning = meta.warnings.find((entry) => (entry.kind as string) === 'e2e-map-unmatched');
    expect(warning?.message).toBe(
      'e2e-map.yaml pins 2 titles no ingested trace contains: ' +
        '"weather.spec.ts › weather dashboard › shows the forecast › read the weather report", ' +
        '"checkout.spec.ts › checkout › shows the cart › open the cart" — each pin is doing nothing',
    );
  });

  it('refuses a pinned flow name that could not be a directory, naming the file and the line', async () => {
    const app = await project();
    await withMap(app, ['flows:', `  "${TITLE}": ../escape`, ''].join('\n'));
    await expect(ingestTraces(app.config, request(await app.archive('trace.zip')))).rejects.toThrow(
      /flow "\.\.\/escape"/,
    );
  });
});

/* ------------------------------------------------------------------ retention (§7) */

describe('retention isolation', () => {
  it('never evicts a replay run however many archives are ingested', async () => {
    const app = await project({ keepRuns: 1, keepE2eRuns: 2 });
    const store = openStore(app.config);
    const flow = 'dashboard';

    // A replay run, written the way `vdiff run` writes one: the timeline bucket, already at its cap.
    const draft = await store.beginRun(flow);
    await draft.writeFlowSnapshot({
      version: 1,
      flow,
      viewports: ['900x600'],
      network: { mode: 'off' },
      steps: [{ id: 'home' }],
    });
    await draft.commit({
      flow,
      scenario: 'none',
      flowHash: 'sha256:0',
      revision: { sha: 'abc123', ref: 'main', dirty: false },
      mode: 'spawn',
      network: 'off',
      harHits: 0,
      harMisses: 0,
      viewports: ['900x600'],
      status: 'ok',
      failedSteps: [],
      env: {
        tool: '0.0.0',
        node: 'v20',
        playwright: '1.62.1',
        chromium: '151',
        os: 'darwin',
        deviceScaleFactor: 2,
      },
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      unstable: false,
      pinned: false,
      pruned: false,
      warnings: [],
    });

    for (const [index, colour] of ([[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4]] as const).entries()) {
      await ingestTraces(
        app.config,
        request(await app.archive(`t${index}.zip`, { label: `l${index}`, colour }), { flow }),
      );
    }

    const replay = await store.readMeta(flow, '0000');
    expect(replay.pruned).toBe(false);

    const e2eRuns = await store.listRuns(flow, { e2e: 'only' });
    expect(e2eRuns.map((run) => run.runId)).toEqual(['0001', '0002', '0003', '0004']);
    // keepE2eRuns is 2, so the two oldest ingested runs lost their blobs and the newest two kept
    // theirs — and the replay run in the other bucket was never a candidate.
    expect(e2eRuns.map((run) => run.pruned)).toEqual([true, true, false, false]);
  });
});
