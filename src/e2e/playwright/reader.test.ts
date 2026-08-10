import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isE2eError } from '../errors.js';
import {
  action,
  buildTraceArchive,
  buildZip,
  consoleEvent,
  contextOptions,
  fakeJpeg,
  frameSnapshot,
  resourceSnapshot,
  screencastFrame,
  type TraceArchiveInput,
  type TraceLine,
} from '../testkit.js';
import { playwrightTraceReader } from './reader.js';

/* ------------------------------------------------------------------ fixtures */

const WALL = 1_700_000_000_000;
const MONO = 100;
/** Epoch milliseconds for a monotonic time under the clock the archives below declare. */
const epoch = (monotonic: number): number => WALL + (monotonic - MONO);

const PAGE = 'page@aaaa';
const SHOT_EARLY = `${PAGE}-1700000000200.jpeg`;
const SHOT_LATE = `${PAGE}-1700000000400.jpeg`;

const HTML_IDLE = [
  'HTML',
  {},
  ['HEAD', {}, ['TITLE', {}, 'Probe']],
  [
    'BODY',
    {},
    ['H1', { id: 'title' }, 'Weather'],
    ['DIV', { class: 'card', 'data-testid': 'out' }, 'idle'],
  ],
];

const HTML_READY = [
  'HTML',
  {},
  [[1, 2]],
  [
    'BODY',
    {},
    ['H1', { id: 'title' }, 'Weather'],
    ['DIV', { class: 'card', 'data-testid': 'out' }, 'ready'],
  ],
];

const LIBRARY_TITLE = 'weather.spec.ts:12 › weather › shows the forecast';

/** A library archive: one context, two `tracing.group()` steps, screenshots and snapshots on. */
function libraryEvents(): TraceLine[] {
  return [
    contextOptions({ title: LIBRARY_TITLE, wallTime: WALL, monotonicTime: MONO }),
    ...action({ callId: 'call@8', class: 'Tracing', method: 'tracingGroup', title: 'open the dashboard', startTime: 110, endTime: 200 }),
    ...action({
      callId: 'call@10',
      class: 'Frame',
      method: 'goto',
      parentId: 'call@8',
      pageId: PAGE,
      params: { url: 'http://localhost:3000/' },
      startTime: 115,
      endTime: 190,
      beforeSnapshot: 'before@call@10',
      afterSnapshot: 'after@call@10',
    }),
    frameSnapshot({ callId: 'call@10', snapshotName: 'before@call@10', pageId: PAGE, html: ['HTML', {}, ['HEAD', {}], ['BODY', {}]], timestamp: 116, wallTime: epoch(116) }),
    frameSnapshot({ callId: 'call@10', snapshotName: 'after@call@10', pageId: PAGE, html: HTML_IDLE, timestamp: 189, wallTime: epoch(189), frameUrl: 'http://localhost:3000/' }),
    screencastFrame({ pageId: PAGE, sha1: SHOT_EARLY, timestamp: 190, frameSwapWallTime: epoch(190) }),
    consoleEvent({ text: 'dashboard ready', time: 150, pageId: PAGE }),
    ...action({ callId: 'call@16', class: 'Tracing', method: 'tracingGroup', title: 'run the search', startTime: 210, endTime: 400 }),
    ...action({
      callId: 'call@18',
      class: 'Frame',
      method: 'click',
      parentId: 'call@16',
      pageId: PAGE,
      params: { selector: '#go' },
      startTime: 215,
      endTime: 395,
      beforeSnapshot: 'before@call@18',
      afterSnapshot: 'after@call@18',
    }),
    frameSnapshot({ callId: 'call@18', snapshotName: 'before@call@18', pageId: PAGE, html: [[1, 8]], timestamp: 216, wallTime: epoch(216) }),
    frameSnapshot({ callId: 'call@18', snapshotName: 'after@call@18', pageId: PAGE, html: HTML_READY, timestamp: 394, wallTime: epoch(394), frameUrl: 'http://localhost:3000/?q=oslo' }),
    screencastFrame({ pageId: PAGE, sha1: SHOT_LATE, timestamp: 396, frameSwapWallTime: epoch(396) }),
  ];
}

