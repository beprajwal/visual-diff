/**
 * The pre-shoot settle gate losing its race (spec §7).
 *
 * "`document.fonts.ready`, two idle animation frames, and no in-flight requests. Not a timer — a
 * timer is how a half-rendered frame gets captured." The deadline exists so a page that never goes
 * quiet cannot hang a run, but losing that race is a fact about the capture: a screenshot taken with
 * requests outstanding is a non-deterministic capture, which is the one failure mode this tool
 * exists to rule out. So the gate reports instead of swallowing.
 *
 * `settle()` returning a report, `captureShot` attaching it to the shot and `worstUnsettled`
 * merging viewports were all unit-tested; the last hop was not. This file drives the real runner
 * against a page that never settles and asserts the report survives all the way to the two places a
 * user or an agent actually reads — `meta.json`'s run warnings and the step's `step.json` — with the
 * in-flight count and the URLs that caused it. An honesty fix whose final hop is untested is not a
 * fix.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunMeta, RunResult, StepResult } from '../../src/types.js';
import { paths } from '../../src/store/index.js';
import { runFlow } from '../../src/runner/index.js';

function chromiumAvailable(): boolean {
  try {
    const { chromium } = require('playwright-core') as typeof import('playwright-core');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const describeIfBrowser = chromiumAvailable() ? describe : describe.skip;

/** The hung request's path, asserted on in the warning and in `step.json`. */
const HANG_PATH = '/hang/never-answers';

/**
 * `/hang/*` accepts the connection and then never writes a response and never closes it, so the
 * request stays in flight for as long as the page lives. That is what an unsettled gate is: not a
 * slow request, an outstanding one.
 */
const SERVER = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const stuck = readFileSync(new URL('./stuck.html', import.meta.url), 'utf8');
const calm = readFileSync(new URL('./calm.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  if (req.url.startsWith('/hang')) {
    req.socket.setKeepAlive(true);
    return; // never res.end(): the request stays outstanding forever
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/calm') ? calm : stuck);
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.listen(Number(process.env.PORT), '127.0.0.1');
`;

const STUCK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>stuck</title></head>
<body style="font:16px system-ui,sans-serif;padding:24px">
  <h1 data-test="title">Shop</h1>
  <script>fetch(${JSON.stringify(HANG_PATH)});</script>
</body></html>
`;

const CALM_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>calm</title></head>
<body style="font:16px system-ui,sans-serif;padding:24px">
  <h1 data-test="title">Shop</h1>
</body></html>
`;

const CONFIG = `app:
  dev: node server.mjs
  readyOn: http://127.0.0.1:$PORT/calm
  readyTimeout: 60s
`;

function flowSource(path: string): string {
  return `version: 1
flow: ${path === '/calm' ? 'calm' : 'stuck'}
viewports: [400x300]
network: { mode: "off" }
steps:
  - id: shop
    goto: ${path}
    waitFor: "[data-test=title]"
    shoot: true
`;
}

let root: string;
let stuck: RunResult;
let calm: RunResult;

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

beforeAll(async () => {
  if (!chromiumAvailable()) return;
  root = await mkdtemp(join(tmpdir(), 'vdiff-settle-'));
  await mkdir(paths.flowsDir(root), { recursive: true });
  await writeFile(paths.configFile(root), CONFIG, 'utf8');
  await writeFile(paths.flowFile(root, 'stuck'), flowSource('/'), 'utf8');
  await writeFile(paths.flowFile(root, 'calm'), flowSource('/calm'), 'utf8');
  await writeFile(join(root, 'server.mjs'), SERVER, 'utf8');
  await writeFile(join(root, 'stuck.html'), STUCK_HTML, 'utf8');
  await writeFile(join(root, 'calm.html'), CALM_HTML, 'utf8');

  stuck = await runFlow({ flow: 'stuck', cwd: root });
  calm = await runFlow({ flow: 'calm', cwd: root });
}, 240_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describeIfBrowser('a page that never settles', () => {
  it('still produces the run and the screenshot — the gate reports, it does not fail the step', () => {
    expect(stuck.meta.status).toBe('ok');
    expect(stuck.steps.map((step) => [step.id, step.status])).toEqual([['shop', 'ok']]);
    expect(existsSync(join(stuck.runDir, 'steps/shop/400x300/screenshot.png'))).toBe(true);
  });

  it('raises a settle-timeout run warning naming the outstanding requests', () => {
    const warning = stuck.meta.warnings.find((entry) => entry.kind === 'settle-timeout');
    expect(warning, 'no settle-timeout warning in run warnings').toBeDefined();
    expect(warning?.message).toContain('still in flight');
    expect(warning?.message).toContain('not deterministic');
    expect(warning?.steps).toEqual(['shop']);
    expect(warning?.urls?.some((url) => url.includes(HANG_PATH))).toBe(true);
  });

  it('persists that warning in meta.json, not only in the in-memory result', async () => {
    const meta = await readJson<RunMeta>(
      paths.runMetaFile(root, 'stuck', stuck.meta.runId),
    );
    const warning = meta.warnings.find((entry) => entry.kind === 'settle-timeout');
    expect(warning, 'settle-timeout warning did not reach meta.json').toBeDefined();
    expect(warning?.steps).toEqual(['shop']);
    expect(warning?.urls?.some((url) => url.includes(HANG_PATH))).toBe(true);
  });

  it('records the in-flight count and the urls on the step itself, in step.json', async () => {
    const step = await readJson<StepResult>(
      paths.stepResultFile(root, 'stuck', stuck.meta.runId, 'shop'),
    );
    expect(step.unsettled, 'step.json carries no `unsettled` record').toBeDefined();
    expect(step.unsettled?.inFlight).toBeGreaterThanOrEqual(1);
    // The gate waits out its full deadline before reporting; it never gives up early or extends.
    expect(step.unsettled?.waitedMs).toBeGreaterThanOrEqual(9_000);
    expect(step.unsettled?.urls.some((url) => url.includes(HANG_PATH))).toBe(true);

    // The in-memory step result and the persisted one are the same record.
    expect(stuck.steps[0]?.unsettled).toEqual(step.unsettled);
  });
});

describeIfBrowser('a page that settles', () => {
  it('says nothing at all — a clean gate is not news', async () => {
    expect(calm.meta.warnings.map((warning) => warning.kind)).not.toContain('settle-timeout');

    const step = await readJson<StepResult>(
      paths.stepResultFile(root, 'calm', calm.meta.runId, 'shop'),
    );
    // Absent, not a zero record: `"unsettled": { "inFlight": 0 }` would read as a reported problem.
    expect('unsettled' in step).toBe(false);
    expect(calm.steps[0]?.unsettled).toBeUndefined();
  });
});
