/**
 * Step failure (spec §7 "Step failure", §10).
 *
 * "Steps are stateful and sequential, so a failure invalidates everything downstream. On failure:
 * record the error, the DOM at failure, and a screenshot; mark remaining steps `skipped(blocked)`;
 * set run `status: partial`. The report still renders a full rectangular grid with explicit blocked
 * cells rather than a truncated flow. `--continue-on-error` re-anchors at the next `goto` step."
 *
 * Every clause of that paragraph is one assertion below, driven through the real runner.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunResult } from '../../src/types.js';
import { loadConfigOrThrow, openStore, paths } from '../../src/store/index.js';
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

const SERVER = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>demo</title></head>
<body style="font:16px system-ui,sans-serif;padding:24px">
  <h1 data-test="title">Cart</h1>
</body></html>
`;

const CONFIG = `app:
  dev: node server.mjs
  readyOn: http://127.0.0.1:$PORT/
  readyTimeout: 60s
`;

/** `pay` never exists, so step two fails and everything after it is blocked. */
const FLOW = `version: 1
flow: demo
viewports: [400x300]
network: { mode: "off" }
steps:
  - id: cart
    goto: /
    waitFor: "[data-test=title]"
    shoot: true
  - id: pay-form
    click: "[data-test=pay]"
    shoot: true
  - id: receipt
    goto: /
    waitFor: "[data-test=title]"
    shoot: true
  - id: print
    click: "[data-test=print]"
    shoot: true
`;

let root: string;
let blocked: RunResult;
let continued: RunResult;

beforeAll(async () => {
  if (!chromiumAvailable()) return;
  root = await mkdtemp(join(tmpdir(), 'vdiff-step-failure-'));
  await mkdir(paths.flowsDir(root), { recursive: true });
  await writeFile(paths.configFile(root), CONFIG, 'utf8');
  await writeFile(paths.flowFile(root, 'demo'), FLOW, 'utf8');
  await writeFile(join(root, 'server.mjs'), SERVER, 'utf8');
  await writeFile(join(root, 'index.html'), HTML, 'utf8');

  blocked = await runFlow({ flow: 'demo', cwd: root });
  continued = await runFlow({ flow: 'demo', cwd: root, continueOnError: true });
}, 240_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describeIfBrowser('a failing step', () => {
  it('makes the run partial and blocks everything downstream', () => {
    expect(blocked.meta.status).toBe('partial');
    expect(blocked.meta.failedSteps).toEqual(['pay-form']);
    expect(blocked.steps.map((step) => [step.id, step.status])).toEqual([
      ['cart', 'ok'],
      ['pay-form', 'failed'],
      ['receipt', 'blocked'],
      ['print', 'blocked'],
    ]);
    // A rectangular grid: every step of the flow has a row, none is truncated away.
    expect(blocked.steps).toHaveLength(4);
    expect(blocked.meta.warnings.map((warning) => warning.kind)).toContain('step-blocked');
  });

  it('records the error, the failure DOM and a failure screenshot (spec §7)', async () => {
    const failed = blocked.steps.find((step) => step.id === 'pay-form');
    expect(failed?.failure?.verb).toBe('click');
    expect(failed?.failure?.selector).toBe('[data-test=pay]');
    expect(failed?.failure?.message).toContain('[data-test=pay]');

    const screenshot = failed?.failure?.screenshot;
    const dom = failed?.failure?.dom;
    expect(screenshot).toBeDefined();
    expect(dom).toBeDefined();
    expect(existsSync(join(blocked.runDir, screenshot as string))).toBe(true);
    const failureDom = JSON.parse(await readFile(join(blocked.runDir, dom as string), 'utf8')) as {
      step: string;
      nodes: unknown[];
    };
    expect(failureDom.step).toBe('pay-form');
    expect(failureDom.nodes.length).toBeGreaterThan(0);
  });

  it('still appends the run, so the evidence survives the failure', async () => {
    const store = openStore(await loadConfigOrThrow({ cwd: root }));
    const timeline = await store.listRuns('demo');
    expect(timeline.map((run) => [run.runId, run.status])).toEqual([
      ['0000', 'partial'],
      ['0001', 'partial'],
    ]);
    expect(existsSync(join(blocked.runDir, 'steps/cart/400x300/screenshot.png'))).toBe(true);
  });
});

describeIfBrowser('--continue-on-error', () => {
  it('re-anchors at the next goto step, leaving only the tail of that segment blocked', () => {
    expect(continued.steps.map((step) => [step.id, step.status])).toEqual([
      ['cart', 'ok'],
      ['pay-form', 'failed'],
      // `receipt` is the next `goto`: the flow resumes there.
      ['receipt', 'ok'],
      ['print', 'failed'],
    ]);
    expect(continued.meta.status).toBe('partial');
    expect(continued.meta.failedSteps).toEqual(['pay-form', 'print']);
  });
});