function libraryArchive(overrides: Partial<TraceArchiveInput> = {}): Buffer {
  return buildTraceArchive({
    prefixes: [
      {
        prefix: 'trace',
        events: libraryEvents(),
        network: [
          resourceSnapshot({ url: 'http://localhost:3000/', monotonicTime: 120, pageref: PAGE }),
          resourceSnapshot({ url: 'http://localhost:3000/api/forecast', monotonicTime: 300, pageref: PAGE, resourceType: 'fetch', status: 200 }),
        ],
      },
    ],
    resources: {
      [`resources/${SHOT_EARLY}`]: fakeJpeg(798, 532),
      [`resources/${SHOT_LATE}`]: fakeJpeg(798, 532, 64),
    },
    ...overrides,
  });
}

/**
 * A runner archive: `test.trace` with the hook/fixture/test.step tree, and one numbered library
 * prefix whose actions link into it through `stepId`.
 */
function runnerArchive(): Buffer {
  const runnerEvents: TraceLine[] = [
    contextOptions({ origin: 'testRunner', browserName: '', wallTime: WALL, monotonicTime: MONO }),
    ...action({ callId: 'hook@1', class: 'Test', method: 'hook', title: 'Before Hooks', stepId: 'hook@1', startTime: 100, endTime: 130 }),
    ...action({ callId: 'fixture@2', class: 'Test', method: 'fixture', title: 'Fixture "page"', stepId: 'fixture@2', parentId: 'hook@1', startTime: 101, endTime: 129 }),
    ...action({ callId: 'pw:api@3', class: 'Test', method: 'pw:api', title: 'Create page', stepId: 'pw:api@3', parentId: 'fixture@2', startTime: 102, endTime: 128 }),
    ...action({ callId: 'test.step@10', class: 'Test', method: 'test.step', title: 'run the search', stepId: 'test.step@10', startTime: 140, endTime: 260 }),
    ...action({ callId: 'test.step@20', class: 'Test', method: 'test.step', title: 'run the search', stepId: 'test.step@20', startTime: 300, endTime: 420 }),
    ...action({ callId: 'test.attach@30', class: 'Test', method: 'test.attach', title: 'Attach "note"', stepId: 'test.attach@30', startTime: 430, endTime: 431 }),
  ];

  const libraryEventsForRunner: TraceLine[] = [
    contextOptions({ title: LIBRARY_TITLE, wallTime: WALL, monotonicTime: MONO }),
    // Created by the `page` fixture: infrastructure, and not a step.
    ...action({ callId: 'call@4', class: 'BrowserContext', method: 'newPage', stepId: 'pw:api@3', pageId: PAGE, startTime: 103, endTime: 127 }),
    ...action({
      callId: 'call@12',
      class: 'Frame',
      method: 'fill',
      stepId: 'test.step@10',
      pageId: PAGE,
      params: { selector: '#q', value: 'oslo' },
      startTime: 145,
      endTime: 255,
      afterSnapshot: 'after@call@12',
    }),
    frameSnapshot({ callId: 'call@12', snapshotName: 'after@call@12', pageId: PAGE, html: HTML_IDLE, timestamp: 250, wallTime: epoch(250) }),
    screencastFrame({ pageId: PAGE, sha1: SHOT_EARLY, timestamp: 252, frameSwapWallTime: epoch(252) }),
    ...action({
      callId: 'call@22',
      class: 'Frame',
      method: 'click',
      stepId: 'test.step@20',
      pageId: PAGE,
      params: { selector: '#go' },
      startTime: 310,
      endTime: 415,
      afterSnapshot: 'after@call@22',
    }),
    frameSnapshot({ callId: 'call@22', snapshotName: 'after@call@22', pageId: PAGE, html: HTML_READY, timestamp: 410, wallTime: epoch(410) }),
    screencastFrame({ pageId: PAGE, sha1: SHOT_LATE, timestamp: 412, frameSwapWallTime: epoch(412) }),
  ];

  return buildTraceArchive({
    prefixes: [
      { prefix: '0-trace', events: libraryEventsForRunner, network: [] },
      { prefix: 'test', events: runnerEvents },
    ],
    resources: {
      [`resources/${SHOT_EARLY}`]: fakeJpeg(798, 532),
      [`resources/${SHOT_LATE}`]: fakeJpeg(798, 532, 64),
    },
  });
}

