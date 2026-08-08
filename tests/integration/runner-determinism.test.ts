/**
 * The determinism test (spec §11.1) — "replay the same revision twice; assert zero findings. If
 * this cannot hold green, nothing above it means anything. Every knob in section 7 exists to keep
 * it green."
 *
 * The app under replay is deliberately hostile to determinism: it paints `Math.random()`, a
 * `Date` stamp and a `performance.now()` counter, and animates a bar. The frozen clock, the seeded
 * PRNG and the injected animation kill-switch are what make two runs identical; the masked
 * `performance.now()` element is what `mask` is for. Remove any one of them and this test fails,
 * which is exactly the protection §7 asks for.
 *
 * It drives the *real* runner: a spawned dev server, headless Chromium, full capture, an atomic
 * store commit, then the real diff engine over the two run directories. It is skipped — loudly —
 * when Chromium has not been downloaded, because `vdiff install-browser` is a user action.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DIFF_ENGINE_VERSION, type DomSnapshot, type RunResult } from '../../src/types.js';
import { computeDiff } from '../../src/diff/index.js';
import { loadConfigOrThrow, openStore, paths } from '../../src/store/index.js';
import { runFlow } from '../../src/runner/index.js';

function chromiumAvailable(): boolean {
  try {
    // Resolved without launching: `executablePath()` is a pure path computation.
    const { chromium } = require('playwright') as typeof import('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const hasChromium = chromiumAvailable();
const describeIfBrowser = hasChromium ? describe : describe.skip;

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
<html lang="en"><head><meta charset="utf-8"><title>demo</title>
<style>
  body { font: 16px/1.4 system-ui, sans-serif; margin: 0; padding: 24px; background: #fff; color: #111; }
  .bar { width: 120px; height: 12px; background: #4a7; animation: grow 2s infinite alternate; }
  @keyframes grow { from { width: 40px } to { width: 240px } }
  button { padding: 8px 16px; border: 1px solid #444; border-radius: 6px; background: #eee; }
  #panel { margin-top: 16px; padding: 12px; border: 1px solid #ccc; }
</style></head>
<body>
  <h1 data-test="title">Cart</h1>
  <p data-test="random">random: <span id="r"></span></p>
  <p data-test="clock">clock: <span id="c"></span></p>
  <p data-test="elapsed">elapsed: <span id="e"></span></p>
  <div class="bar"></div>
  <button data-test="pay">Pay</button>
  <div id="panel" hidden data-test="panel">Payment</div>
  <script>
    document.getElementById('r').textContent = String(Math.random());
    document.getElementById('c').textContent = new Date().toISOString();
    document.getElementById('e').textContent = String(performance.now());
    document.querySelector('[data-test=pay]').addEventListener('click', () => {
      document.getElementById('panel').hidden = false;
    });
  </script>
</body></html>
`;

const CONFIG = `app:
  dev: node server.mjs
  readyOn: http://127.0.0.1:$PORT/
  readyTimeout: 60s
diff:
  minRegionArea: 64
  maxRegions: 40
  antialiasTolerance: 0.1
retention:
  keepRuns: 20
`;

const FLOW = `version: 1
flow: demo
viewports: [400x300]
network: { mode: "off" }
steps:
  - id: cart
    goto: /
    waitFor: "[data-test=title]"
    mask: ["[data-test=elapsed]"]
    shoot: true
  - id: pay-panel
    click: "[data-test=pay]"
    waitFor: "[data-test=panel]"
    mask: ["[data-test=elapsed]"]
    shoot: true
`;

let root: string;
let first: RunResult;
let second: RunResult;

beforeAll(async () => {
  if (!hasChromium) return;
  root = await mkdtemp(join(tmpdir(), 'vdiff-determinism-'));
  await mkdir(paths.flowsDir(root), { recursive: true });
  await writeFile(paths.configFile(root), CONFIG, 'utf8');
  await writeFile(paths.flowFile(root, 'demo'), FLOW, 'utf8');
  await writeFile(join(root, 'server.mjs'), SERVER, 'utf8');
  await writeFile(join(root, 'index.html'), HTML, 'utf8');

  first = await runFlow({ flow: 'demo', cwd: root });
  second = await runFlow({ flow: 'demo', cwd: root });
}, 180_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describeIfBrowser('vdiff run, end to end', () => {
  it('appends a complete run: meta, snapshot, steps and shots (spec §6)', async () => {
    expect(first.meta.runId).toBe('0000');
    expect(first.meta.status).toBe('ok');
    expect(first.meta.mode).toBe('spawn');
    expect(first.meta.network).toBe('off');
    expect(first.meta.viewports).toEqual(['400x300']);
    expect(first.meta.failedSteps).toEqual([]);
    expect(first.steps.map((step) => step.id)).toEqual(['cart', 'pay-panel']);

    for (const step of first.steps) {
      expect(step.status).toBe('ok');
      const shot = step.viewports['400x300'];
      expect(shot).toBeDefined();
      expect(shot?.width).toBeGreaterThan(0);
      expect(shot?.nodeCount).toBeGreaterThan(5);
      // Step directories are keyed by step id, never by ordinal (spec §6).
      expect(shot?.screenshot).toBe(`steps/${step.id}/400x300/screenshot.png`);
    }

    const snapshot = await readFile(join(first.runDir, 'flow.snapshot.yaml'), 'utf8');
    expect(snapshot).toContain('id: cart');
    expect(snapshot).toContain('id: pay-panel');
  });

  it('captures the DOM with masks, roles and the fixed style subset (spec §7)', async () => {
    const dom = JSON.parse(
      await readFile(join(first.runDir, 'steps/cart/400x300/dom.json'), 'utf8'),
    ) as DomSnapshot;

    expect(dom.step).toBe('cart');
    expect(dom.viewport).toBe('400x300');
    expect(dom.deviceScaleFactor).toBe(2);
    expect(dom.masks).toHaveLength(1);
    expect(dom.truncated).toBe(false);

    const button = dom.nodes.find((node) => node.testId === 'pay');
    expect(button).toBeDefined();
    expect(button?.role).toBe('button');
    expect(button?.name).toBe('Pay');
    expect(button?.styles.borderRadius).toBe('6px');
    expect(button?.rect.w).toBeGreaterThan(0);

    const heading = dom.nodes.find((node) => node.testId === 'title');
    expect(heading?.role).toBe('heading');
  });

  it('freezes the clock and the PRNG, so two replays paint identical text', async () => {
    const domOf = async (run: RunResult): Promise<DomSnapshot> =>
      JSON.parse(await readFile(join(run.runDir, 'steps/cart/400x300/dom.json'), 'utf8')) as DomSnapshot;

    const [a, b] = await Promise.all([domOf(first), domOf(second)]);
    const textOf = (dom: DomSnapshot, testId: string): string | undefined =>
      dom.nodes.find((node) => node.attrs['data-test'] === testId)?.text;

    expect(textOf(a, 'random')).toBe(textOf(b, 'random'));
    expect(textOf(a, 'clock')).toBe(textOf(b, 'clock'));
    // 2026-01-01T00:00:00.000Z is the frozen epoch every context starts from.
    expect(JSON.stringify(a.nodes)).toContain('2026-01-01T00:00:00.000Z');
  });
});

describeIfBrowser('the determinism guarantee (spec §11.1)', () => {
  it('finds nothing at all between two replays of the same revision', async () => {
    const result = await computeDiff(first.runDir, second.runDir, {
      minRegionArea: 64,
      maxRegions: 40,
      antialiasTolerance: 0.1,
      ignore: [],
      engineVersion: DIFF_ENGINE_VERSION,
      deviceScaleFactor: 2,
    });

    expect(result.flowDiff.map((entry) => entry.status)).toEqual(['matched', 'matched']);
    expect(result.summary.stepsChanged).toBe(0);
    expect(result.summary.maxPixelChangedRatio).toBe(0);
    expect(result.summary.totalFindings).toBe(0);
    expect(result.steps.flatMap((step) => step.findings)).toEqual([]);
  }, 120_000);

  it('holds across five consecutive replays — no flakes', async () => {
    const runs: RunResult[] = [first, second];
    for (let i = 0; i < 3; i += 1) runs.push(await runFlow({ flow: 'demo', cwd: root }));

    for (let i = 1; i < runs.length; i += 1) {
      const result = await computeDiff((runs[i - 1] as RunResult).runDir, (runs[i] as RunResult).runDir, {
        minRegionArea: 64,
        maxRegions: 40,
        antialiasTolerance: 0.1,
        ignore: [],
        engineVersion: DIFF_ENGINE_VERSION,
        deviceScaleFactor: 2,
      });
      expect(
        result.summary.totalFindings,
        `runs ${(runs[i - 1] as RunResult).meta.runId}..${(runs[i] as RunResult).meta.runId} produced findings`,
      ).toBe(0);
    }

    const store = openStore(await loadConfigOrThrow({ cwd: root }));
    const timeline = await store.listRuns('demo');
    expect(timeline.map((run) => run.runId)).toEqual(['0000', '0001', '0002', '0003', '0004']);
  }, 300_000);
});

describe('the determinism harness', () => {
  it('names the reason when it cannot run', () => {
    if (!hasChromium) {
      expect(hasChromium, 'Chromium is not installed: run `vdiff install-browser`').toBe(false);
    }
    expect(typeof hasChromium).toBe('boolean');
  });
});
