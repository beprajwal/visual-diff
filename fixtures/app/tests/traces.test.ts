/**
 * The committed trace archives, read by the reader that has to ingest them.
 *
 * `traces/` exists so e2e ingestion (spec §9, test 1) is tested against archives Playwright really
 * wrote, hermetically, without a live suite. That only holds if the archives are actually readable,
 * and if the properties the reader's own suite relies on them for are properties they really have.
 * This file is that check, and it is deliberately about the *fixtures* rather than about the
 * reader: it asserts what each archive contains, so that when `src/e2e` changes and its tests move,
 * something still fails loudly if a regenerated archive quietly stopped containing a duplicate step
 * title, or a screenshot, or a second BrowserContext.
 *
 * Three things it checks that nothing else can:
 *
 *  1. **They still load through Playwright's own `TraceModel`.** `record-traces.mjs` repacks each
 *     archive to strip the client call sites, which name the absolute path of the machine that
 *     generated them. Our reader ignoring those members is not evidence that the archives are still
 *     valid Playwright traces; Playwright reading them is.
 *  2. **No absolute path survives.** A fixture committed forever must not carry someone's home
 *     directory, and the check belongs where a regeneration will trip over it.
 *  3. **The screenshot trap is real in these files.** Every frame reports a 900x600 viewport and is
 *     798x532 on disk. A reader that trusts `screencast-frame.width` is wrong, and these archives
 *     are the proof rather than the assumption.
 *
 * Regenerate with `npm run fixture:traces` (and `node scripts/record-runner-trace.mjs` for the
 * runner archive). See `traces/README.md`.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { playwrightTraceReader, toShotPayloads } from '../../../src/e2e/index.js';
import type { E2eIngest, E2eStep, E2eTest } from '../../../src/e2e/index.js';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const TRACES = join(APP_DIR, 'traces');

const BASELINE = join(TRACES, 'dashboard-baseline.zip');
const CHANGED = join(TRACES, 'dashboard-changed.zip');
const SEARCH = join(TRACES, 'search-library.zip');
const RUNNER = join(TRACES, 'dashboard-runner.zip');

/** The viewport `record-traces.mjs` records at, and the size the frames are downscaled to. */
const VIEWPORT = { w: 900, h: 600 };
const FRAME = { width: 798, height: 532 };

const DASHBOARD_TITLE = 'weather.spec.ts:14 › weather dashboard › shows saved locations and opens a forecast';
const DASHBOARD_KEY = 'weather.spec.ts › weather dashboard › shows saved locations and opens a forecast';
const DASHBOARD_FLOW = 'weather-spec-ts-weather-dashboard-shows-saved-locations-and-opens-a-forecast';

/** The `tracing.group` names the dashboard workflow uses, in order, with the duplicate last. */
const DASHBOARD_STEPS = [
  'open-the-dashboard',
  'switch-to-fahrenheit',
  'open-a-saved-location',
  'read-the-forecast',
  'read-the-forecast-2',
];

const require_ = createRequire(join(APP_DIR, 'package.json'));

const ingests = new Map<string, Promise<E2eIngest>>();

/** Reads once per archive per run: four archives, and every test wants one of them. */
function ingest(archive: string): Promise<E2eIngest> {
  const cached = ingests.get(archive);
  if (cached !== undefined) return cached;
  const started = playwrightTraceReader.read(archive);
  ingests.set(archive, started);
  return started;
}

async function onlyTest(archive: string): Promise<E2eTest> {
  const read = await ingest(archive);
  expect(read.tests).toHaveLength(1);
  return read.tests[0] as E2eTest;
}