async function writeArchive(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vdiff-e2e-read-'));
  const target = path.join(dir, name);
  await writeFile(target, bytes);
  return target;
}

async function readError(file: string): Promise<{ message: string; code: string; exitCode: number; hint?: string }> {
  try {
    await playwrightTraceReader.read(file);
  } catch (error) {
    if (isE2eError(error)) return error;
    throw error;
  }
  throw new Error('expected the read to throw');
}

/* ------------------------------------------------------------------ tests */

describe('reading a library archive', () => {
  it('reports the capture conditions the trace recorded', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const ingest = await playwrightTraceReader.read(file);
    expect(ingest.format).toBe('playwright');
    expect(ingest.metadata).toMatchObject({
      tool: 'playwright',
      toolVersion: '1.62.1',
      formatVersion: 8,
      origin: 'library',
      browser: 'chromium',
      platform: 'darwin',
      viewport: { w: 900, h: 600 },
      deviceScaleFactor: 1,
    });
    expect(ingest.metadata.startedAt).toBe(new Date(WALL).toISOString());
  });

  it('names what a trace cannot provide, so the report can label the degraded diff', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const { capabilities } = await playwrightTraceReader.read(file);
    expect(capabilities.screenshots).toBe(true);
    expect(capabilities.domSnapshots).toBe(true);
    expect(capabilities.network).toBe(true);
    // Recorded unconditionally whenever tracing is active, unlike screenshots and network.
    expect(capabilities.console).toBe(true);
    expect(capabilities.computedStyles).toBe(false);
    expect(capabilities.accessibilityTree).toBe(false);
    expect(capabilities.elementGeometry).toBe(false);
    expect(capabilities.missing).toEqual([
      'computed-styles',
      'accessibility-tree',
      'element-geometry',
      'full-page-screenshots',
      // No git metadata exists in a trace at any version, so revision is never inferred.
      'revision',
      'project-name',
      'retry-index',
    ]);
  });

  it('derives one step per tracing group, keyed by the group title', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const [test] = (await playwrightTraceReader.read(file)).tests;
    expect(test?.steps.map((step) => step.id)).toEqual(['open-the-dashboard', 'run-the-search']);
    expect(test?.steps.map((step) => step.origin.titleSource)).toEqual(['group', 'group']);
    expect(test?.steps[1]?.origin.callId).toBe('call@16');
    expect(test?.steps[1]?.origin.selector).toBe('#go');
  });

  it('derives the flow from the title with its line number stripped', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const [test] = (await playwrightTraceReader.read(file)).tests;
    expect(test?.title).toBe(LIBRARY_TITLE);
    expect(test?.titleKey).toBe('weather.spec.ts › weather › shows the forecast');
    expect(test?.flow).toBe('weather-spec-ts-weather-shows-the-forecast');
    expect(test?.flowSource).toBe('derived');
    expect(test?.viewport).toBe('900x600');
  });

  it('reads each shot size from the JPEG, never from the screencast event', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const [test] = (await playwrightTraceReader.read(file)).tests;
    const shot = test?.steps[0]?.shot;
    // The event says 900x600, which is the logical viewport; the image is 798x532.
    expect(shot?.viewport).toEqual({ w: 900, h: 600 });
    expect(shot?.width).toBe(798);
    expect(shot?.height).toBe(532);
    expect(shot?.scale).toBe(0.8867);
    expect(shot?.encoding).toBe('jpeg');
    expect(shot?.resource).toBe(`resources/${SHOT_EARLY}`);
    expect(shot?.bytes.length).toBeGreaterThan(0);
  });

  it('records how far the chosen frame was from the step it illustrates', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const [test] = (await playwrightTraceReader.read(file)).tests;
    // The after-snapshot is at 189 and the frame swapped at 190: one millisecond late.
    expect(test?.steps[0]?.shot?.skewMs).toBe(1);
    expect(test?.steps[1]?.shot?.skewMs).toBe(2);
  });

  it('resolves the delta-encoded DOM instead of reporting an empty page', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const [test] = (await playwrightTraceReader.read(file)).tests;
    const dom = test?.steps[1]?.dom;
    // The second snapshot's <head> is a back-reference; without resolution the document is empty.
    expect(dom?.nodes.map((node) => node.path)).toEqual([
      'html',
      'html>body',
      'html>body>h1',
      'html>body>div',
    ]);
    expect(dom?.nodes[3]?.text).toBe('ready');
    expect(dom?.nodes[3]?.testId).toBe('out');
    expect(dom?.url).toBe('http://localhost:3000/?q=oslo');
    expect(dom?.viewport).toEqual({ w: 900, h: 600 });
  });

  it('attaches console messages and network requests to the step they happened during', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const [test] = (await playwrightTraceReader.read(file)).tests;
    expect(test?.steps[0]?.console.map((entry) => entry.text)).toEqual(['dashboard ready']);
    expect(test?.steps[0]?.network.map((entry) => entry.url)).toEqual(['http://localhost:3000/']);
    expect(test?.steps[1]?.console).toEqual([]);
    expect(test?.steps[1]?.network.map((entry) => entry.url)).toEqual([
      'http://localhost:3000/api/forecast',
    ]);
    expect(test?.steps[1]?.network[0]).toMatchObject({ method: 'GET', status: 200, resourceType: 'fetch' });
  });

  it('times steps in wall-clock terms', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const [test] = (await playwrightTraceReader.read(file)).tests;
    expect(test?.steps[0]?.startedAt).toBe(new Date(epoch(110)).toISOString());
    expect(test?.steps[0]?.finishedAt).toBe(new Date(epoch(200)).toISOString());
    expect(test?.steps[0]?.durationMs).toBe(90);
    expect(test?.steps[0]?.status).toBe('ok');
    expect(test?.startedAt).toBe(new Date(epoch(110)).toISOString());
    expect(test?.finishedAt).toBe(new Date(epoch(400)).toISOString());
  });

  it('marks a step failed and keeps the error the trace recorded', async () => {
    const events = libraryEvents().map((line) =>
      line['type'] === 'after' && line['callId'] === 'call@18'
        ? { ...line, error: { error: { message: 'locator.click: Timeout 30000ms exceeded' } } }
        : line,
    );
    const archive = buildTraceArchive({
      prefixes: [{ prefix: 'trace', events }],
      resources: {
        [`resources/${SHOT_EARLY}`]: fakeJpeg(798, 532),
        [`resources/${SHOT_LATE}`]: fakeJpeg(798, 532, 64),
      },
    });
    const file = await writeArchive('failed.zip', archive);
    const [test] = (await playwrightTraceReader.read(file)).tests;
    expect(test?.steps[1]?.status).toBe('failed');
    expect(test?.steps[1]?.error).toBe('locator.click: Timeout 30000ms exceeded');
  });

  it('reads a deflated archive as readily as a stored one', async () => {
    const file = await writeArchive('deflated.zip', libraryArchive({ deflate: true }));
    const ingest = await playwrightTraceReader.read(file);
    expect(ingest.tests[0]?.steps).toHaveLength(2);
  });
});

