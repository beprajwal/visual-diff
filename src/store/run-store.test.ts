import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StoreError } from './errors.js';
import { makeRunMeta, writeFixtureRun } from './fixtures.js';
import { listDirNames } from './internal/fs.js';
import * as paths from './paths.js';
import {
  beginRun,
  latestRunId,
  listFlows,
  listRunIds,
  listRunSummaries,
  readRunMeta,
  reapAbandonedRuns,
  resolvePair,
  runExists,
  updateRunMeta,
} from './run-store.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-runs-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('atomic run writes', () => {
  it('keeps a partial run invisible until commit', async () => {
    const draft = await beginRun(tmp, 'checkout');
    await draft.writeFlowSnapshot('flow: checkout\nsteps:\n  - id: cart\n');
    await draft.writeStepConsole('cart', []);

    // The directory exists on disk but under a dotted temp name, so nothing lists it as a run.
    expect(path.basename(draft.dir).startsWith(paths.TEMP_PREFIX)).toBe(true);
    expect(await listRunIds(tmp, 'checkout')).toEqual([]);
    expect(await latestRunId(tmp, 'checkout')).toBeNull();

    const committed = await draft.commit(makeRunMeta('checkout'));

    expect(committed.runId).toBe('0000');
    expect(await listRunIds(tmp, 'checkout')).toEqual(['0000']);
    expect(await runExists(tmp, 'checkout', '0000')).toBe(true);
    // The temp directory is gone: the rename moved it, it was not copied.
    expect(await listDirNames(paths.flowRunsDir(tmp, 'checkout'))).toEqual(['0000']);
  });

  it('discards an abandoned draft without leaving a run behind', async () => {
    const draft = await beginRun(tmp, 'checkout');
    await draft.writeFlowSnapshot('flow: checkout\nsteps: []\n');
    await draft.discard();
    expect(await listRunIds(tmp, 'checkout')).toEqual([]);
    expect(await listDirNames(paths.flowRunsDir(tmp, 'checkout'))).toEqual([]);
    await draft.discard(); // idempotent
  });

  it('reaps temp directories left by a crashed run', async () => {
    const crashed = await beginRun(tmp, 'checkout');
    await crashed.writeFlowSnapshot('flow: checkout\nsteps: []\n');
    await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });

    const reaped = await reapAbandonedRuns(tmp, 'checkout');

    expect(reaped).toEqual([crashed.dir]);
    expect(await listDirNames(paths.flowRunsDir(tmp, 'checkout'))).toEqual(['0000']);
  });

  it('refuses to write through a committed draft', async () => {
    const draft = await beginRun(tmp, 'checkout');
    await draft.writeFlowSnapshot('flow: checkout\nsteps: []\n');
    await draft.commit(makeRunMeta('checkout'));
    await expect(draft.writeStepConsole('cart', [])).rejects.toThrow(StoreError);
    await expect(draft.commit(makeRunMeta('checkout'))).rejects.toThrow(/already committed/);
  });

  it('refuses to overwrite an existing run when an id is forced', async () => {
    await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    const draft = await beginRun(tmp, 'checkout');
    await draft.writeFlowSnapshot('flow: checkout\nsteps: []\n');
    await expect(draft.commit(makeRunMeta('checkout', { runId: '0000' }))).rejects.toThrow(
      /already exists/,
    );
  });
});

describe('run id allocation', () => {
  it('is monotonic per flow', async () => {
    for (let i = 0; i < 3; i += 1) {
      const run = await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
      expect(run.runId).toBe(String(i).padStart(4, '0'));
    }
    expect(await listRunIds(tmp, 'checkout')).toEqual(['0000', '0001', '0002']);
    expect(await latestRunId(tmp, 'checkout')).toBe('0002');
  });

  it('counts per flow, not globally', async () => {
    await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    const search = await writeFixtureRun({ root: tmp, flow: 'search', steps: [{ id: 'home' }] });
    expect(search.runId).toBe('0000');
    expect((await listFlows(tmp)).sort()).toEqual(['checkout', 'search']);
  });

  it('tolerates a gap in the middle without reusing a later id', async () => {
    for (let i = 0; i < 3; i += 1) {
      await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    }
    await fsp.rm(paths.runDir(tmp, 'checkout', '0001'), { recursive: true });
    const next = await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    expect(next.runId).toBe('0003');
    expect(await listRunIds(tmp, 'checkout')).toEqual(['0000', '0002', '0003']);
  });

  it('honours a forced id, for a backfill at a historical ref', async () => {
    const draft = await beginRun(tmp, 'checkout');
    await draft.writeFlowSnapshot('flow: checkout\nsteps: []\n');
    const run = await draft.commit(makeRunMeta('checkout', { runId: '0042' }));
    expect(run.runId).toBe('0042');
    expect((await readRunMeta(tmp, 'checkout', '0042')).runId).toBe('0042');
  });
});

