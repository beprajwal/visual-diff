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
  readScenarioIndex,
  reapAbandonedRuns,
  resolvePair,
  runExists,
  updateRunMeta,
} from './run-store.js';
import type { RunMetaInput } from './run-store.js';
import { SCENARIO_NONE } from '../types.js';
import type { RunId } from '../types.js';

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

/*
 * Scenario as the third axis of run identity (mocking spec §6, D12). The run path never learns
 * about it: `runs/<flow>/<nnnn>/` is unchanged and run ids stay monotonic per flow, so `0007` names
 * one run of the flow whichever scenario it was captured against.
 */
describe('scenario in run identity', () => {
  async function seedScenario(scenario: string | undefined, flow = 'forecast'): Promise<RunId> {
    const run = await writeFixtureRun({
      root: tmp,
      flow,
      steps: [{ id: 'cart' }],
      ...(scenario === undefined ? {} : { meta: { scenario } }),
    });
    return run.runId;
  }

  it('records the scenario in meta.json, never in the run path', async () => {
    const runId = await seedScenario('empty-forecast');
    expect((await readRunMeta(tmp, 'forecast', runId)).scenario).toBe('empty-forecast');
    expect(paths.runDir(tmp, 'forecast', runId)).toBe(
      path.join(tmp, '.visual-diff', 'runs', 'forecast', runId),
    );
    expect(await listDirNames(paths.flowRunsDir(tmp, 'forecast'))).toEqual([runId]);
  });

  it('keeps run ids monotonic per flow across scenarios, so 0002 is never ambiguous', async () => {
    await seedScenario(undefined);
    await seedScenario('empty-forecast');
    await seedScenario('slow-forecast');
    await seedScenario('empty-forecast');

    expect(await listRunIds(tmp, 'forecast')).toEqual(['0000', '0001', '0002', '0003']);
    expect([...(await readScenarioIndex(tmp, 'forecast'))]).toEqual([
      ['0000', SCENARIO_NONE],
      ['0001', 'empty-forecast'],
      ['0002', 'slow-forecast'],
      ['0003', 'empty-forecast'],
    ]);
  });

  it('writes the reserved none for a run committed without one', async () => {
    const draft = await beginRun(tmp, 'checkout');
    await draft.writeFlowSnapshot('flow: checkout\nsteps: []\n');
    const { scenario: _omitted, ...withoutScenario } = makeRunMeta('checkout');
    // The cast is the point: `RunMetaInput` requires the field, and a caller written before it
    // existed did not supply it. The store fills it rather than writing a meta.json without it.
    const committed = await draft.commit(withoutScenario as RunMetaInput);

    expect(committed.meta.scenario).toBe(SCENARIO_NONE);
    const onDisk = JSON.parse(
      await fsp.readFile(paths.runMetaFile(tmp, 'checkout', committed.runId), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk.scenario).toBe('none');
  });

  it('reads a slice-1 meta.json — no scenario key at all — as none', async () => {
    const runId = await seedScenario(undefined, 'checkout');
    const file = paths.runMetaFile(tmp, 'checkout', runId);
    const stored = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    delete stored.scenario;
    await fsp.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);

    expect((await readRunMeta(tmp, 'checkout', runId)).scenario).toBe(SCENARIO_NONE);
    expect((await listRunSummaries(tmp, 'checkout'))[0]?.scenario).toBe(SCENARIO_NONE);
  });

  it('never lets a meta patch move a run to another scenario', async () => {
    const runId = await seedScenario('empty-forecast');
    const patched = await updateRunMeta(tmp, 'forecast', runId, {
      pinned: true,
      scenario: 'slow-forecast',
    });
    expect(patched.scenario).toBe('empty-forecast');
    expect(patched.pinned).toBe(true);
  });
});