describe('idempotency (§6)', () => {
  it('hashes the archive so the same trace ingested twice is one run', async () => {
    const bytes = libraryArchive();
    const first = await writeArchive('trace.zip', bytes);
    const second = await writeArchive('renamed.zip', bytes);
    const a = await playwrightTraceReader.read(first);
    const b = await playwrightTraceReader.read(second);
    expect(a.archiveHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.archiveHash).toBe(a.archiveHash);
    expect(b.archivePath).not.toBe(a.archivePath);
  });

  it('gives a different hash to a different recording of the same test', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const other = await writeArchive('trace.zip', libraryArchive({ deflate: true }));
    const a = await playwrightTraceReader.read(file);
    const b = await playwrightTraceReader.read(other);
    expect(b.archiveHash).not.toBe(a.archiveHash);
    // …even though it is the same test, with the same title and the same steps.
    expect(b.tests[0]?.flow).toBe(a.tests[0]?.flow);
  });
});

describe('overrides', () => {
  it('honours --flow', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const ingest = await playwrightTraceReader.read(file, { flow: 'forecast' });
    expect(ingest.tests[0]?.flow).toBe('forecast');
    expect(ingest.tests[0]?.flowSource).toBe('override');
  });

  it('honours a step id pinned by title', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    const ingest = await playwrightTraceReader.read(file, {
      stepIds: { 'run the search': 'search' },
    });
    expect(ingest.tests[0]?.steps.map((step) => step.id)).toEqual(['open-the-dashboard', 'search']);
  });
});