describe('meta.json', () => {
  it('round-trips the documented shape', async () => {
    const run = await writeFixtureRun({
      root: tmp,
      flow: 'checkout',
      steps: [{ id: 'cart' }, { id: 'pay-form' }],
      viewports: ['1280x800', '390x844'],
      meta: {
        revision: { sha: '9f8e7d6', ref: 'feat/pay', dirty: true, dirtyHash: 'sha256:abc' },
        mode: 'attach',
        network: 'replay',
        harHits: 41,
        harMisses: 2,
        status: 'partial',
        failedSteps: ['pay-click'],
      },
    });

    const meta = await readRunMeta(tmp, 'checkout', run.runId);
    expect(meta.runId).toBe('0000');
    expect(meta.flow).toBe('checkout');
    expect(meta.revision).toEqual({
      sha: '9f8e7d6',
      ref: 'feat/pay',
      dirty: true,
      dirtyHash: 'sha256:abc',
    });
    expect(meta.mode).toBe('attach');
    expect(meta.network).toBe('replay');
    expect(meta.harHits).toBe(41);
    expect(meta.harMisses).toBe(2);
    expect(meta.viewports).toEqual(['1280x800', '390x844']);
    expect(meta.status).toBe('partial');
    expect(meta.failedSteps).toEqual(['pay-click']);
    expect(meta.env.deviceScaleFactor).toBe(2);
    expect(meta.pinned).toBe(false);
    expect(meta.pruned).toBe(false);
    expect(meta.unstable).toBe(false);
  });

  it('is written with sorted keys, so a fixture run diffs cleanly', async () => {
    const run = await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    const text = await fsp.readFile(paths.runMetaFile(tmp, 'checkout', run.runId), 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(text.endsWith('\n')).toBe(true);
  });

  it('patches only the fields the store owns after publication', async () => {
    const run = await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    const updated = await updateRunMeta(tmp, 'checkout', run.runId, { pinned: true });
    expect(updated.pinned).toBe(true);
    expect(updated.runId).toBe(run.runId);
    expect((await readRunMeta(tmp, 'checkout', run.runId)).pinned).toBe(true);
  });

  it('reports an unknown run rather than returning a stub', async () => {
    await expect(readRunMeta(tmp, 'checkout', '0009')).rejects.toThrow(/does not exist/);
  });
});

describe('the timeline', () => {
  it('is oldest-first and carries findings against the previous run', async () => {
    await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });

    const rows = await listRunSummaries(tmp, 'checkout', async (base, head) =>
      base === '0001' && head === '0002' ? 7 : null,
    );

    expect(rows.map((row) => row.runId)).toEqual(['0000', '0001', '0002']);
    // The oldest run has nothing before it to be compared against.
    expect(rows[0]?.findingsCount).toBeNull();
    expect(rows[1]?.findingsCount).toBeNull();
    expect(rows[2]?.findingsCount).toBe(7);
    expect(rows[0]?.revision.sha).toBe('9f8e7d6');
    expect(rows[0]?.pruned).toBe(false);
  });

  it('is empty for a flow with no runs', async () => {
    expect(await listRunSummaries(tmp, 'nothing')).toEqual([]);
  });
});

describe('pair resolution', () => {
  beforeEach(async () => {
    for (let i = 0; i < 4; i += 1) {
      await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    }
  });

  it('defaults to N-1 vs N', async () => {
    expect(await resolvePair(tmp, 'checkout')).toEqual({
      flow: 'checkout',
      base: '0002',
      head: '0003',
    });
  });

  it('defaults the base to the run before an explicit head', async () => {
    expect(await resolvePair(tmp, 'checkout', undefined, '0002')).toEqual({
      flow: 'checkout',
      base: '0001',
      head: '0002',
    });
  });

  it('accepts both ends explicitly, in loose form', async () => {
    expect(await resolvePair(tmp, 'checkout', '0', '3')).toEqual({
      flow: 'checkout',
      base: '0000',
      head: '0003',
    });
  });

  it('rejects an unknown run with the list of known ids', async () => {
    await expect(resolvePair(tmp, 'checkout', undefined, '0099')).rejects.toMatchObject({
      code: 'unknown-run',
      hint: expect.stringContaining('0003'),
    });
  });

  it('rejects a pair of one run', async () => {
    await expect(resolvePair(tmp, 'checkout', '0002', '0002')).rejects.toThrow(/needs two runs/);
    await expect(resolvePair(tmp, 'checkout', undefined, '0000')).rejects.toMatchObject({
      code: 'no-base',
    });
  });

  it('rejects a flow with no runs at all', async () => {
    await expect(resolvePair(tmp, 'search')).rejects.toMatchObject({ code: 'no-runs' });
  });
});
