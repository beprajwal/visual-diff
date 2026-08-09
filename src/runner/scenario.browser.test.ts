/**
 * Scenarios against real Chromium (mocking spec §10.5).
 *
 * The unit tests drive `ScenarioRuntime` through a fake route, which proves the decisions but not
 * the wiring. Three things can only be proved against a real browser, and all three are load-bearing:
 *
 *  1. **`route.fallback()` reaches `routeFromHAR`.** The whole overlay design rests on Playwright
 *     consulting route handlers in reverse registration order, so a scenario rule can patch a
 *     response while every unclaimed request is still served by the recording, untouched. If that
 *     ordering were wrong, passthrough requests would abort and no unit test would notice.
 *  2. **`mock` renders with no HAR at all**, serving its rules and aborting everything else (D13).
 *  3. **`delay` defers fulfilment rather than losing the response**, and the run stays deterministic.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Browser } from 'playwright-core';

import type { ScenarioSpec, Viewport } from '../types.js';
import { launchChromium, newContext } from './browser.js';
import { indexHarFile } from './har.js';
import { buildScenarioRuntime, type ScenarioPlan, type ScenarioRuntime } from './scenario.js';

const require_ = createRequire(import.meta.url);

function chromiumAvailable(): boolean {
  try {
    const { chromium } = require_('playwright-core') as typeof import('playwright-core');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const describeIfBrowser = chromiumAvailable() ? describe : describe.skip;

const viewport: Viewport = { id: '400x300', width: 400, height: 300 };

const FORECAST_URL = 'https://api.example.test/v1/forecast';
const CATALOG_URL = 'https://api.example.test/v1/catalog';

/** Fetches both endpoints and writes whatever came back into the DOM. */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>forecast</title></head>
<body>
  <p id="temp">loading</p>
  <p id="catalog">loading</p>
  <script>
    const show = (id, text) => { document.getElementById(id).textContent = text; };
    fetch(${JSON.stringify(FORECAST_URL)})
      .then((r) => r.json())
      .then((d) => show('temp', 'temp ' + JSON.stringify(d.temperature)))
      .catch((e) => show('temp', 'error'));
    fetch(${JSON.stringify(CATALOG_URL)})
      .then((r) => r.json())
      .then((d) => show('catalog', 'catalog ' + d.items.join(',')))
      .catch((e) => show('catalog', 'error'));
  </script>