describe('reading a runner archive', () => {
  it('reads both layouts: numbered context prefixes plus test.trace', async () => {
    const file = await writeArchive('trace.zip', runnerArchive());
    const ingest = await playwrightTraceReader.read(file);
    expect(ingest.metadata.origin).toBe('testRunner');
    // The browser and viewport come from the library half; test.trace carries neither.
    expect(ingest.metadata.browser).toBe('chromium');
    expect(ingest.tests[0]?.title).toBe(LIBRARY_TITLE);
  });

  it('takes step titles from test.step, through the library actions stepId link', async () => {
    const file = await writeArchive('trace.zip', runnerArchive());
    const [test] = (await playwrightTraceReader.read(file)).tests;
    expect(test?.steps.map((step) => step.title)).toEqual(['run the search', 'run the search']);
    expect(test?.steps.map((step) => step.origin.titleSource)).toEqual(['test-step', 'test-step']);
    expect(test?.steps.map((step) => step.origin.callId)).toEqual(['test.step@10', 'test.step@20']);
  });

  it('disambiguates duplicate step titles with a stable suffix, and says so once', async () => {
    const file = await writeArchive('trace.zip', runnerArchive());
    const ingest = await playwrightTraceReader.read(file);
    expect(ingest.tests[0]?.steps.map((step) => step.id)).toEqual([
      'run-the-search',
      'run-the-search-2',
    ]);
    const notice = ingest.notices.find((entry) => entry.kind === 'duplicate-step-titles');
    expect(notice?.message).toBe(
      "duplicate step titles disambiguated with a numeric suffix: 'run the search'",
    );
  });

  it('leaves hooks, fixtures and attachments out of the steps, and counts them', async () => {
    const file = await writeArchive('trace.zip', runnerArchive());
    const ingest = await playwrightTraceReader.read(file);
    expect(ingest.tests[0]?.steps.map((step) => step.title)).not.toContain('Before Hooks');
    expect(ingest.tests[0]?.steps.map((step) => step.title)).not.toContain('Attach "note"');
    const notice = ingest.notices.find((entry) => entry.kind === 'skipped-infrastructure');
    expect(notice?.message).toBe(
      '4 runner hook, fixture and tracing calls were not turned into steps',
    );
  });
});

