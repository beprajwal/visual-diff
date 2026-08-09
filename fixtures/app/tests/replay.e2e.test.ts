/**
 * End-to-end: every committed flow, executed in Chromium against a real Vite dev server, with the
 * network served entirely from the committed recording.
 *
 * This is the test that says the fixture *works* rather than merely parses. It builds nothing by
 * hand: the dev server is started from `vite.config.js`, the steps come out of the committed flow
 * YAML through the repository's own parser, and the responses come out of
 * `.visual-diff/flows/weather.har`. If a selector in a flow drifts from the markup, if a URL drifts
 * from the recording, or if a screen throws on a payload shape, it fails here.
 *
 * **Why it routes from the HAR itself instead of running `vdiff run`.** To stay a *unit* test of
 * the fixture: no store, no lock, no git, no spawned dev server process, so a failure here is
 * about the flows, the markup or the recording and nothing else. It is deliberately scoped the
 * same way the runner is — only requests that would leave the machine are served from the
 * recording, and the application is always served by the application
 * (`src/runner/browser.ts#routeAppOriginOnly`). If the two ever drift apart, this suite passes
 * while `vdiff run` fails, so the scoping rule is restated below rather than assumed.
 *
 * Hermetic by assertion, not by assumption: every request the page makes is recorded and checked to
 * be either the dev server or Open-Meteo, and no Open-Meteo request may fail.
 */

import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadFlowFile } from '../../../src/flow/index.js';
import type { FlowSpec, FlowStep } from '../../../src/types.js';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const FLOWS_DIR = join(APP_DIR, '.visual-diff', 'flows');
const HAR_PATH = join(FLOWS_DIR, 'weather.har');

