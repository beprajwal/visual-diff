/**
 * Golden tests for the diff engine (spec §11.3): small synthetic run directories in, a whole
 * `findings.json` out. Fast, hermetic, no browser.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiffResult, DomNode, Finding, StepDiff } from '../types.js';
import { computeDiff, defaultDiffOptions } from './engine.js';
import { createImage, decodePng } from './pixel.js';
import {
  consoleEntry,
  domNode,
  networkEntry,
  paintRect,
  solidImage,
  writeRunFixture,
} from './testkit.js';
import type { FixtureRun } from './testkit.js';

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const RED: [number, number, number, number] = [204, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 204, 255];

const BUTTON_RECT = { x: 20, y: 20, w: 80, h: 30 };

function pageBody(w: number, h: number): DomNode {
  return domNode({ path: 'html>body', rect: { x: 0, y: 0, w, h }, tag: 'body' });
}

function payButton(text: string, background: string, name: string): DomNode {
  return domNode({
    path: 'html>body>button',
    parent: 'html>body',
    tag: 'button',
    testId: 'pay',
    attrs: { 'data-test': 'pay' },
    role: 'button',
    name,
    text,
    rect: BUTTON_RECT,
    styles: { backgroundColor: background, color: 'rgb(255, 255, 255)' },
  });
}

function cartShot() {
  return {
    viewport: '1280x800',
    image: paintRect(solidImage(120, 60, WHITE), { x: 5, y: 5, w: 40, h: 20 }, [10, 80, 200, 255]),
    nodes: [
      pageBody(120, 60),
      domNode({
        path: 'html>body>ul',
        parent: 'html>body',
        tag: 'ul',
        rect: { x: 5, y: 5, w: 40, h: 20 },
        text: 'One item',
      }),
    ],
  };
}

function baseRun(runId: string): FixtureRun {
  return {
    runId,
    flow: 'checkout',
    steps: [
      { id: 'cart', spec: { goto: '/cart' }, shots: [cartShot()] },
      {
        id: 'pay-form',
        spec: { click: '#pay' },
        shots: [
          {
            viewport: '1280x800',
            image: paintRect(solidImage(200, 100, WHITE), BUTTON_RECT, RED),
            nodes: [pageBody(200, 100), payButton('Pay', 'rgb(204, 0, 0)', 'Pay')],
          },
        ],
        network: [networkEntry('pay-form', 'http://localhost:5173/api/cart')],
      },
      {
        id: 'legacy',
        spec: { goto: '/legacy' },
        shots: [
          {
            viewport: '1280x800',
            image: solidImage(80, 40, WHITE),
            nodes: [pageBody(80, 40)],
          },
        ],
      },
    ],
  };
}

function headRun(runId: string): FixtureRun {
  return {
    runId,
    flow: 'checkout',
    steps: [
      { id: 'cart', spec: { goto: '/cart' }, shots: [cartShot()] },
      {
        id: 'pay-form',
        spec: { click: '[data-test=pay]' },
        shots: [
          {
            viewport: '1280x800',
            image: paintRect(solidImage(200, 100, WHITE), BUTTON_RECT, BLUE),
            nodes: [pageBody(200, 100), payButton('Pay now', 'rgb(0, 0, 204)', 'Pay now')],
          },
        ],
        console: [consoleEntry('pay-form', 'error', 'TypeError: total is not a function')],
        network: [
          networkEntry('pay-form', 'http://localhost:5173/api/cart'),
          networkEntry('pay-form', 'http://localhost:5173/api/fees', { harMatch: 'miss', status: null }),
        ],
      },
      {
        id: 'receipt',
        spec: { waitFor: 'text=Thanks' },
        shots: [
          {
            viewport: '1280x800',
            image: solidImage(200, 100, WHITE),
            nodes: [pageBody(200, 100)],
          },
        ],
      },
    ],
  };
}

function stepOf(result: DiffResult, id: string): StepDiff {
  const step = result.steps.find((s) => s.id === id);
  if (step === undefined) throw new Error(`no step ${id} in result`);
  return step;
}

function viewportFindings(result: DiffResult, id: string): Finding[] {
  return stepOf(result, id).viewports['1280x800']?.findings ?? [];
}

describe('computeDiff', () => {
  let tmp: string;
  let vdiffDir: string;
  let result: DiffResult;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'vdiff-diff-'));
    vdiffDir = path.join(tmp, '.visual-diff');
    await writeRunFixture(path.join(vdiffDir, 'runs', 'checkout', '0003'), baseRun('0003'));
    await writeRunFixture(path.join(vdiffDir, 'runs', 'checkout', '0007'), headRun('0007'));

    result = await computeDiff({
      baseRunDir: path.join(vdiffDir, 'runs', 'checkout', '0003'),
      headRunDir: path.join(vdiffDir, 'runs', 'checkout', '0007'),
      vdiffDir,
      options: defaultDiffOptions({ deviceScaleFactor: 1 }),
    });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('buckets every step exactly once, aligned by id', () => {
    expect(result.flowDiff.map((e) => [e.id, e.status])).toEqual([
      ['cart', 'matched'],
      ['pay-form', 'spec-changed'],
      ['legacy', 'removed'],
      ['receipt', 'added'],
    ]);
    expect(result.flowDiff.find((e) => e.id === 'pay-form')?.detail).toBe(
      "selector '#pay' -> '[data-test=pay]'",
    );
  });

  it('finds nothing on an unchanged step', () => {
    const cart = stepOf(result, 'cart');
    expect(cart.findings).toEqual([]);
    expect(cart.viewports['1280x800']?.pixelChangedRatio).toBe(0);
    expect(cart.viewports['1280x800']?.regions).toEqual([]);
    expect(cart.viewports['1280x800']?.findings).toEqual([]);
  });

  it('attributes the changed pixels to the Pay button and names the change', () => {
    const findings = viewportFindings(result, 'pay-form');

    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.every((f) => f.element?.selector === '[data-test="pay"]')).toBe(true);
    expect(findings.every((f) => f.region !== undefined)).toBe(true);

    const text = findings.find((f) => f.nodeChange === 'text');
    expect(text?.kind).toBe('content');
    expect(text?.changes).toEqual([{ prop: 'text', from: 'Pay', to: 'Pay now' }]);
    expect(text?.region).toEqual(BUTTON_RECT);

    const style = findings.find((f) => f.nodeChange === 'style');
    expect(style?.kind).toBe('style');
    expect(style?.changes).toEqual([
      { prop: 'backgroundColor', from: 'rgb(204, 0, 0)', to: 'rgb(0, 0, 204)' },
    ]);
  });

  it('reports a new console error as high severity, scoped to the step', () => {
    const consoleFinding = stepOf(result, 'pay-form').findings.find((f) => f.kind === 'console');

    expect(consoleFinding?.severity).toBe('high');
    expect(consoleFinding?.viewport).toBeUndefined();
    expect(consoleFinding?.reasons).toContain('new-console-error');
  });

  it('reports the new request and its HAR miss', () => {
    const network = stepOf(result, 'pay-form').findings.filter((f) => f.kind === 'network');

    expect(network.map((f) => f.reasons[0]).sort()).toEqual(['har-miss', 'request-added']);
  });

  it('reports added and removed steps structurally and marks the missing side', () => {
    const added = stepOf(result, 'receipt');
    expect(added.status).toBe('added');
    expect(added.findings[0]).toMatchObject({ kind: 'structural', reasons: ['step-added'] });
    expect(added.viewports['1280x800']?.missing).toBe('base');

    const removed = stepOf(result, 'legacy');
    expect(removed.status).toBe('removed');
    expect(removed.findings[0]).toMatchObject({ kind: 'structural', reasons: ['step-removed'] });
    expect(removed.viewports['1280x800']?.missing).toBe('head');
  });

  it('numbers findings uniquely across the whole result', () => {
    const ids = result.steps.flatMap((s) => [
      ...s.findings.map((f) => f.id),
      ...Object.values(s.viewports).flatMap((v) => v.findings.map((f) => f.id)),
    ]);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ids.map((_, i) => `f${i + 1}`));
    expect(result.summary.totalFindings).toBe(ids.length);
  });

  it('summarizes the pair', () => {
    expect(result.summary).toMatchObject({
      stepsCompared: 2,
      stepsAdded: 1,
      stepsRemoved: 1,
      stepsSpecChanged: 1,
      stepsFailed: 0,
      stepsBlocked: 0,
    });
    expect(result.summary.bySeverity.high).toBeGreaterThanOrEqual(1);
    expect(result.summary.maxPixelChangedRatio).toBeGreaterThan(0);
  });

  it('writes findings.json, the pixel overlay, regions and one crop per region finding', async () => {
    const outDir = path.join(vdiffDir, 'diffs', 'checkout', '0003..0007');

    const onDisk = JSON.parse(await readFile(path.join(outDir, 'findings.json'), 'utf8')) as DiffResult;
    expect(onDisk.pair).toEqual({ base: '0003', head: '0007' });

    const vp = stepOf(result, 'pay-form').viewports['1280x800'];
    expect(vp?.pixelPath).toBe('diffs/checkout/0003..0007/steps/pay-form/1280x800/pixel.png');
    expect(vp?.regionsPath).toBe('diffs/checkout/0003..0007/steps/pay-form/1280x800/regions.json');
    await expect(stat(path.join(vdiffDir, vp?.pixelPath ?? ''))).resolves.toBeTruthy();

    const regions = JSON.parse(
      await readFile(path.join(vdiffDir, vp?.regionsPath ?? ''), 'utf8'),
    ) as { regions: Array<{ rect: unknown }> };
    expect(regions.regions).toHaveLength(1);
    expect(regions.regions[0]?.rect).toEqual(BUTTON_RECT);

    for (const finding of viewportFindings(result, 'pay-form')) {
      expect(finding.crop).toBe(`diffs/checkout/0003..0007/crops/${finding.id}.png`);
      const crop = decodePng(await readFile(path.join(vdiffDir, finding.crop ?? '')));
      // The region plus 8px of context on every side, clipped to the page.
      expect(crop.width).toBe(BUTTON_RECT.w + 16);
      expect(crop.height).toBe(BUTTON_RECT.h + 16);
    }
  });

  it('serves a cached result and recomputes only when forced', async () => {
    const outDir = path.join(vdiffDir, 'diffs', 'checkout', '0003..0007');
    const findingsPath = path.join(outDir, 'findings.json');
    const stored = JSON.parse(await readFile(findingsPath, 'utf8')) as DiffResult;
    stored.computedAt = '1999-01-01T00:00:00.000Z';
    await writeFile(findingsPath, JSON.stringify(stored, null, 2));

    const request = {
      baseRunDir: path.join(vdiffDir, 'runs', 'checkout', '0003'),
      headRunDir: path.join(vdiffDir, 'runs', 'checkout', '0007'),
      vdiffDir,
      options: defaultDiffOptions({ deviceScaleFactor: 1 }),
    };

    const cached = await computeDiff(request);
    expect(cached.computedAt).toBe('1999-01-01T00:00:00.000Z');

    const forced = await computeDiff({
      ...request,
      options: defaultDiffOptions({ deviceScaleFactor: 1, force: true }),
    });
    expect(forced.computedAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(forced.summary.totalFindings).toBe(result.summary.totalFindings);
  });

  it('misses the cache when the engine version moves', async () => {
    const bumped = await computeDiff({
      baseRunDir: path.join(vdiffDir, 'runs', 'checkout', '0003'),
      headRunDir: path.join(vdiffDir, 'runs', 'checkout', '0007'),
      vdiffDir,
      options: defaultDiffOptions({ deviceScaleFactor: 1, engineVersion: '999' }),
    });

    expect(bumped.engineVersion).toBe('999');
  });
});

describe('determinism', () => {
  it('finds nothing between two identical runs', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'vdiff-same-'));
    const vdiffDir = path.join(tmp, '.visual-diff');
    try {
      await writeRunFixture(path.join(vdiffDir, 'runs', 'checkout', '0001'), baseRun('0001'));
      await writeRunFixture(path.join(vdiffDir, 'runs', 'checkout', '0002'), baseRun('0002'));

      const same = await computeDiff({
        baseRunDir: path.join(vdiffDir, 'runs', 'checkout', '0001'),
        headRunDir: path.join(vdiffDir, 'runs', 'checkout', '0002'),
        vdiffDir,
        options: defaultDiffOptions({ deviceScaleFactor: 1 }),
      });

      expect(same.summary.totalFindings).toBe(0);
      expect(same.summary.maxPixelChangedRatio).toBe(0);
      expect(same.flowDiff.every((e) => e.status === 'matched')).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('page size changes', () => {
  it('is a finding in its own right, and the common area is still compared', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'vdiff-grow-'));
    const vdiffDir = path.join(tmp, '.visual-diff');
    try {
      const short: FixtureRun = {
        runId: '0001',
        steps: [
          {
            id: 'cart',
            shots: [
              { viewport: '1280x800', image: solidImage(100, 100, WHITE), nodes: [pageBody(100, 100)] },
            ],
          },
        ],
      };
      const tall: FixtureRun = {
        runId: '0002',
        steps: [
          {
            id: 'cart',
            shots: [
              { viewport: '1280x800', image: solidImage(100, 260, WHITE), nodes: [pageBody(100, 260)] },
            ],
          },
        ],
      };
      await writeRunFixture(path.join(vdiffDir, 'runs', 'checkout', '0001'), short);
      await writeRunFixture(path.join(vdiffDir, 'runs', 'checkout', '0002'), tall);

      const grown = await computeDiff({
        baseRunDir: path.join(vdiffDir, 'runs', 'checkout', '0001'),
        headRunDir: path.join(vdiffDir, 'runs', 'checkout', '0002'),
        vdiffDir,
        options: defaultDiffOptions({ deviceScaleFactor: 1 }),
      });

      const vp = grown.steps[0]?.viewports['1280x800'];
      expect(vp?.dimensionsChanged).toBe(true);
      expect(vp?.baseSize).toEqual({ w: 100, h: 100 });
      expect(vp?.headSize).toEqual({ w: 100, h: 260 });
      // The shared area is untouched, so this is not reported as 100% changed.
      expect(vp?.pixelChangedRatio).toBe(0);

      const sizeFinding = vp?.findings.find((f) => f.reasons.includes('dimensions-changed'));
      expect(sizeFinding?.kind).toBe('layout');
      expect(sizeFinding?.severity).toBe('high');
      expect(sizeFinding?.changes).toEqual([{ prop: 'height', from: 100, to: 260 }]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('masked regions', () => {
  it('never produces a finding for a masked clock', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'vdiff-mask-'));
    const vdiffDir = path.join(tmp, '.visual-diff');
    try {
      const clock = { x: 10, y: 10, w: 40, h: 20 };
      const run = (runId: string, colour: [number, number, number, number]): FixtureRun => ({
        runId,
        steps: [
          {
            id: 'cart',
            spec: { mask: ['[data-test=clock]'] },
            shots: [
              {
                viewport: '1280x800',
                image: paintRect(createImage(100, 60, WHITE), clock, colour),
                masks: [clock],
                nodes: [pageBody(100, 60)],
              },
            ],
          },
        ],
      });

      await writeRunFixture(path.join(vdiffDir, 'runs', 'checkout', '0001'), run('0001', RED));
      await writeRunFixture(path.join(vdiffDir, 'runs', 'checkout', '0002'), run('0002', BLUE));

      const masked = await computeDiff({
        baseRunDir: path.join(vdiffDir, 'runs', 'checkout', '0001'),
        headRunDir: path.join(vdiffDir, 'runs', 'checkout', '0002'),
        vdiffDir,
        options: defaultDiffOptions({ deviceScaleFactor: 1 }),
      });

      const vp = masked.steps[0]?.viewports['1280x800'];
      expect(vp?.pixelChangedRatio).toBeGreaterThan(0);
      expect(vp?.regions).toEqual([]);
      expect(vp?.findings).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