describe('an archive whose every action was infrastructure', () => {
  it('yields a test with no steps, timed from the context rather than the epoch', async () => {
    const runnerEvents: TraceLine[] = [
      contextOptions({ origin: 'testRunner', browserName: '', wallTime: WALL, monotonicTime: MONO }),
      ...action({ callId: 'hook@1', class: 'Test', method: 'hook', title: 'Before Hooks', stepId: 'hook@1', startTime: 100, endTime: 130 }),
    ];
    const libraryHalf: TraceLine[] = [
      contextOptions({ title: LIBRARY_TITLE, wallTime: WALL, monotonicTime: MONO }),
      ...action({ callId: 'call@4', class: 'BrowserContext', method: 'newPage', stepId: 'hook@1', pageId: PAGE, startTime: 103, endTime: 127 }),
      screencastFrame({ pageId: PAGE, sha1: SHOT_EARLY, timestamp: 120, frameSwapWallTime: epoch(120) }),
    ];
    const file = await writeArchive(
      'hooks-only.zip',
      buildTraceArchive({
        prefixes: [
          { prefix: '0-trace', events: libraryHalf, network: [] },
          { prefix: 'test', events: runnerEvents },
        ],
        resources: { [`resources/${SHOT_EARLY}`]: fakeJpeg(798, 532) },
      }),
    );
    const [test] = (await playwrightTraceReader.read(file)).tests;
    expect(test?.steps).toEqual([]);
    expect(test?.startedAt).toBe(new Date(WALL).toISOString());
    expect(test?.finishedAt).toBe(new Date(WALL).toISOString());
  });
});

describe('shared screenshots', () => {
  it('marks steps that resolve to one frame, because many-to-one is by design', async () => {
    const events = libraryEvents().filter(
      (line) => !(line['type'] === 'screencast-frame' && line['sha1'] === SHOT_LATE),
    );
    const archive = buildTraceArchive({
      prefixes: [{ prefix: 'trace', events }],
      resources: { [`resources/${SHOT_EARLY}`]: fakeJpeg(798, 532) },
    });
    const file = await writeArchive('shared.zip', archive);
    const ingest = await playwrightTraceReader.read(file);
    expect(ingest.tests[0]?.steps.every((step) => step.shot?.shared === true)).toBe(true);
    const notice = ingest.notices.find((entry) => entry.kind === 'shared-screenshots');
    expect(notice?.message).toBe(
      '2 of 2 steps share a screenshot with another step: screencast frames are throttled, so several actions legitimately resolve to one image',
    );
  });
});

describe('a trace with no titles at all', () => {
  it('synthesizes ids from the call and its selector, and warns that they will drift', async () => {
    const events: TraceLine[] = [
      contextOptions({ wallTime: WALL, monotonicTime: MONO }),
      ...action({ callId: 'call@10', class: 'Frame', method: 'click', pageId: PAGE, params: { selector: '#go' }, startTime: 110, endTime: 200, afterSnapshot: 'after@call@10' }),
      frameSnapshot({ callId: 'call@10', snapshotName: 'after@call@10', pageId: PAGE, html: HTML_IDLE, timestamp: 190, wallTime: epoch(190) }),
      screencastFrame({ pageId: PAGE, sha1: SHOT_EARLY, timestamp: 191, frameSwapWallTime: epoch(191) }),
    ];
    const file = await writeArchive(
      'bare.zip',
      buildTraceArchive({
        prefixes: [{ prefix: 'trace', events }],
        resources: { [`resources/${SHOT_EARLY}`]: fakeJpeg(798, 532) },
      }),
    );
    const ingest = await playwrightTraceReader.read(file);
    expect(ingest.tests[0]?.steps[0]?.id).toBe('click-go');
    expect(ingest.tests[0]?.steps[0]?.origin.titleSource).toBe('synthesized');
    // With no title in the archive, the flow falls back to the file name.
    expect(ingest.tests[0]?.title).toBe('bare');
    const notice = ingest.notices.find((entry) => entry.kind === 'synthesized-step-ids');
    expect(notice?.message).toBe(
      'the trace carries no step titles, so step ids were synthesized from each call and its ' +
        'selector; they will change when a locator changes. Wrap steps in tracing.group() or ' +
        'test.step() for stable ids, or pin them in .visual-diff/e2e-map.yaml',
    );
  });
});