function stepText(step: E2eStep): string {
  return (step.dom?.nodes ?? []).map((node) => node.text ?? '').join(' ');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every member of the archive, through Playwright's own zip reader rather than ours. */
async function entries(archive: string): Promise<{ name: string; data: Buffer }[]> {
  const { utils } = require_('playwright-core/lib/coreBundle');
  const zip = new utils.ZipFile(archive);
  const names: string[] = await zip.entries();
  const members = [];
  for (const name of names) members.push({ name, data: (await zip.read(name)) as Buffer });
  zip.close();
  return members;
}

const scratch: string[] = [];

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

describe('every committed archive', () => {
  const archives = [
    ['dashboard-baseline.zip', BASELINE],
    ['dashboard-changed.zip', CHANGED],
    ['search-library.zip', SEARCH],
    ['dashboard-runner.zip', RUNNER],
  ] as const;

  it.each(archives)('%s sniffs as a v8 Playwright trace', async (_name, archive) => {
    expect(await playwrightTraceReader.sniff(archive)).toEqual({
      ok: true,
      format: 'playwright',
      formatVersion: 8,
    });
  });

  it.each(archives)('%s records the capture conditions it was recorded under', async (_name, archive) => {
    const read = await ingest(archive);
    expect(read.metadata).toMatchObject({
      tool: 'playwright',
      formatVersion: 8,
      toolVersion: '1.62.1',
      browser: 'chromium',
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'en-US',
    });
  });

  /**
   * §4, as these archives actually stand: recorded with `screenshots` and `snapshots` on, so the
   * conditional capabilities are present and only the unconditional gaps are missing. If a
   * regeneration ever drops `snapshots`, `network` and `dom-snapshots` appear in `missing` and this
   * fails — which is the point, because a trace with no DOM is a different fixture.
   */
  it.each(archives)('%s carries screenshots, DOM and network, and no styles or a11y', async (_name, archive) => {
    const read = await ingest(archive);
    expect(read.capabilities.screenshots).toBe(true);
    expect(read.capabilities.domSnapshots).toBe(true);
    expect(read.capabilities.network).toBe(true);
    expect(read.capabilities.console).toBe(true);
    expect(read.capabilities.missing).toEqual([
      'computed-styles',
      'accessibility-tree',
      'element-geometry',
      'full-page-screenshots',
      'revision',
      'project-name',
      'retry-index',
    ]);
  });

  /**
   * The single most consequential fact about a trace screenshot: the event reports the *logical
   * viewport*, the file is downscaled to fit an 800x800 box, and `deviceScaleFactor` is discarded.
   */
  it.each(archives)('%s stores frames smaller than the viewport they report', async (_name, archive) => {
    const read = await ingest(archive);
    const shots = read.tests.flatMap((test) => test.steps.flatMap((step) => (step.shot === null ? [] : [step.shot])));
    expect(shots.length).toBeGreaterThan(0);
    for (const shot of shots) {
      expect(shot.encoding).toBe('jpeg');
      expect(shot.viewport).toEqual(VIEWPORT);
      expect({ width: shot.width, height: shot.height }).toEqual(FRAME);
      expect(shot.width).toBeLessThan(shot.viewport.w);
      expect(shot.scale).toBeCloseTo(FRAME.width / VIEWPORT.w, 3);
      // The JPEG itself, not a claim about it.
      expect([...shot.bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    }
  });

  it.each(archives)('%s is keyed by the sha256 of its own bytes, twice over', async (_name, archive) => {
    const first = await playwrightTraceReader.read(archive);
    const second = await playwrightTraceReader.read(archive);
    expect(first.archiveHash).toBe(second.archiveHash);
    expect(first.archiveHash).toBe(`sha256:${sha256(await readFile(archive))}`);
  });

  /**
   * The archives are repacked to strip client call sites (`trace.stacks`, and the `stack` field on
   * `tracing.group` events), which name the absolute path of the machine that recorded them.
   */
  it.each(archives)('%s names no filesystem path', async (_name, archive) => {
    for (const member of await entries(archive)) {
      if (member.name.endsWith('.jpeg')) continue;
      const text = member.data.toString('utf8');
      expect(text, `${member.name} in ${archive}`).not.toMatch(/\/Users\/|\/home\/[^/]|\/private\/var\//);
    }
    expect((await entries(archive)).some((member) => member.name.endsWith('.stacks'))).toBe(false);
  });

  /** Stripping members is only safe if the result is still a trace Playwright itself can open. */
  it.each(archives)('%s still loads through Playwright\'s own TraceModel', async (_name, archive) => {
    const { iso, tools } = require_('playwright-core/lib/coreBundle');
    const dir = await mkdtemp(join(tmpdir(), 'vdiff-trace-oracle-'));
    scratch.push(dir);
    await tools.extractTrace(archive, dir);
    const loader = new iso.TraceLoader();
    await loader.load(new tools.DirTraceLoaderBackend(dir), undefined, () => {});
    const model = new iso.TraceModel(archive, loader.contextEntries);
    expect(model.errors ?? []).toEqual([]);
    expect(model.actions.length).toBeGreaterThan(0);
  });
});

describe('dashboard-baseline.zip — the library archive with named steps', () => {
  it('is one test, titled the way the runner titles one', async () => {
    const test = await onlyTest(BASELINE);
    expect(test.title).toBe(DASHBOARD_TITLE);
    // D26: the `:14` is stripped before the flow key is derived, so inserting an import above the
    // test does not remove-and-add every step in it.
    expect(test.titleKey).toBe(DASHBOARD_KEY);
    expect(test.flow).toBe(DASHBOARD_FLOW);
    expect(test.flowSource).toBe('derived');
    expect(test.viewport).toBe('900x600');
  });

  it('names its steps after the tracing groups, disambiguating the repeated one', async () => {
    const test = await onlyTest(BASELINE);
    expect(test.steps.map((step) => step.id)).toEqual(DASHBOARD_STEPS);
    expect(test.steps.map((step) => step.origin.titleSource)).toEqual(Array(5).fill('group'));
    expect(test.steps.map((step) => step.title)).toEqual([
      'open the dashboard',
      'switch to Fahrenheit',
      'open a saved location',
      'read the forecast',
      'read the forecast',
    ]);
    expect(test.steps.every((step) => step.status === 'ok')).toBe(true);
  });

  it('reports the duplicate title once, as a notice rather than an error', async () => {
    const read = await ingest(BASELINE);
    expect(read.notices).toContainEqual({
      kind: 'duplicate-step-titles',
      message: "duplicate step titles disambiguated with a numeric suffix: 'read the forecast'",
    });
  });

  /**
   * Many steps legitimately resolve to one screenshot: screencast frames are throttled to ~5 fps,
   * so a step that changed nothing visible has no frame of its own. The report must not present
   * that as a defect, which it can only do if the ingest says so.
   */
  it('marks the steps that share a screenshot with another step', async () => {
    const read = await ingest(BASELINE);
    const test = read.tests[0] as E2eTest;
    expect(test.steps.some((step) => step.shot?.shared === true)).toBe(true);
    expect(read.notices.map((notice) => notice.kind)).toContain('shared-screenshots');
  });

  it('recovers the DOM behind each step, resolving the delta chain', async () => {
    const test = await onlyTest(BASELINE);
    const list = test.steps[0] as E2eStep;
    const detail = test.steps[2] as E2eStep;
    // A snapshot is delta-encoded against the previous one; a reader that does not replay the chain
    // gets `[[1, 2]]` and concludes the page is empty. 117 nodes is what the list screen has.
    expect(list.dom?.nodes.length).toBeGreaterThan(50);
    expect(stepText(list)).toContain('Saved locations');
    expect(stepText(detail)).toContain('Berlin');
    expect(list.url).toBe('http://127.0.0.1:5245/#/');
  });

  it('carries the network the app replayed from the recording', async () => {
    const test = await onlyTest(BASELINE);
    const urls = test.steps.flatMap((step) => step.network.map((entry) => entry.url));
    expect(urls.some((url) => url.includes('api.open-meteo.com/v1/forecast'))).toBe(true);
    expect(urls.some((url) => url.startsWith('http://127.0.0.1:5245/'))).toBe(true);
  });

  it('converts into shot payloads the diff engine can read', async () => {
    const test = await onlyTest(BASELINE);
    const payloads = toShotPayloads(test);
    expect(payloads.map((payload) => payload.step)).toEqual(DASHBOARD_STEPS);
    for (const payload of payloads) {
      expect(payload.screenshotExtension).toBe('jpg');
      expect(payload.viewport).toBe('900x600');
      expect(payload.width).toBe(FRAME.width);
      // §4: no accessibility tree, and no computed style has a value to compare.
      expect(payload.a11y).toBeNull();
      expect(Object.values(payload.dom.nodes[0]?.styles ?? {}).every((value) => value === '')).toBe(true);
    }
  });
});

describe('dashboard-changed.zip — the same test against a changed build', () => {
  it('resolves to the same flow and the same step ids, so the two pair', async () => {
    const baseline = await onlyTest(BASELINE);
    const changed = await onlyTest(CHANGED);
    expect(changed.title).toBe(baseline.title);
    expect(changed.flow).toBe(baseline.flow);
    expect(changed.steps.map((step) => step.id)).toEqual(baseline.steps.map((step) => step.id));
  });

  it('differs from the baseline in the DOM', async () => {
    const baseline = await onlyTest(BASELINE);
    const changed = await onlyTest(CHANGED);
    expect(stepText(baseline.steps[0] as E2eStep)).toContain('Saved locations');
    expect(stepText(changed.steps[0] as E2eStep)).toContain('Your places');
    expect(stepText(changed.steps[0] as E2eStep)).not.toContain('Saved locations');
  });

  /**
   * And in pixels. Not every step: several steps share one frame, and a frame of a screen the three
   * edits do not touch is legitimately identical. At least one differing step is what makes a diff
   * between these two archives non-empty, which is the reason the pair exists.
   */
  it('differs from the baseline in at least one screenshot', async () => {
    const baseline = await onlyTest(BASELINE);
    const changed = await onlyTest(CHANGED);
    const changedById = new Map(changed.steps.map((step) => [step.id, step]));
    const differing = baseline.steps.filter((step) => {
      const other = changedById.get(step.id);
      if (step.shot === null || other?.shot === undefined || other.shot === null) return false;
      return sha256(step.shot.bytes) !== sha256(other.shot.bytes);
    });
    expect(differing.length).toBeGreaterThan(0);
  });

  it('is a different archive, so it ingests as a different run', async () => {
    const baseline = await ingest(BASELINE);
    const changed = await ingest(CHANGED);
    expect(changed.archiveHash).not.toBe(baseline.archiveHash);
  });
});

describe('search-library.zip — the library archive with no step titles at all', () => {
  it('is a different test, and so a different flow', async () => {
    const test = await onlyTest(SEARCH);
    expect(test.title).toBe('weather.spec.ts:52 › weather dashboard › finds a place by name');
    expect(test.flow).toBe('weather-spec-ts-weather-dashboard-finds-a-place-by-name');
    expect(test.flow).not.toBe(DASHBOARD_FLOW);
  });

  /**
   * The default shape of a library trace: `tracing.group` is the only way to get a step title
   * without the runner, and nobody calls it. Every id here is built from a class, a method and a
   * selector — a selector, not a name — which is exactly the drift D26 warns about.
   */
  it('synthesizes every step id, and says so', async () => {
    const read = await ingest(SEARCH);
    const test = read.tests[0] as E2eTest;
    expect(test.steps.length).toBeGreaterThan(0);
    expect(test.steps.every((step) => step.origin.titleSource === 'synthesized')).toBe(true);
    expect(test.steps.map((step) => step.id)).toContain('waitforselector-data-test-search-hint');
    expect(read.notices).toContainEqual({
      kind: 'synthesized-step-ids',
      message:
        'the trace carries no step titles, so step ids were synthesized from each call and its selector; ' +
        'they will change when a locator changes. Wrap steps in tracing.group() or test.step() for stable ids, ' +
        'or pin them in .visual-diff/e2e-map.yaml',
    });
  });

  it('reaches the search results, so the archive is of a workflow and not of a blank page', async () => {
    const test = await onlyTest(SEARCH);
    const text = test.steps.map((step) => stepText(step)).join(' ');
    expect(text).toContain('San Diego');
  });
});

describe('dashboard-runner.zip — the @playwright/test archive layout', () => {
  /**
   * The layout the library API cannot produce, and the one a reader that assumes the other silently
   * mis-parses. `test.trace` is the runner's own tree; each `N-trace` is one BrowserContext, and
   * the ordinal is not creation order — which is why prefixes are discovered by globbing rather
   * than by assuming a scheme.
   */
  it('contains a runner trace and one prefix per BrowserContext', async () => {
    const names = (await entries(RUNNER)).map((member) => member.name);
    const prefixes = names.flatMap((name) => {
      const match = /^(.+)\.trace$/.exec(name);
      return match === null ? [] : [match[1] as string];
    });
    expect(prefixes.sort()).toEqual(['0-trace', '1-trace', 'test']);
    // `test.trace` has no `.network` sibling; the library halves do. A reader that requires the
    // triple to exist for every prefix fails on exactly this archive.
    expect(names).not.toContain('test.network');
    expect(names).toContain('0-trace.network');
    expect(names).toContain('1-trace.network');
  });

  it('is recorded as a runner archive, and titled by the runner', async () => {
    const read = await ingest(RUNNER);
    expect(read.metadata.origin).toBe('testRunner');
    const test = read.tests[0] as E2eTest;
    expect(test.title).toBe('dashboard.spec.ts:13 › weather dashboard › shows saved locations and opens a forecast');
    expect(test.titleKey).toBe('dashboard.spec.ts › weather dashboard › shows saved locations and opens a forecast');
  });

  it('takes its step names from test.step, including the repeated one', async () => {
    const test = await onlyTest(RUNNER);
    const written = test.steps.filter((step) => step.origin.titleSource === 'test-step');
    expect(written.map((step) => step.id)).toEqual([...DASHBOARD_STEPS, 'open-the-list-in-a-second-context']);
    expect(written.every((step) => step.origin.method === 'test.step')).toBe(true);
  });

  it('skips the hooks and fixtures rather than presenting them as steps', async () => {
    const read = await ingest(RUNNER);
    const test = read.tests[0] as E2eTest;
    expect(test.steps.map((step) => step.title)).not.toContain('Before Hooks');
    expect(test.steps.map((step) => step.title)).not.toContain('Fixture "page"');
    expect(read.notices.map((notice) => notice.kind)).toContain('skipped-infrastructure');
  });

  /** The second context is in the same archive, and its page is really in the ingest. */
  it('reads the page from the second BrowserContext', async () => {
    const test = await onlyTest(RUNNER);
    const second = test.steps.find((step) => step.id === 'open-the-list-in-a-second-context');
    expect(second?.url).toBe('http://127.0.0.1:5245/#/');
    expect(stepText(second as E2eStep)).toContain('Saved locations');
  });
});