describe('the timeline under scenarios', () => {
  beforeEach(async () => {
    // none, empty, empty, none — interleaved on purpose.
    for (const scenario of [undefined, 'empty-forecast', 'empty-forecast', undefined]) {
      await writeFixtureRun({
        root: tmp,
        flow: 'forecast',
        steps: [{ id: 'cart' }],
        ...(scenario === undefined ? {} : { meta: { scenario } }),
      });
    }
  });

  it('carries a scenario column', async () => {
    const rows = await listRunSummaries(tmp, 'forecast');
    expect(rows.map((row) => [row.runId, row.scenario])).toEqual([
      ['0000', SCENARIO_NONE],
      ['0001', 'empty-forecast'],
      ['0002', 'empty-forecast'],
      ['0003', SCENARIO_NONE],
    ]);
  });

  it('counts findings against the previous run of the same scenario, not the previous run', async () => {
    const asked: Array<[string, string]> = [];
    await listRunSummaries(tmp, 'forecast', async (base, head) => {
      asked.push([base, head]);
      return null;
    });
    // 0001 has no earlier empty-forecast run; 0003's predecessor is 0000, not 0002.
    expect(asked).toEqual([
      ['0001', '0002'],
      ['0000', '0003'],
    ]);
  });

  it('filters to one scenario without changing what the surviving rows say', async () => {
    const counted = async (base: string, head: string): Promise<number | null> =>
      base === '0001' && head === '0002' ? 4 : null;

    const all = await listRunSummaries(tmp, 'forecast', counted);
    const filtered = await listRunSummaries(tmp, 'forecast', counted, {
      scenario: 'empty-forecast',
    });

    expect(filtered.map((row) => row.runId)).toEqual(['0001', '0002']);
    expect(filtered[1]?.findingsCount).toBe(4);
    expect(filtered).toEqual(all.filter((row) => row.scenario === 'empty-forecast'));
  });

  it('filters the scenario-less runs under the name they record, "none"', async () => {
    const rows = await listRunSummaries(tmp, 'forecast', undefined, { scenario: 'none' });
    expect(rows.map((row) => row.runId)).toEqual(['0000', '0003']);
  });
});

describe('pair resolution across scenarios', () => {
  beforeEach(async () => {
    // 0000 none, 0001 empty, 0002 none, 0003 empty
    for (const scenario of [undefined, 'empty-forecast', undefined, 'empty-forecast']) {
      await writeFixtureRun({
        root: tmp,
        flow: 'forecast',
        steps: [{ id: 'cart' }],
        ...(scenario === undefined ? {} : { meta: { scenario } }),
      });
    }
  });

  it('defaults to the previous run of the head’s own scenario, skipping the ones between', async () => {
    expect(await resolvePair(tmp, 'forecast')).toEqual({
      flow: 'forecast',
      base: '0001',
      head: '0003',
    });
  });

  it('pairs scenario-less runs with each other, which is slice-1 behaviour unchanged', async () => {
    expect(await resolvePair(tmp, 'forecast', undefined, '0002')).toEqual({
      flow: 'forecast',
      base: '0000',
      head: '0002',
    });
  });

  it('restricts both ends to the named scenario', async () => {
    expect(await resolvePair(tmp, 'forecast', undefined, undefined, { scenario: 'empty-forecast' }))
      .toEqual({ flow: 'forecast', base: '0001', head: '0003' });
    expect(await resolvePair(tmp, 'forecast', undefined, undefined, { scenario: 'none' })).toEqual({
      flow: 'forecast',
      base: '0000',
      head: '0002',
    });
  });

  it('permits an explicitly named cross-scenario pair: it is labelled, not refused', async () => {
    expect(await resolvePair(tmp, 'forecast', '0002', '0003')).toEqual({
      flow: 'forecast',
      base: '0002',
      head: '0003',
    });
  });

  it('says which scenario a run really ran when it is excluded by --scenario', async () => {
    await expect(
      resolvePair(tmp, 'forecast', undefined, '0002', { scenario: 'empty-forecast' }),
    ).rejects.toMatchObject({
      code: 'scenario-mismatch',
      message: 'head run 0002 ran scenario "none", not "empty-forecast"',
      hint: 'Runs under "empty-forecast": 0001, 0003',
    });
  });

  it('names the scenario when a head has nothing before it to compare against', async () => {
    await expect(resolvePair(tmp, 'forecast', undefined, '0001')).rejects.toMatchObject({
      code: 'no-base',
      message: 'flow "forecast" has no run before 0001 under scenario "empty-forecast" to compare against',
      hint: 'Run it again to create a second point: vdiff run forecast --scenario empty-forecast',
    });
  });

  it('keeps the scenario out of the message when there was none — the slice-1 wording', async () => {
    await expect(resolvePair(tmp, 'forecast', undefined, '0000')).rejects.toMatchObject({
      code: 'no-base',
      message: 'flow "forecast" has no run before 0000 to compare against',
      hint: 'Run it again to create a second point: vdiff run forecast',
    });
  });

  it('reports a scenario that has never been captured, with the command that would capture it', async () => {
    await expect(
      resolvePair(tmp, 'forecast', undefined, undefined, { scenario: 'slow-forecast' }),
    ).rejects.toMatchObject({
      code: 'no-runs',
      message: 'flow "forecast" has no runs under scenario "slow-forecast" yet',
      hint: 'Capture one: vdiff run forecast --scenario slow-forecast',
    });
  });
});