describe('version handling', () => {
  it('reads a version 7 archive through the apiName rename, and says it did', async () => {
    const events: TraceLine[] = [
      contextOptions({ version: 7, title: LIBRARY_TITLE, wallTime: WALL, monotonicTime: MONO }),
      ...action({ callId: 'call@8', class: 'Tracing', method: 'tracingGroup', apiName: 'open the dashboard', startTime: 110, endTime: 200 }),
      ...action({ callId: 'call@10', class: 'Frame', method: 'goto', parentId: 'call@8', pageId: PAGE, params: { url: 'http://localhost:3000/' }, startTime: 115, endTime: 190, afterSnapshot: 'after@call@10' }),
      frameSnapshot({ callId: 'call@10', snapshotName: 'after@call@10', pageId: PAGE, html: HTML_IDLE, timestamp: 189, wallTime: epoch(189) }),
      screencastFrame({ pageId: PAGE, sha1: SHOT_EARLY, timestamp: 190, frameSwapWallTime: epoch(190) }),
    ];
    const file = await writeArchive(
      'v7.zip',
      buildTraceArchive({
        prefixes: [{ prefix: 'trace', events }],
        resources: { [`resources/${SHOT_EARLY}`]: fakeJpeg(798, 532) },
      }),
    );
    const ingest = await playwrightTraceReader.read(file);
    expect(ingest.metadata.formatVersion).toBe(7);
    // Without the rename this step would be titled after its selector and keyed 'goto-…'.
    expect(ingest.tests[0]?.steps[0]?.id).toBe('open-the-dashboard');
    expect(ingest.notices.find((entry) => entry.kind === 'modernized')?.message).toBe(
      "trace format version 7 read as version 8: action titles were taken from the pre-rename 'apiName' field",
    );
  });

  it('refuses a newer trace, naming the version and the versions supported', async () => {
    const events = libraryEvents();
    events[0] = contextOptions({ version: 9, title: LIBRARY_TITLE, wallTime: WALL, monotonicTime: MONO });
    const file = await writeArchive(
      'v9.zip',
      buildTraceArchive({ prefixes: [{ prefix: 'trace', events }], resources: { [`resources/${SHOT_EARLY}`]: fakeJpeg(798, 532) } }),
    );
    const error = await readError(file);
    expect(error.message).toBe(
      `trace format version 9 is newer than the supported versions (7, 8); this build of visual-diff cannot read it: ${file}`,
    );
    expect(error.exitCode).toBe(2);
  });

  it('refuses an older trace rather than ingesting it partially', async () => {
    const events = libraryEvents();
    events[0] = contextOptions({ version: 6, title: LIBRARY_TITLE, wallTime: WALL, monotonicTime: MONO });
    const file = await writeArchive(
      'v6.zip',
      buildTraceArchive({ prefixes: [{ prefix: 'trace', events }], resources: { [`resources/${SHOT_EARLY}`]: fakeJpeg(798, 532) } }),
    );
    const error = await readError(file);
    expect(error.message).toContain('trace format version 6 is older than the supported versions (7, 8)');
    expect(error.code).toBe('e2e-trace-version-unsupported');
  });
});

