import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeDiff } from './diff-store.js';
import { makeRunMeta, writeFixtureRun } from './fixtures.js';
import { listDirNames } from './internal/fs.js';
import * as paths from './paths.js';
import { PRESERVED_FILES, pinRun, pruneFlow, pruneRun, retentionCandidates } from './retention.js';
import { listRunIds, readRunMeta } from './run-store.js';
import type { DiffResult, RunId, RunMeta } from '../types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-retention-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function seed(count: number, flow = 'checkout'): Promise<RunId[]> {
  const ids: RunId[] = [];
  for (let i = 0; i < count; i += 1) {
    const run = await writeFixtureRun({
      root: tmp,
      flow,
      steps: [{ id: 'cart' }, { id: 'pay-form' }],
    });
    ids.push(run.runId);
  }
  return ids;
}

async function storeDiff(flow: string, base: RunId, head: RunId): Promise<void> {
  const meta = (runId: RunId): RunMeta => ({ ...makeRunMeta(flow), runId }) as RunMeta;
  const result: DiffResult = {
    engineVersion: '1',
    flow,
    pair: { base, head },
    computedAt: '2026-08-08T10:05:00.000Z',
    baseMeta: meta(base),
    headMeta: meta(head),
    flowDiff: [],
    steps: [],
    summary: {
      totalFindings: 0,
      bySeverity: { high: 0, med: 0, low: 0 },
      byKind: {
        content: 0,
        style: 0,
        layout: 0,
        structural: 0,
        a11y: 0,
        console: 0,
        network: 0,
      },
      stepsCompared: 0,
      stepsChanged: 0,
      stepsAdded: 0,
      stepsRemoved: 0,
      stepsSpecChanged: 0,
      stepsFailed: 0,
      stepsBlocked: 0,
      maxPixelChangedRatio: 0,
    },
    warnings: [],
  };
  await writeDiff(tmp, result);
}

describe('pruning', () => {
  it('deletes blobs but preserves meta.json and flow.snapshot.yaml forever', async () => {
    const [runId] = await seed(1);
    const dir = paths.runDir(tmp, 'checkout', runId as RunId);
    expect((await listDirNames(dir)).sort()).toEqual(
      ['flow.snapshot.yaml', 'meta.json', 'steps'].sort(),
    );

    const result = await pruneRun(tmp, 'checkout', runId as RunId);

    expect(result.pruned).toEqual([runId]);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect((await listDirNames(dir)).sort()).toEqual([...PRESERVED_FILES].sort());
    expect(await fsp.readFile(paths.runFlowSnapshotFile(tmp, 'checkout', runId as RunId), 'utf8'))
      .toContain('pay-form');
  });

  it('keeps the timeline entry and flags the run pruned, so it stays backfillable', async () => {
    const [runId] = await seed(1);
    await pruneRun(tmp, 'checkout', runId as RunId);
    expect(await listRunIds(tmp, 'checkout')).toEqual([runId]);
    const meta = await readRunMeta(tmp, 'checkout', runId as RunId);
    expect(meta.pruned).toBe(true);
    expect(meta.revision.sha).toBe('9f8e7d6');
  });

  it('is idempotent', async () => {
    const [runId] = await seed(1);
    await pruneRun(tmp, 'checkout', runId as RunId);
    const again = await pruneRun(tmp, 'checkout', runId as RunId);
    expect(again.pruned).toEqual([]);
    expect(again.skipped).toEqual([{ runId, reason: 'already-pruned' }]);
  });
});