/** Only requests that would leave the machine are served from the recording. */
const EXTERNAL = /open-meteo\.com/;

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  server = await createServer({
    root: APP_DIR,
    configFile: join(APP_DIR, 'vite.config.js'),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();

  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('the dev server did not report a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

interface Traffic {
  requested: string[];
  failed: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

async function openContext(): Promise<{ context: BrowserContext; page: Page; traffic: Traffic }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: 'light',
    serviceWorkers: 'block',
  });

  await context.routeFromHAR(HAR_PATH, { url: EXTERNAL, notFound: 'abort', update: false });

  const traffic: Traffic = { requested: [], failed: [], consoleErrors: [], pageErrors: [] };
  context.on('request', (request) => traffic.requested.push(request.url()));
  context.on('requestfailed', (request) => traffic.failed.push(request.url()));

  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') traffic.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => traffic.pageErrors.push(error.message));

  return { context, page, traffic };
}

/**
 * Wait until nothing is in flight and a frame has been painted.
 *
 * A cheap stand-in for the runner's settle gate. Without it a step that navigates by hash can be
 * asserted against while the new screen's requests are still resolving, which is precisely the
 * flakiness this fixture must not introduce into the suites built on it.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );
}

/** The closed step vocabulary, as far as these flows use it. Anything else is a hard failure. */
async function runStep(page: Page, step: FlowStep): Promise<void> {
  const handled = new Set(['id', 'shoot']);

  if (step.goto !== undefined) {
    handled.add('goto');
    await page.goto(`${baseUrl}${step.goto}`, { waitUntil: 'domcontentloaded' });
  }
  if (step.viewport !== undefined) {
    handled.add('viewport');
    const [width, height] = step.viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
  }
  if (step.click !== undefined) {
    handled.add('click');
    await page.click(step.click);
  }
  if (step.fill !== undefined) {
    handled.add('fill');
    for (const [selector, value] of Object.entries(step.fill)) await page.fill(selector, value);
  }
  if (step.press !== undefined) {
    handled.add('press');
    await page.keyboard.press(step.press);
  }
  if (step.hover !== undefined) {
    handled.add('hover');
    await page.hover(step.hover);
  }
  if (step.scroll !== undefined) {
    handled.add('scroll');
    if (step.scroll.selector !== undefined) await page.locator(step.scroll.selector).scrollIntoViewIfNeeded();
    else await page.evaluate(([x, y]) => window.scrollTo(x ?? 0, y ?? 0), [step.scroll.x, step.scroll.y]);
  }
  if (step.waitFor !== undefined) {
    handled.add('waitFor');
    await page.waitForSelector(step.waitFor, { state: 'visible', timeout: 15_000 });
  }
  if (step.mask !== undefined) handled.add('mask');
  if (step.expect !== undefined) handled.add('expect');

  const unhandled = Object.keys(step).filter((key) => !handled.has(key));
  expect(unhandled, `step '${step.id}' uses a verb this harness does not execute`).toEqual([]);

  await settle(page);

  for (const expectation of step.expect ?? []) {
    const locator = page.locator(expectation.selector);
    const where = `step '${step.id}' selector '${expectation.selector}'`;

    if (expectation.count !== undefined) expect(await locator.count(), `${where} count`).toBe(expectation.count);
    if (expectation.visible === true) expect(await locator.first().isVisible(), `${where} visible`).toBe(true);
    if (expectation.hidden === true) expect(await locator.count(), `${where} hidden`).toBe(0);
    if (expectation.text !== undefined) {
      expect((await locator.first().innerText()).trim(), `${where} text`).toBe(expectation.text);
    }
  }
}

const flowNames = readdirSync(FLOWS_DIR)
  .filter((name) => name.endsWith('.yaml'))
  .map((name) => basename(name, '.yaml'))
  .sort();

describe.each(flowNames)('flow %s, replayed from the committed recording', (name) => {
  it('executes every step, hits only the recording, and logs nothing', async () => {
    const flow: FlowSpec = await loadFlowFile(join(FLOWS_DIR, `${name}.yaml`));
    const { context, page, traffic } = await openContext();

    try {
      for (const step of flow.steps) await runStep(page, step);

      // Nothing may reach a host that is neither the dev server nor Open-Meteo. If the app grew a
      // font, an analytics beacon or a CDN import, it would show up here rather than as an
      // unexplained entry in a user's HAR.
      const strangers = traffic.requested.filter((url) => !LOOPBACK.test(url) && !EXTERNAL.test(url) && !url.startsWith('data:'));
      expect(strangers).toEqual([]);

      // A failed Open-Meteo request means the recording did not contain that URL: `notFound:
      // 'abort'` fired. That is the exact failure a drifted query parameter produces.
      const misses = traffic.failed.filter((url) => EXTERNAL.test(url));
      expect(misses, 'requests with no HAR entry').toEqual([]);

      expect(traffic.pageErrors).toEqual([]);

      // Chromium itself logs "Failed to load resource: … 400" for a fetch that resolves with an
      // error status. Nothing in the application produces it and nothing can suppress it, so it is
      // separated out rather than tolerated wholesale: application-authored console output must
      // still be empty, and the browser's own noise is pinned to the exact count the `states` flow
      // earns by loading two recorded 400s. Both are deterministic, so neither becomes a finding
      // when two runs of the same flow are diffed — but a *third* one appearing would.
      const browserNoise = traffic.consoleErrors.filter((message) => message.startsWith('Failed to load resource:'));
      const fromTheApp = traffic.consoleErrors.filter((message) => !message.startsWith('Failed to load resource:'));

      expect(fromTheApp).toEqual([]);
      expect(browserNoise).toHaveLength(name === 'states' ? 2 : 0);
    } finally {
      await context.close();
    }
  });
});

describe('the recording actually drives the screens', () => {
  it('renders four location cards with real temperatures and sparklines', async () => {
    const { context, page } = await openContext();
    try {
      await page.goto(`${baseUrl}/#/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-test=sparkline]');
      await settle(page);

      expect(await page.locator('[data-test=location-grid] > li').count()).toBe(4);
      expect(await page.locator('[data-test=sparkline]').count()).toBe(4);
      expect(await page.locator('[data-test=skeleton]').count()).toBe(0);
      expect(await page.locator('[data-test=error-state]').count()).toBe(0);

      // Every card shows a real reading, not an em-dash.
      const temperatures = await page.locator('[data-test=current-temp]').allInnerTexts();
      expect(temperatures).toHaveLength(4);
      for (const temperature of temperatures) expect(temperature).toMatch(/^-?\d+°C$/);
    } finally {
      await context.close();
    }
  });

  it('draws a 48-point chart whose curve moves when the units change', async () => {
    const { context, page } = await openContext();
    try {
      await page.goto(`${baseUrl}/#/location/berlin`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-place=berlin] [data-test=chart-line]');
      await settle(page);

      const celsius = await page.locator('[data-test=chart-line]').getAttribute('d');
      expect(await page.locator('[data-test=chart-precipitation] rect').count()).toBe(48);
      expect(await page.locator('[data-test=daily-strip] li').count()).toBe(7);
      expect(celsius).toMatch(/^M [\d.-]+ [\d.-]+ C/);

      await page.click('[data-test=units-f]');
      await settle(page);

      const fahrenheit = await page.locator('[data-test=chart-line]').getAttribute('d');
      // The axis is rescaled in Fahrenheit, so the path is genuinely different geometry — which is
      // the pixel change the units toggle is in the fixture to produce.
      expect(fahrenheit).not.toBe(celsius);
      expect(await page.locator('[data-test=current-temp]').innerText()).toMatch(/°F$/);
    } finally {
      await context.close();
    }
  });

  it('renders the empty state from a response that genuinely has no results', async () => {
    const { context, page } = await openContext();
    try {
      await page.goto(`${baseUrl}/#/`, { waitUntil: 'domcontentloaded' });
      await page.fill('[data-test=search-input]', 'zzzzzzzz');
      await page.click('[data-test=search-submit]');
      await page.waitForSelector('[data-test=empty-state]');
      await settle(page);

      expect(await page.locator('[data-test=search-results]').count()).toBe(0);
      expect(await page.locator('[data-test=empty-state] .state-title').innerText()).toContain('zzzzzzzz');
    } finally {
      await context.close();
    }
  });

  it('renders the error state with the API’s own words', async () => {
    const { context, page } = await openContext();
    try {
      await page.goto(`${baseUrl}/#/at/999,13.405?label=Out+of+range`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-test=error-detail]');
      await settle(page);

      expect(await page.locator('[data-test=forecast-error] [data-test=error-detail]').innerText()).toBe(
        'Latitude must be in range of -90 to 90°. Given: 999.0.',
      );
      expect(await page.locator('[data-test=forecast-error] [data-test=error-status]').innerText()).toBe('HTTP 400');
      // The air-quality request fails independently, so that card carries its own error rather than
      // the whole screen collapsing into one.
      expect(await page.locator('[data-test=air-quality] [data-test=error-state]').count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('shows a loading state before the data arrives, not only after it', async () => {
    // Proof that the skeleton is a real screen a `delay` scenario can capture, rather than a branch
    // that never executes. The route is held open until the assertion has been made.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    try {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      await context.route(EXTERNAL, async (route) => {
        await held;
        await route.abort('blockedbyclient');
      });

      const page = await context.newPage();
      await page.goto(`${baseUrl}/#/location/berlin`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-test=skeleton]');

      expect(await page.locator('[data-test=skeleton]').count()).toBeGreaterThan(0);
      expect(await page.locator('[data-test=chart-line]').count()).toBe(0);

      release();
    } finally {
      await context.close();
    }
  });
});
