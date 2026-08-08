import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeDomNode, writeFixtureRun } from './fixtures.js';
import { loadRun } from './run-load.js';
import * as paths from './paths.js';
import { pruneRun } from './retention.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-load-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('loadRun', () => {
  it('returns steps in flow.snapshot.yaml order, not directory order', async () => {
    // Directory listings sort alphabetically; the snapshot order is cart, pay-form, receipt.
    const run = await writeFixtureRun({
      root: tmp,
      flow: 'checkout',
      steps: [{ id: 'receipt' }, { id: 'cart' }, { id: 'pay-form' }],
    });
    const loaded = await loadRun(tmp, 'checkout', run.runId);
    expect(loaded.steps.map((step) => step.result.id)).toEqual(['receipt', 'cart', 'pay-form']);
    expect(Object.keys(loaded.stepsById).sort()).toEqual(['cart', 'pay-form', 'receipt']);
  });

  it('loads meta, snapshot and every shot', async () => {
    const run = await writeFixtureRun({
      root: tmp,
      flow: 'checkout',
      steps: [{ id: 'cart', nodes: [makeDomNode({ testId: 'cart-list' })] }],
      viewports: ['1280x800', '390x844'],
    });
    const loaded = await loadRun(tmp, 'checkout', run.runId);

    expect(loaded.meta.runId).toBe(run.runId);
    expect(loaded.flow.flow).toBe('checkout');
    expect(loaded.flow.viewports).toEqual(['1280x800', '390x844']);

    const cart = loaded.stepsById['cart'];
    expect(Object.keys(cart?.shots ?? {}).sort()).toEqual(['1280x800', '390x844']);
    const desktop = cart?.shots['1280x800'];
    expect(desktop?.dom.nodes[0]?.testId).toBe('cart-list');
    expect(desktop?.size).toEqual({ w: 1, h: 1 });
    expect(desktop?.a11y?.root?.role).toBe('WebArea');
    expect(path.isAbsolute(desktop?.screenshotPath ?? '')).toBe(true);
  });

  it('treats a missing shot as absent rather than throwing', async () => {
    const run = await writeFixtureRun({
      root: tmp,
      flow: 'checkout',
      steps: [{ id: 'cart' }, { id: 'pay-form', viewports: [] }],
    });
    const loaded = await loadRun(tmp, 'checkout', run.runId);
    expect(Object.keys(loaded.stepsById['pay-form']?.shots ?? {})).toEqual([]);
    expect(loaded.stepsById['pay-form']?.result.status).toBe('ok');
  });

  it('drops a shot whose screenshot was removed, without failing the run', async () => {
    const run = await writeFixtureRun({
      root: tmp,
      flow: 'checkout',
      steps: [{ id: 'cart' }],
    });
    await fsp.rm(
      path.join(paths.runDir(tmp, 'checkout', run.runId), 'steps', 'cart', '1280x800', 'screenshot.png'),
    );
    const loaded = await loadRun(tmp, 'checkout', run.runId);
    expect(Object.keys(loaded.stepsById['cart']?.shots ?? {})).toEqual([]);
  });

  it('still loads a pruned run, whose blobs are gone but whose snapshot survives', async () => {
    const run = await writeFixtureRun({
      root: tmp,
      flow: 'checkout',
      steps: [{ id: 'cart' }, { id: 'pay-form' }],
    });
    await pruneRun(tmp, 'checkout', run.runId);

    const loaded = await loadRun(tmp, 'checkout', run.runId);
    expect(loaded.meta.pruned).toBe(true);
    // The timeline stays intact: every step of the flow is still a row, with no shots behind it.
    expect(loaded.steps.map((step) => step.result.id)).toEqual(['cart', 'pay-form']);
    expect(loaded.steps.every((step) => Object.keys(step.shots).length === 0)).toBe(true);
    expect(loaded.steps.every((step) => step.result.status === 'skipped')).toBe(true);
    expect(loaded.steps.map((step) => step.result.index)).toEqual([0, 1]);
  });

  it('reads the per-step console and network windows', async () => {
    const run = await writeFixtureRun({
      root: tmp,
      flow: 'checkout',
      steps: [
        {
          id: 'cart',
          console: [
            {
              step: 'cart',
              viewport: '1280x800',
              level: 'error',
              text: 'boom',
              ts: '2026-08-08T10:00:00.000Z',
            },
          ],
          network: [
            {
              step: 'cart',
              viewport: '1280x800',
              method: 'GET',
              url: 'http://localhost:5173/api/cart',
              status: 200,
              resourceType: 'fetch',
              harMatch: 'hit',
              durationMs: 12,
            },
          ],
        },
      ],
    });
    const loaded = await loadRun(tmp, 'checkout', run.runId);
    expect(loaded.stepsById['cart']?.console[0]?.text).toBe('boom');
    expect(loaded.stepsById['cart']?.network[0]?.harMatch).toBe('hit');
  });

  it('can skip shot decoding when only metadata is wanted', async () => {
    const run = await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    const loaded = await loadRun(tmp, 'checkout', run.runId, { shots: false });
    expect(Object.keys(loaded.stepsById['cart']?.shots ?? {})).toEqual([]);
    expect(loaded.meta.flow).toBe('checkout');
  });

  it('rejects a directory that is not a run', async () => {
    await expect(loadRun(tmp, 'checkout', '0009')).rejects.toThrow(/meta\.json/);
  });
});