describe('refusals (§8)', () => {
  it('refuses a trace with no screenshots, which is what default tracing produces', async () => {
    // tracing.start() with no options records neither screenshots nor snapshots.
    const events = libraryEvents().filter((line) => line['type'] !== 'screencast-frame');
    const file = await writeArchive(
      'noshots.zip',
      buildTraceArchive({ prefixes: [{ prefix: 'trace', events }] }),
    );
    const error = await readError(file);
    expect(error.message).toBe(
      `trace contains no screenshots: ${file} — there is nothing to diff, and a run with no shots is worse than none`,
    );
    expect(error.code).toBe('e2e-no-screenshots');
    expect(error.hint).toBe(
      'screenshots default to off for library tracing: record with tracing.start({ screenshots: true, snapshots: true })',
    );
  });

  it('refuses a zip that contains no trace', async () => {
    const file = await writeArchive(
      'photos.zip',
      buildZip([
        { name: 'readme.txt', data: 'holiday photos' },
        { name: 'resources/a.jpeg', data: fakeJpeg(10, 10) },
      ]),
    );
    const error = await readError(file);
    expect(error.message).toBe(
      `not a Playwright trace archive: ${file} contains no '.trace' entry (2 entries read)`,
    );
    expect(error.code).toBe('e2e-not-a-trace');
  });

  it('refuses a trace file that does not begin with context-options', async () => {
    const file = await writeArchive(
      'headless.zip',
      buildTraceArchive({ prefixes: [{ prefix: 'trace', events: [{ type: 'before', callId: 'call@1' }] }] }),
    );
    const error = await readError(file);
    expect(error.message).toBe(
      `corrupt trace archive: ${file} (trace.trace does not begin with a context-options event, so its format version is unknown)`,
    );
  });

  it('names a screenshot the trace referenced but the archive does not contain', async () => {
    const file = await writeArchive(
      'missing-shot.zip',
      buildTraceArchive({ prefixes: [{ prefix: 'trace', events: libraryEvents() }] }),
    );
    const error = await readError(file);
    expect(error.message).toBe(
      `corrupt trace archive: ${file} (the trace references screenshot 'resources/${SHOT_EARLY}', which the archive does not contain)`,
    );
  });

  it('names a screenshot that is not a readable JPEG', async () => {
    const file = await writeArchive(
      'not-jpeg.zip',
      buildTraceArchive({
        prefixes: [{ prefix: 'trace', events: libraryEvents() }],
        resources: {
          [`resources/${SHOT_EARLY}`]: 'this is not an image',
          [`resources/${SHOT_LATE}`]: fakeJpeg(798, 532),
        },
      }),
    );
    const error = await readError(file);
    expect(error.message).toBe(
      `corrupt trace archive: ${file} (screenshot 'resources/${SHOT_EARLY}' is not a readable JPEG)`,
    );
  });
});

describe('sniff', () => {
  it('recognises a trace archive and reports its version', async () => {
    const file = await writeArchive('trace.zip', libraryArchive());
    expect(await playwrightTraceReader.sniff(file)).toEqual({
      ok: true,
      format: 'playwright',
      formatVersion: 8,
    });
  });

  it('answers rather than throwing for anything else', async () => {
    const zip = await writeArchive('photos.zip', buildZip([{ name: 'a.txt', data: 'x' }]));
    expect(await playwrightTraceReader.sniff(zip)).toEqual({
      ok: false,
      reason: 'no .trace entry in the archive',
    });
    const missing = path.join(tmpdir(), 'vdiff-e2e-absent-9999.zip');
    const result = await playwrightTraceReader.sniff(missing);
    expect(result.ok).toBe(false);
  });

  it('reports an unsupported version without refusing to answer', async () => {
    const events = libraryEvents();
    events[0] = contextOptions({ version: 9, wallTime: WALL, monotonicTime: MONO });
    const file = await writeArchive(
      'v9.zip',
      buildTraceArchive({ prefixes: [{ prefix: 'trace', events }] }),
    );
    expect(await playwrightTraceReader.sniff(file)).toEqual({
      ok: true,
      format: 'playwright',
      formatVersion: 9,
    });
  });
});
