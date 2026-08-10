import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeE2eRunMeta, writeFixtureRun } from './fixtures.js';
import { openStore } from './index.js';
import { parseConfigSource } from './config.js';
import type { Config } from '../types.js';

let tmp: string;
let config: Config;

const CONFIG_SOURCE = [
  'app:',
  '  dev: pnpm dev --port $PORT',
  '  readyOn: http://localhost:$PORT/',
  'retention:',
  '  keepRuns: 2',
].join('\n');

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-store-')));
  const parsed = parseConfigSource(CONFIG_SOURCE, path.join(tmp, '.visual-diff', 'config.yaml'), tmp);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  config = parsed.value;
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('openStore', () => {
  it('binds one project root across every operation', async () => {
    const store = openStore(config);
    expect(store.root).toBe(tmp);
    expect(store.dir).toBe(path.join(tmp, '.visual-diff'));
    expect(store.runDir('checkout', '0000')).toBe(
      path.join(tmp, '.visual-diff', 'runs', 'checkout', '0000'),
    );
  });

  it('writes, lists, loads and pairs runs', async () => {
    const store = openStore(config);
    await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });

    expect(await store.listFlows()).toEqual(['checkout']);
    expect(await store.listRunIds('checkout')).toEqual(['0000', '0001']);
    expect(await store.latestRunId('checkout')).toBe('0001');
    expect(await store.resolvePair('checkout')).toEqual({
      flow: 'checkout',
      base: '0000',
      head: '0001',
    });

    const loaded = await store.loadRun('checkout', '0001');
    expect(loaded.steps.map((step) => step.result.id)).toEqual(['cart']);

    const rows = await store.listRuns('checkout');
    expect(rows.map((row) => row.runId)).toEqual(['0000', '0001']);
    // No diff has been computed for the pair yet.
    expect(rows[1]?.findingsCount).toBeNull();
  });

  it('applies the configured retention policy', async () => {
    const store = openStore(config);
    for (let i = 0; i < 4; i += 1) {
      await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    }
    const result = await store.applyRetention('checkout');
    expect(result.pruned).toEqual(['0000', '0001']);
    expect((await store.readMeta('checkout', '0000')).pruned).toBe(true);
    expect((await store.readMeta('checkout', '0003')).pruned).toBe(false);
  });

  it('carries the scenario axis through the same bound root (mocking spec §6)', async () => {
    const store = openStore(config);
    for (const scenario of [undefined, 'empty-forecast', undefined, 'empty-forecast']) {
      await writeFixtureRun({
        root: tmp,
        flow: 'forecast',
        steps: [{ id: 'cart' }],
        ...(scenario === undefined ? {} : { meta: { scenario } }),
      });
    }

    expect([...(await store.listRunScenarios('forecast')).values()]).toEqual([
      'none',
      'empty-forecast',
      'none',
      'empty-forecast',
    ]);
    expect((await store.listRuns('forecast', { scenario: 'empty-forecast' })).map((r) => r.runId))
      .toEqual(['0001', '0003']);
    // Same-scenario by default: 0002 sits between the two, and is not the base.
    expect(await store.resolvePair('forecast')).toEqual({
      flow: 'forecast',
      base: '0001',
      head: '0003',
    });
    expect(await store.resolvePair('forecast', undefined, undefined, { scenario: 'none' })).toEqual({
      flow: 'forecast',
      base: '0000',
      head: '0002',
    });
  });

  it('applies retention per (flow, scenario), so one scenario cannot evict another', async () => {
    const store = openStore(config); // keepRuns: 2
    for (const scenario of ['none', 'none', 'none', 'empty-forecast']) {
      await writeFixtureRun({
        root: tmp,
        flow: 'forecast',
        steps: [{ id: 'cart' }],
        meta: { scenario },
      });
    }

    const result = await store.applyRetention('forecast');

    expect(result.pruned).toEqual(['0000']);
    expect((await store.readMeta('forecast', '0003')).pruned).toBe(false);
  });

  it('carries the variant axis through the same bound root (variants spec §5)', async () => {
    const store = openStore(config);
    for (const variant of [undefined, 'denser-forecast', undefined, 'denser-forecast']) {
      await writeFixtureRun({
        root: tmp,
        flow: 'forecast',
        steps: [{ id: 'cart' }],
        meta: variant === undefined ? {} : { variant },
      });
    }

    expect([...(await store.listRunVariants('forecast')).values()]).toEqual([
      'none',
      'denser-forecast',
      'none',
      'denser-forecast',
    ]);
    // Excluded from the regression timeline by default; `--variants` is how you see them (D24).
    expect((await store.listRuns('forecast')).map((r) => r.runId)).toEqual(['0000', '0002']);
    expect((await store.listRuns('forecast', { variants: 'only' })).map((r) => r.runId)).toEqual([
      '0001',
      '0003',
    ]);
    // The proposal question: the fixture runs share a revision, so 0002 is the nearest baseline.
    expect(
      await store.resolvePair('forecast', undefined, undefined, { variant: 'denser-forecast' }),
    ).toEqual({ flow: 'forecast', base: '0002', head: '0003' });
  });

  it('promotes a variant run into the permanent timeline through the edge', async () => {
    const store = openStore(config);
    await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] });
    await writeFixtureRun({
      root: tmp,
      flow: 'forecast',
      steps: [{ id: 'cart' }],
      meta: { variant: 'denser-forecast' },
    });

    expect((await store.listRuns('forecast')).map((r) => r.runId)).toEqual(['0000']);
    await store.keep('forecast', '0001');
    expect((await store.listRuns('forecast')).map((r) => r.runId)).toEqual(['0000', '0001']);
  });

  it('applies the two retention buckets, so proposals never evict capture history', async () => {
    const store = openStore(config); // keepRuns: 2, keepVariantRuns defaulting to 10
    for (let i = 0; i < 3; i += 1) {
      await writeFixtureRun({
        root: tmp,
        flow: 'forecast',
        steps: [{ id: 'cart' }],
        meta: { variant: 'denser-forecast' },
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] });
    }

    const result = await store.applyRetention('forecast');

    // The three proposals are the oldest runs of the flow. Under one bucket of 2 they would all
    // have gone; under two they are inside their own cap of 10 and only the timeline overflows.
    expect(result.pruned).toEqual(['0003']);
  });

  it('round-trips feedback', async () => {
    const store = openStore(config);
    const entry = await store.appendFeedback({
      flow: 'checkout',
      pair: '0000..0001',
      text: 'tighten the padding',
    });
    expect(await store.readPendingFeedback({ flow: 'checkout' })).toHaveLength(1);
    const acked = await store.ackFeedback([entry.id]);
    expect(acked.acked).toHaveLength(1);
    expect(await store.readPendingFeedback()).toEqual([]);
  });

  it('serialises runs of one flow behind the lock', async () => {
    const store = openStore(config);
    const held = await store.acquireLock('checkout');
    await expect(store.acquireLock('checkout')).rejects.toMatchObject({ code: 'locked' });
    await held.release();
    const next = await store.acquireLock('checkout');
    await next.release();
  });

  it('carries the source axis through the same bound root (e2e spec §7)', async () => {
    const store = openStore(config);
    // 0000 replay, 0001 e2e, 0002 replay, 0003 e2e
    await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] });
    await writeFixtureRun({
      root: tmp,
      flow: 'forecast',
      steps: [{ id: 'cart' }],
      meta: makeE2eRunMeta('forecast', { traceHash: 'sha256:one' }),
    });
    await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] });
    await writeFixtureRun({
      root: tmp,
      flow: 'forecast',
      steps: [{ id: 'cart' }],
      meta: makeE2eRunMeta('forecast', { traceHash: 'sha256:two' }),
    });

    expect([...(await store.listRunSources('forecast')).values()]).toEqual([
      'replay',
      'e2e',
      'replay',
      'e2e',
    ]);
    // Excluded from the regression timeline by default; `--e2e` is how you see them (D27).
    expect((await store.listRuns('forecast')).map((r) => r.runId)).toEqual(['0000', '0002']);
    expect((await store.listRuns('forecast', { e2e: 'only' })).map((r) => r.runId)).toEqual([
      '0001',
      '0003',
    ]);
    // E2E pairs with e2e, and the replay default is untouched.
    expect(await store.resolvePair('forecast')).toEqual({
      flow: 'forecast',
      base: '0000',
      head: '0002',
    });
    expect(await store.resolvePair('forecast', undefined, undefined, { source: 'e2e' })).toEqual({
      flow: 'forecast',
      base: '0001',
      head: '0003',
    });
  });

  it('answers the idempotency question an ingest asks before writing (e2e spec §6)', async () => {
    const store = openStore(config);
    const run = await writeFixtureRun({
      root: tmp,
      flow: 'forecast',
      steps: [{ id: 'cart' }],
      meta: makeE2eRunMeta('forecast', {
        traceHash: 'sha256:archive',
        titleKey: 'forecast.spec.ts \u203A forecast \u203A shows the week',
      }),
    });

    expect(await store.findRunByTraceHash('forecast', 'sha256:archive')).toBe(run.runId);
    expect(await store.findRunByTraceHash('forecast', 'sha256:other')).toBeNull();
    expect([...(await store.listE2eRuns('forecast')).keys()]).toEqual([run.runId]);
    expect((await store.e2eFlowIndex()).get('forecast.spec.ts \u203A forecast \u203A shows the week')).toBe(
      'forecast',
    );
  });

  it('applies retention with all three buckets bound from config (e2e spec §7)', async () => {
    const store = openStore(config); // keepRuns: 2, e2e bucket defaults to 20
    for (let i = 0; i < 3; i += 1) {
      await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] });
    }
    for (let i = 0; i < 3; i += 1) {
      await writeFixtureRun({
        root: tmp,
        flow: 'forecast',
        steps: [{ id: 'cart' }],
        meta: makeE2eRunMeta('forecast', { traceHash: `sha256:${i}` }),
      });
    }

    const result = await store.applyRetention('forecast');

    // Only the oldest replay run is over its cap; the ingested runs are well inside theirs, and
    // could not have evicted a replay run in any case.
    expect(result.pruned).toEqual(['0000']);
  });

  it('reads e2e-map.yaml through the edge, and is empty when there is none', async () => {
    const store = openStore(config);
    expect((await store.loadE2eMap()).flows.size).toBe(0);

    await fsp.mkdir(path.join(tmp, '.visual-diff'), { recursive: true });
    await fsp.writeFile(
      path.join(tmp, '.visual-diff', 'e2e-map.yaml'),
      'flows:\n  "a.spec.ts:1 \u203A x \u203A y": xy\n',
    );
    expect((await store.loadE2eMap()).flows.get('a.spec.ts \u203A x \u203A y')).toBe('xy');
  });
});
