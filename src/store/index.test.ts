import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFixtureRun } from './fixtures.js';
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
});