describe('the retention policy', () => {
  it('keeps the newest keepRuns and prunes the rest', async () => {
    const ids = await seed(5);
    const result = await pruneFlow(tmp, 'checkout', { keepRuns: 2 });

    expect(result.pruned).toEqual(ids.slice(0, 3));
    for (const runId of ids.slice(0, 3)) {
      expect((await readRunMeta(tmp, 'checkout', runId)).pruned).toBe(true);
    }
    for (const runId of ids.slice(3)) {
      expect((await readRunMeta(tmp, 'checkout', runId)).pruned).toBe(false);
      expect(await listDirNames(paths.runDir(tmp, 'checkout', runId))).toContain('steps');
    }
  });

  it('does nothing while the flow is under the limit', async () => {
    await seed(3);
    const result = await pruneFlow(tmp, 'checkout', { keepRuns: 20 });
    expect(result).toEqual({ flow: 'checkout', pruned: [], skipped: [], freedBytes: 0 });
  });

  it('never prunes a pinned run', async () => {
    const ids = await seed(4);
    await pinRun(tmp, 'checkout', ids[0] as RunId);

    const result = await pruneFlow(tmp, 'checkout', { keepRuns: 1 });

    expect(result.skipped).toContainEqual({ runId: ids[0], reason: 'pinned' });
    expect(result.pruned).toEqual([ids[1], ids[2]]);
    expect(await listDirNames(paths.runDir(tmp, 'checkout', ids[0] as RunId))).toContain('steps');
  });

  it('never prunes a run referenced by a stored diff', async () => {
    const ids = await seed(4);
    await storeDiff('checkout', ids[0] as RunId, ids[1] as RunId);

    const result = await pruneFlow(tmp, 'checkout', { keepRuns: 1 });

    expect(result.skipped).toContainEqual({ runId: ids[0], reason: 'diff-referenced' });
    expect(result.skipped).toContainEqual({ runId: ids[1], reason: 'diff-referenced' });
    expect(result.pruned).toEqual([ids[2]]);
  });

  it('refuses an explicit prune of a pinned or diff-referenced run — never means never', async () => {
    const ids = await seed(2);
    await pinRun(tmp, 'checkout', ids[0] as RunId);
    await storeDiff('checkout', ids[0] as RunId, ids[1] as RunId);

    expect((await pruneRun(tmp, 'checkout', ids[0] as RunId)).skipped).toEqual([
      { runId: ids[0], reason: 'pinned' },
    ]);
    expect((await pruneRun(tmp, 'checkout', ids[1] as RunId)).skipped).toEqual([
      { runId: ids[1], reason: 'diff-referenced' },
    ]);
    expect(await listDirNames(paths.runDir(tmp, 'checkout', ids[1] as RunId))).toContain('steps');
  });

  it('unpins', async () => {
    const ids = await seed(2);
    await pinRun(tmp, 'checkout', ids[0] as RunId);
    expect((await pinRun(tmp, 'checkout', ids[0] as RunId, false)).pinned).toBe(false);
    const result = await pruneFlow(tmp, 'checkout', { keepRuns: 1 });
    expect(result.pruned).toEqual([ids[0]]);
  });

  it('rejects a nonsensical keepRuns', async () => {
    await expect(pruneFlow(tmp, 'checkout', { keepRuns: 0 })).rejects.toThrow(/keepRuns/);
  });

  it('reports an unknown run when pinning', async () => {
    await expect(pinRun(tmp, 'checkout', '0099')).rejects.toThrow(/does not exist/);
  });
});

/*
 * Retention is per `(flow, scenario)`, not per flow (mocking spec §6). The failure it prevents: a
 * scenario captured on every commit evicting the entire history of one captured once a month —
 * backwards, because the rarely-run scenario is the one whose history cannot be re-derived.
 */
describe('the retention policy under scenarios', () => {
  async function seedScenario(scenario: string, count: number, flow = 'forecast'): Promise<RunId[]> {
    const ids: RunId[] = [];
    for (let i = 0; i < count; i += 1) {
      const run = await writeFixtureRun({
        root: tmp,
        flow,
        steps: [{ id: 'cart' }],
        meta: { scenario },
      });
      ids.push(run.runId);
    }
    return ids;
  }

  it('keeps the newest keepRuns of every scenario, counted separately', async () => {
    const none = await seedScenario('none', 3);
    const empty = await seedScenario('empty-forecast', 3);

    const result = await pruneFlow(tmp, 'forecast', { keepRuns: 2 });

    expect(result.pruned).toEqual([none[0], empty[0]]);
    for (const runId of [none[1], none[2], empty[1], empty[2]] as RunId[]) {
      expect((await readRunMeta(tmp, 'forecast', runId)).pruned).toBe(false);
    }
  });

  it('does not let a busy scenario evict a quiet one’s only history', async () => {
    const quiet = await seedScenario('empty-forecast', 1);
    await seedScenario('none', 25);

    const result = await pruneFlow(tmp, 'forecast', { keepRuns: 20 });

    // Per-flow retention would have pruned the empty-forecast run: it is the oldest of the 26.
    expect(result.pruned).not.toContain(quiet[0]);
    expect((await readRunMeta(tmp, 'forecast', quiet[0] as RunId)).pruned).toBe(false);
    expect(result.pruned).toHaveLength(5);
  });

  it('lists candidates in run-id order, whatever scenario they belong to', async () => {
    await seedScenario('none', 2);
    await seedScenario('empty-forecast', 2);
    await seedScenario('none', 1);

    expect(await retentionCandidates(tmp, 'forecast', 1)).toEqual(['0000', '0001', '0002']);
  });

  it('still refuses to prune a pinned run of a scenario over its limit', async () => {
    const empty = await seedScenario('empty-forecast', 3);
    await pinRun(tmp, 'forecast', empty[0] as RunId);

    const result = await pruneFlow(tmp, 'forecast', { keepRuns: 1 });

    expect(result.skipped).toContainEqual({ runId: empty[0], reason: 'pinned' });
    expect(result.pruned).toEqual([empty[1]]);
  });

  it('reads a slice-1 run with no scenario key as part of the none group', async () => {
    const ids = await seedScenario('none', 2);
    const file = paths.runMetaFile(tmp, 'forecast', ids[0] as RunId);
    const stored = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    delete stored.scenario;
    await fsp.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);

    expect(await retentionCandidates(tmp, 'forecast', 1)).toEqual([ids[0]]);
  });
});