</body></html>
`;

const CORS = { 'access-control-allow-origin': '*' };

function harEntry(url: string, mimeType: string, text: string): unknown {
  return {
    startedDateTime: '2026-08-10T00:00:00.000Z',
    time: 1,
    request: {
      method: 'GET',
      url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [
        { name: 'content-type', value: mimeType },
        { name: 'access-control-allow-origin', value: '*' },
      ],
      content: { size: text.length, mimeType, text },
      redirectURL: '',
      headersSize: -1,
      bodySize: text.length,
    },
    cache: {},
    timings: { send: 0, wait: 1, receive: 0 },
  };
}

function plan(spec: ScenarioSpec): ScenarioPlan {
  return { name: spec.scenario, mode: spec.mode, spec, file: `${spec.scenario}.yaml` };
}

/** The text both paragraphs settled on, once neither says `loading`. */
async function readOutput(
  browser: Browser,
  options: { network: 'replay' | 'mock'; har?: string; scenario: ScenarioRuntime; url: string },
): Promise<{ temp: string; catalog: string }> {
  const context = await newContext(browser, {
    viewport,
    network: options.network,
    ...(options.har === undefined ? {} : { har: options.har }),
    scenario: options.scenario,
  });
  try {
    const page = await context.newPage();
    await page.goto(options.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        document.getElementById('temp')?.textContent !== 'loading' &&
        document.getElementById('catalog')?.textContent !== 'loading',
      undefined,
      { timeout: 15_000 },
    );
    return {
      temp: (await page.locator('#temp').textContent()) ?? '',
      catalog: (await page.locator('#catalog').textContent()) ?? '',
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

describeIfBrowser('scenarios in a real browser', () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let dir: string;
  let harFile: string;

  beforeAll(async () => {
    browser = await launchChromium();

    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    dir = await mkdtemp(join(tmpdir(), 'vdiff-scenario-browser-'));
    harFile = join(dir, 'forecast.har');
    await writeFile(
      harFile,
      JSON.stringify({
        log: {
          version: '1.2',
          creator: { name: 'test', version: '1' },
          entries: [
            harEntry(`${origin}/`, 'text/html; charset=utf-8', PAGE),
            harEntry(FORECAST_URL, 'application/json', JSON.stringify({ temperature: 17.4 })),
            harEntry(CATALOG_URL, 'application/json', JSON.stringify({ items: ['a', 'b'] })),
          ],
        },
      }),
      'utf8',
    );
  }, 120_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  /*
   * The assumption the whole overlay design rests on: the scenario route is registered after
   * `routeFromHAR`, Playwright consults handlers in reverse registration order, and `fallback()`
   * hands an unclaimed request down to the recording.
   */
  it('overlay patches one response and lets the recording serve the rest, untouched', async () => {
    const spec: ScenarioSpec = {
      version: 1,
      scenario: 'cold-snap',
      mode: 'overlay',
      rules: [{ id: 'freeze', match: { url: '**/v1/forecast**' }, patch: { temperature: 0 } }],
    };
    const runtime = buildScenarioRuntime({
      plan: plan(spec),
      har: await indexHarFile(harFile),
    });

    const output = await readOutput(browser, {
      network: 'replay',
      har: harFile,
      scenario: runtime,
      url: `${origin}/`,
    });

    expect(output.temp).toBe('temp 0');
    // Not `error`: the unmatched request fell through to the recording and was served by it.
    expect(output.catalog).toBe('catalog a,b');
    expect(runtime.matchedRuleIds()).toEqual(['freeze']);
    expect(runtime.ruleFailures()).toEqual([]);
  }, 120_000);

  it('mock renders with no HAR at all: rules are served, everything else is aborted', async () => {
    const spec: ScenarioSpec = {
      version: 1,
      scenario: 'no-backend',
      mode: 'mock',
      rules: [
        {
          id: 'forecast',
          match: { url: '**/v1/forecast**' },
          respond: { status: 200, headers: CORS, body: { temperature: -40 } },
        },
      ],
    };
    const runtime = buildScenarioRuntime({ plan: plan(spec) });

    const output = await readOutput(browser, {
      network: 'mock',
      scenario: runtime,
      url: `${origin}/`,
    });

    // The document came from the dev server (mock replaces the network, not the app) and the rule
    // supplied the API; the endpoint no rule covered was aborted rather than reaching the network.
    expect(output.temp).toBe('temp -40');
    expect(output.catalog).toBe('error');
    expect(runtime.attributionFor({}, 'GET', CATALOG_URL)).toMatchObject({
      ruleId: null,
      action: 'miss',
    });
  }, 120_000);

  /* §10.1: the slice-1 determinism guarantee must survive this layer, `delay` included. */
  it('is deterministic under a delay: the same scenario twice renders the same thing', async () => {
    const spec: ScenarioSpec = {
      version: 1,
      scenario: 'slow-catalog',
      mode: 'overlay',
      rules: [
        { id: 'freeze', match: { url: '**/v1/forecast**' }, patch: { temperature: 0 } },
        { id: 'slow-catalog', match: { url: '**/v1/catalog**' }, delay: 250 },
      ],
    };

    const runOnce = async (): Promise<{ temp: string; catalog: string }> =>
      await readOutput(browser, {
        network: 'replay',
        har: harFile,
        scenario: buildScenarioRuntime({ plan: plan(spec), har: await indexHarFile(harFile) }),
        url: `${origin}/`,
      });

    const first = await runOnce();
    const second = await runOnce();
    expect(first).toEqual({ temp: 'temp 0', catalog: 'catalog a,b' });
    expect(second).toEqual(first);
  }, 120_000);
});
