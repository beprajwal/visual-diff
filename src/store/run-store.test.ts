import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StoreError } from './errors.js';
import { makeE2eRunMeta, makeRunMeta, writeFixtureRun } from './fixtures.js';
import { listDirNames } from './internal/fs.js';
import * as paths from './paths.js';
import {
  beginRun,
  findRunByTraceHash,
  latestRunId,
  listFlows,
  listRunIds,
  listRunSummaries,
  readE2eFlowIndex,
  readE2eIndex,
  readRunMeta,
  readScenarioIndex,
  readSourceIndex,
  readVariantIndex,
  reapAbandonedRuns,
  resolvePair,
  runExists,
  updateRunMeta,
} from './run-store.js';
import type { RunMetaInput } from './run-store.js';
import { keepRun } from './retention.js';
import {
  SOURCE_E2E,
  SOURCE_REPLAY,
  UNKNOWN_REVISION,
  isUnknownRevision,
} from './internal/e2e.js';
import type { E2eRunInfo } from './internal/e2e.js';
import { VARIANT_NONE, sameRevision } from './internal/variant.js';
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

/*
 * Variant as the fourth axis of run identity (variants spec §5, D24). Everything the scenario axis
 * established holds here — the run path never learns about it, ids stay monotonic — and one thing
 * does not: a variant run is kept *out* of the regression timeline until `--keep` promotes it.
 */
describe('variant in run identity', () => {
  async function seedVariant(
    variant: string | undefined,
    extra: Record<string, unknown> = {},
    flow = 'forecast',
  ): Promise<RunId> {
    const run = await writeFixtureRun({
      root: tmp,
      flow,
      steps: [{ id: 'cart' }],
      meta: { ...(variant === undefined ? {} : { variant }), ...extra },
    });
    return run.runId;
  }

  it('records the variant in meta.json, never in the run path', async () => {
    const runId = await seedVariant('denser-forecast');
    const meta = (await readRunMeta(tmp, 'forecast', runId)) as { variant?: string };
    expect(meta.variant).toBe('denser-forecast');
    expect(paths.runDir(tmp, 'forecast', runId)).toBe(
      path.join(tmp, '.visual-diff', 'runs', 'forecast', runId),
    );
    expect(await listDirNames(paths.flowRunsDir(tmp, 'forecast'))).toEqual([runId]);
  });

  it('keeps run ids monotonic per flow across variants, so 0002 is never ambiguous', async () => {
    await seedVariant(undefined);
    await seedVariant('denser-forecast');
    await seedVariant('wider-forecast');
    await seedVariant('denser-forecast');

    expect(await listRunIds(tmp, 'forecast')).toEqual(['0000', '0001', '0002', '0003']);
    expect([...(await readVariantIndex(tmp, 'forecast'))]).toEqual([
      ['0000', VARIANT_NONE],
      ['0001', 'denser-forecast'],
      ['0002', 'wider-forecast'],
      ['0003', 'denser-forecast'],
    ]);
  });

  it('writes the reserved none for a run committed without one', async () => {
    const draft = await beginRun(tmp, 'checkout');
    await draft.writeFlowSnapshot('flow: checkout\nsteps: []\n');
    const { variant: _omitted, ...withoutVariant } = makeRunMeta('checkout');
    const committed = await draft.commit(withoutVariant as RunMetaInput);

    expect((committed.meta as { variant?: string }).variant).toBe(VARIANT_NONE);
    const onDisk = JSON.parse(
      await fsp.readFile(paths.runMetaFile(tmp, 'checkout', committed.runId), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk.variant).toBe('none');
    // No promotion flag on an unvaried run: it is already permanent, so the field could never be
    // anything but false and would be noise in every meta.json the tool writes.
    expect('kept' in onDisk).toBe(false);
  });

  it('writes the promotion flag on a variant run, so its bucket is legible on disk', async () => {
    const runId = await seedVariant('denser-forecast');
    const onDisk = JSON.parse(
      await fsp.readFile(paths.runMetaFile(tmp, 'forecast', runId), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk.variant).toBe('denser-forecast');
    expect(onDisk.kept).toBe(false);
  });

  it('reads a meta.json written before variants existed as none', async () => {
    const runId = await seedVariant(undefined, {}, 'checkout');
    const file = paths.runMetaFile(tmp, 'checkout', runId);
    const stored = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    delete stored.variant;
    await fsp.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);

    expect(((await readRunMeta(tmp, 'checkout', runId)) as { variant?: string }).variant).toBe(
      VARIANT_NONE,
    );
    expect((await listRunSummaries(tmp, 'checkout'))[0]?.variant).toBe(VARIANT_NONE);
  });

  it('never lets a meta patch move a run to another variant', async () => {
    const runId = await seedVariant('denser-forecast');
    const patched = (await updateRunMeta(tmp, 'forecast', runId, {
      pinned: true,
      variant: 'wider-forecast',
    })) as { variant?: string; pinned: boolean };
    expect(patched.variant).toBe('denser-forecast');
    expect(patched.pinned).toBe(true);
  });
});

describe('the timeline under variants', () => {
  beforeEach(async () => {
    // 0000 unvaried, 0001 denser, 0002 unvaried, 0003 denser (promoted), 0004 wider
    for (const variant of [undefined, 'denser-forecast', undefined, 'denser-forecast', 'wider-forecast']) {
      await writeFixtureRun({
        root: tmp,
        flow: 'forecast',
        steps: [{ id: 'cart' }],
        meta: variant === undefined ? {} : { variant },
      });
    }
    await keepRun(tmp, 'forecast', '0003');
  });

  it('excludes ephemeral variant runs by default — D24’s regression timeline', async () => {
    const rows = await listRunSummaries(tmp, 'forecast');
    expect(rows.map((row) => row.runId)).toEqual(['0000', '0002', '0003']);
  });

  it('keeps a promoted run in that timeline, which is the whole of what --keep does', async () => {
    const rows = await listRunSummaries(tmp, 'forecast');
    const promoted = rows.find((row) => row.runId === '0003');
    expect(promoted?.variant).toBe('denser-forecast');
    expect(promoted?.kept).toBe(true);
  });

  it('lists the variant runs under --variants, promoted or not', async () => {
    const rows = await listRunSummaries(tmp, 'forecast', undefined, { variants: 'only' });
    expect(rows.map((row) => [row.runId, row.variant])).toEqual([
      ['0001', 'denser-forecast'],
      ['0003', 'denser-forecast'],
      ['0004', 'wider-forecast'],
    ]);
  });

  it('shows everything under include, which is the only way to see both at once', async () => {
    const rows = await listRunSummaries(tmp, 'forecast', undefined, { variants: 'include' });
    expect(rows.map((row) => row.runId)).toEqual(['0000', '0001', '0002', '0003', '0004']);
  });

  it('narrows to one variant by name, whatever the filter would have said', async () => {
    const rows = await listRunSummaries(tmp, 'forecast', undefined, { variant: 'denser-forecast' });
    expect(rows.map((row) => row.runId)).toEqual(['0001', '0003']);
  });

  it('filters the unvaried runs under the name they record, "none"', async () => {
    const rows = await listRunSummaries(tmp, 'forecast', undefined, { variant: 'none' });
    expect(rows.map((row) => row.runId)).toEqual(['0000', '0002']);
  });

  it('counts findings against the previous run of the same identity, both axes', async () => {
    const asked: Array<[string, string]> = [];
    await listRunSummaries(
      tmp,
      'forecast',
      async (base, head) => {
        asked.push([base, head]);
        return null;
      },
      { variants: 'include' },
    );
    // 0002 follows 0000 (unvaried); 0003 follows 0001 (same variant), not 0002.
    expect(asked).toEqual([
      ['0000', '0002'],
      ['0001', '0003'],
    ]);
  });

  it('does not change what a surviving row says when the filter changes', async () => {
    const counted = async (base: string, head: string): Promise<number | null> =>
      base === '0001' && head === '0003' ? 7 : null;
    const all = await listRunSummaries(tmp, 'forecast', counted, { variants: 'include' });
    const only = await listRunSummaries(tmp, 'forecast', counted, { variants: 'only' });
    expect(only).toEqual(all.filter((row) => row.variant !== VARIANT_NONE));
    expect(only.find((row) => row.runId === '0003')?.findingsCount).toBe(7);
  });
});

/*
 * The pairing D24 changes on purpose.
 *
 * For a scenario the question is regression: same scenario, two revisions. For a variant it is the
 * proposal — same revision, variant versus none — so applying the scenario rule unchanged would
 * hunt for an earlier run of the same variant and, failing that, refuse. That is the one comparison
 * the user is actually asking for, and refusing it would make the feature unusable by default.
 */
describe('pair resolution across variants', () => {
  const AT = (sha: string) => ({ revision: { sha, ref: 'main', dirty: false } });

  async function seed(meta: Record<string, unknown>): Promise<RunId> {
    const run = await writeFixtureRun({
      root: tmp,
      flow: 'forecast',
      steps: [{ id: 'cart' }],
      meta,
    });
    return run.runId;
  }

  it('pairs a variant run against the unvaried run at its own revision', async () => {
    await seed({ ...AT('rev-1') });                                  // 0000
    await seed({ ...AT('rev-2') });                                  // 0001 the baseline
    await seed({ ...AT('rev-2'), variant: 'denser-forecast' });      // 0002 the proposal

    expect(await resolvePair(tmp, 'forecast', undefined, '0002')).toEqual({
      flow: 'forecast',
      base: '0001',
      head: '0002',
    });
  });

  it('takes the nearest baseline, even when it was captured after the proposal', async () => {
    await seed({ ...AT('rev-1') });                                  // 0000 same revision, far away
    await seed({ ...AT('rev-1'), variant: 'denser-forecast' });      // 0001 proposal
    await seed({ ...AT('rev-1'), variant: 'wider-forecast' });       // 0002 another proposal
    await seed({ ...AT('rev-1') });                                  // 0003 baseline, captured last

    expect(await resolvePair(tmp, 'forecast', undefined, '0002')).toEqual({
      flow: 'forecast',
      base: '0003',
      head: '0002',
    });
  });

  it('never reaches across revisions for a baseline, which would blame the code on the variant', async () => {
    await seed({ ...AT('rev-1') });                                  // 0000 unvaried, wrong revision
    await seed({ ...AT('rev-2'), variant: 'denser-forecast' });      // 0001

    await expect(resolvePair(tmp, 'forecast', undefined, '0001')).rejects.toMatchObject({
      code: 'no-baseline',
      message:
        'flow "forecast" has no unvaried run at revision rev-2 to compare variant "denser-forecast" run 0001 against',
      hint: 'Capture the unmodified page at that revision: vdiff run forecast',
    });
  });

  it('will not take a baseline from a different dirty tree at the same sha', async () => {
    await seed({ revision: { sha: 'rev-1', ref: 'main', dirty: true, dirtyHash: 'sha256:a' } });
    await seed({
      revision: { sha: 'rev-1', ref: 'main', dirty: true, dirtyHash: 'sha256:b' },
      variant: 'denser-forecast',
    });

    await expect(resolvePair(tmp, 'forecast', undefined, '0001')).rejects.toMatchObject({
      code: 'no-baseline',
      message:
        'flow "forecast" has no unvaried run at revision rev-1 (dirty) to compare variant "denser-forecast" run 0001 against',
    });
  });

  it('requires the baseline to share the head’s scenario as well as its revision', async () => {
    await seed({ ...AT('rev-1') });                                                          // 0000
    await seed({ ...AT('rev-1'), scenario: 'empty-forecast', variant: 'denser-forecast' });  // 0001

    await expect(resolvePair(tmp, 'forecast', undefined, '0001')).rejects.toMatchObject({
      code: 'no-baseline',
      message:
        'flow "forecast" has no unvaried run at revision rev-1 under scenario "empty-forecast" ' +
        'to compare variant "denser-forecast" run 0001 against',
      hint: 'Capture the unmodified page at that revision: vdiff run forecast --scenario empty-forecast',
    });
  });

  it('does not let an ephemeral variant run become the default head', async () => {
    await seed({ ...AT('rev-1') });                                  // 0000
    await seed({ ...AT('rev-1') });                                  // 0001
    await seed({ ...AT('rev-1'), variant: 'denser-forecast' });      // 0002

    // `vdiff diff <flow>` keeps meaning what it meant before variants existed.
    expect(await resolvePair(tmp, 'forecast')).toEqual({
      flow: 'forecast',
      base: '0000',
      head: '0001',
    });
  });

  it('selects the head from one variant under --variant and pairs it with the baseline', async () => {
    await seed({ ...AT('rev-1') });                                  // 0000 baseline
    await seed({ ...AT('rev-1'), variant: 'denser-forecast' });      // 0001
    await seed({ ...AT('rev-1'), variant: 'wider-forecast' });       // 0002
    await seed({ ...AT('rev-1'), variant: 'denser-forecast' });      // 0003 newest denser

    expect(await resolvePair(tmp, 'forecast', undefined, undefined, {
      variant: 'denser-forecast',
    })).toEqual({ flow: 'forecast', base: '0000', head: '0003' });
  });

  it('says which variant a head really ran when --variant excludes it', async () => {
    await seed({ ...AT('rev-1') });                                  // 0000
    await seed({ ...AT('rev-1'), variant: 'denser-forecast' });      // 0001
    await seed({ ...AT('rev-1'), variant: 'wider-forecast' });       // 0002

    await expect(
      resolvePair(tmp, 'forecast', undefined, '0002', { variant: 'denser-forecast' }),
    ).rejects.toMatchObject({
      code: 'variant-mismatch',
      message: 'head run 0002 ran variant "wider-forecast", not "denser-forecast"',
      hint: 'Runs under "denser-forecast": 0001',
    });
  });

  it('does not variant-check an explicitly named base — crossing the axis is the point', async () => {
    await seed({ ...AT('rev-1') });                                  // 0000
    await seed({ ...AT('rev-1'), variant: 'denser-forecast' });      // 0001

    expect(
      await resolvePair(tmp, 'forecast', '0000', '0001', { variant: 'denser-forecast' }),
    ).toEqual({ flow: 'forecast', base: '0000', head: '0001' });
  });

  it('reports a variant that has never been captured, with the command that would capture it', async () => {
    await seed({ ...AT('rev-1') });

    await expect(
      resolvePair(tmp, 'forecast', undefined, undefined, { variant: 'denser-forecast' }),
    ).rejects.toMatchObject({
      code: 'no-runs',
      message: 'flow "forecast" has no runs under variant "denser-forecast" yet',
      hint: 'Capture one: vdiff run forecast --variant denser-forecast',
    });
  });

  it('names both axes in that hint when a scenario is in force too', async () => {
    await seed({ ...AT('rev-1'), scenario: 'empty-forecast' });

    await expect(
      resolvePair(tmp, 'forecast', undefined, undefined, {
        scenario: 'empty-forecast',
        variant: 'denser-forecast',
      }),
    ).rejects.toMatchObject({
      code: 'no-runs',
      hint: 'Capture one: vdiff run forecast --scenario empty-forecast --variant denser-forecast',
    });
  });

  it('explains a flow that has nothing but proposals rather than reporting no runs at all', async () => {
    await seed({ ...AT('rev-1'), variant: 'denser-forecast' });

    await expect(resolvePair(tmp, 'forecast')).rejects.toMatchObject({
      code: 'no-runs',
      message:
        'flow "forecast" has only ephemeral variant runs, none of which is in the regression timeline',
      hint: 'List them: vdiff runs forecast --variants',
    });
  });

  it('still resolves a fully named pair in a flow that has nothing but proposals', async () => {
    await seed({ ...AT('rev-1'), variant: 'denser-forecast' });      // 0000
    await seed({ ...AT('rev-1'), variant: 'wider-forecast' });       // 0001

    // The default head has nothing to pick from, but the user picked both ends themselves.
    expect(await resolvePair(tmp, 'forecast', '0000', '0001')).toEqual({
      flow: 'forecast',
      base: '0000',
      head: '0001',
    });
  });

  it('leaves unvaried pairing exactly as it was, promoted runs included', async () => {
    await seed({ ...AT('rev-1') });                                  // 0000
    await seed({ ...AT('rev-1'), variant: 'denser-forecast' });      // 0001
    await seed({ ...AT('rev-2') });                                  // 0002
    await keepRun(tmp, 'forecast', '0001');

    // 0001 is in the timeline now, but it is not the head's identity, so it is not the base.
    expect(await resolvePair(tmp, 'forecast')).toEqual({
      flow: 'forecast',
      base: '0000',
      head: '0002',
    });
  });

  it('pairs a promoted variant across revisions when both ends are named', async () => {
    await seed({ ...AT('rev-1'), variant: 'denser-forecast', kept: true });   // 0000
    await seed({ ...AT('rev-2'), variant: 'denser-forecast', kept: true });   // 0001

    expect(await resolvePair(tmp, 'forecast', '0000', '0001')).toEqual({
      flow: 'forecast',
      base: '0000',
      head: '0001',
    });
  });
});

/* ------------------------------------------------------------------ e2e (spec §7, D27) */

describe('source in run identity', () => {
  async function seedE2e(
    e2e: Partial<E2eRunInfo> = {},
    extra: Record<string, unknown> = {},
    flow = 'forecast',
  ): Promise<RunId> {
    const run = await writeFixtureRun({
      root: tmp,
      flow,
      steps: [{ id: 'cart' }],
      meta: makeE2eRunMeta(flow, e2e, extra),
    });
    return run.runId;
  }

  it('records the source in meta.json, never in the run path', async () => {
    const runId = await seedE2e();
    const meta = (await readRunMeta(tmp, 'forecast', runId)) as { source?: string };
    expect(meta.source).toBe(SOURCE_E2E);
    expect(paths.runDir(tmp, 'forecast', runId)).toBe(
      path.join(tmp, '.visual-diff', 'runs', 'forecast', runId),
    );
    expect(await listDirNames(paths.flowRunsDir(tmp, 'forecast'))).toEqual([runId]);
  });

  it('keeps run ids monotonic per flow across sources, so 0002 is never ambiguous', async () => {
    await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] }); // 0000 replay
    await seedE2e({ traceHash: 'sha256:a' });                                        // 0001 e2e
    await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] }); // 0002 replay
    await seedE2e({ traceHash: 'sha256:b' });                                        // 0003 e2e

    expect(await listRunIds(tmp, 'forecast')).toEqual(['0000', '0001', '0002', '0003']);
    expect([...(await readSourceIndex(tmp, 'forecast'))]).toEqual([
      ['0000', SOURCE_REPLAY],
      ['0001', SOURCE_E2E],
      ['0002', SOURCE_REPLAY],
      ['0003', SOURCE_E2E],
    ]);
  });

  it('writes replay explicitly for a run committed without a source', async () => {
    const draft = await beginRun(tmp, 'checkout');
    await draft.writeFlowSnapshot('flow: checkout\nsteps: []\n');
    const { source: _omitted, ...withoutSource } = makeRunMeta('checkout');
    const committed = await draft.commit(withoutSource as RunMetaInput);

    expect((committed.meta as { source?: string }).source).toBe(SOURCE_REPLAY);
    const onDisk = JSON.parse(
      await fsp.readFile(paths.runMetaFile(tmp, 'checkout', committed.runId), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk.source).toBe('replay');
    // No e2e block on a replay run: a field that can never be populated is noise in every
    // meta.json the tool writes.
    expect('e2e' in onDisk).toBe(false);
  });

  it('records the trace hash, the test title and the suite metadata a trace really provides', async () => {
    const runId = await seedE2e({
      traceHash: 'sha256:archive',
      testTitle: 'checkout.spec.ts:12 › checkout › shows the cart',
      titleKey: 'checkout.spec.ts › checkout › shows the cart',
      // Browser, channel, playwright version and platform come from `context-options`; project and
      // retry are recorded only when the caller parsed them out of the output directory name,
      // because no trace archive carries them.
      suite: {
        browser: 'chromium',
        playwrightVersion: '1.62.1',
        platform: 'darwin',
        traceVersion: 8,
        project: 'chromium-desktop',
        retry: 2,
      },
    });
    const onDisk = JSON.parse(
      await fsp.readFile(paths.runMetaFile(tmp, 'forecast', runId), 'utf8'),
    ) as { source: string; e2e: Record<string, unknown> };
    expect(onDisk.source).toBe('e2e');
    expect(onDisk.e2e.traceHash).toBe('sha256:archive');
    expect(onDisk.e2e.testTitle).toBe('checkout.spec.ts:12 › checkout › shows the cart');
    expect(onDisk.e2e.titleKey).toBe('checkout.spec.ts › checkout › shows the cart');
    expect(onDisk.e2e.suite).toEqual({
      browser: 'chromium',
      playwrightVersion: '1.62.1',
      platform: 'darwin',
      traceVersion: 8,
      project: 'chromium-desktop',
      retry: 2,
    });
  });

  it('records revision unknown rather than the revision that happens to be checked out', async () => {
    const runId = await seedE2e();
    const meta = await readRunMeta(tmp, 'forecast', runId);
    expect(meta.revision).toEqual(UNKNOWN_REVISION);
    expect(isUnknownRevision(meta.revision)).toBe(true);
    // And two ingested runs are never "the same revision" merely because both are unknown.
    const other = await seedE2e({ traceHash: 'sha256:other' });
    const otherMeta = await readRunMeta(tmp, 'forecast', other);
    expect(sameRevision(meta.revision, otherMeta.revision)).toBe(false);
  });

  it('refuses to commit an e2e run with no trace hash, which is the idempotency key', async () => {
    const draft = await beginRun(tmp, 'forecast');
    await draft.writeFlowSnapshot('flow: forecast\nsteps: []\n');
    await expect(
      draft.commit(
        makeRunMeta('forecast', {
          source: SOURCE_E2E,
          e2e: { traceHash: '', testTitle: 't', titleKey: 't' },
        }),
      ),
    ).rejects.toThrow(
      'e2e run of flow "forecast" records no traceHash; without it the same archive ingests twice',
    );
    // Nothing was published: the refusal happens before the rename.
    expect(await listRunIds(tmp, 'forecast')).toEqual([]);
  });

  it('refuses to commit an e2e run carrying a variant, which would put it in the wrong bucket', async () => {
    const draft = await beginRun(tmp, 'forecast');
    await draft.writeFlowSnapshot('flow: forecast\nsteps: []\n');
    await expect(
      draft.commit(makeE2eRunMeta('forecast', {}, { variant: 'denser-forecast' })),
    ).rejects.toThrow(
      'e2e run of flow "forecast" was given variant "denser-forecast"; ' +
        'variants operate during capture, and an e2e trace was captured elsewhere',
    );
    expect(await listRunIds(tmp, 'forecast')).toEqual([]);
  });

  it('reads a meta.json written before e2e mode existed as a replay', async () => {
    const run = await writeFixtureRun({ root: tmp, flow: 'checkout', steps: [{ id: 'cart' }] });
    const file = paths.runMetaFile(tmp, 'checkout', run.runId);
    const stored = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    delete stored.source;
    await fsp.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);

    expect(((await readRunMeta(tmp, 'checkout', run.runId)) as { source?: string }).source).toBe(
      SOURCE_REPLAY,
    );
    expect((await listRunSummaries(tmp, 'checkout'))[0]?.source).toBe(SOURCE_REPLAY);
  });

  it('never lets a meta patch move a run to another source', async () => {
    const runId = await seedE2e();
    const patched = (await updateRunMeta(tmp, 'forecast', runId, {
      pinned: true,
      source: SOURCE_REPLAY,
    })) as { source?: string; pinned: boolean };
    expect(patched.source).toBe(SOURCE_E2E);
    expect(patched.pinned).toBe(true);
  });

  it('finds the run an archive was already ingested as — §6 idempotency', async () => {
    const first = await seedE2e({ traceHash: 'sha256:archive-1' });
    await seedE2e({ traceHash: 'sha256:archive-2' });

    expect(await findRunByTraceHash(tmp, 'forecast', 'sha256:archive-1')).toBe(first);
    expect(await findRunByTraceHash(tmp, 'forecast', 'sha256:missing')).toBeNull();
  });

  it('does not confuse a replay run with an ingested one when looking a hash up', async () => {
    await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] });
    expect(await findRunByTraceHash(tmp, 'forecast', 'sha256:anything')).toBeNull();
  });

  it('indexes the e2e block of ingested runs only', async () => {
    await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] }); // 0000
    const ingested = await seedE2e({ traceHash: 'sha256:x' });                       // 0001

    const index = await readE2eIndex(tmp, 'forecast');
    expect([...index.keys()]).toEqual([ingested]);
    expect(index.get(ingested)?.traceHash).toBe('sha256:x');
  });

  it('maps a title to the flow it already lives in, so a name is never reassigned', async () => {
    await seedE2e({ traceHash: 'sha256:a', titleKey: 'a.spec.ts › x › y' }, {}, 'x-y');
    await seedE2e({ traceHash: 'sha256:b', titleKey: 'b.spec.ts › x › y' }, {}, 'x-y-other');

    expect([...(await readE2eFlowIndex(tmp))]).toEqual([
      ['a.spec.ts › x › y', 'x-y'],
      ['b.spec.ts › x › y', 'x-y-other'],
    ]);
  });
});

describe('the timeline under e2e', () => {
  beforeEach(async () => {
    // 0000 replay, 0001 e2e, 0002 replay, 0003 e2e
    await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] });
    await writeFixtureRun({
      root: tmp,
      flow: 'forecast',
      steps: [{ id: 'cart' }],
      meta: makeE2eRunMeta('forecast', { traceHash: 'sha256:1' }),
    });
    await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] });
    await writeFixtureRun({
      root: tmp,
      flow: 'forecast',
      steps: [{ id: 'cart' }],
      meta: makeE2eRunMeta('forecast', { traceHash: 'sha256:2' }),
    });
  });

  it('excludes ingested runs by default — D27’s separate timeline', async () => {
    const rows = await listRunSummaries(tmp, 'forecast');
    expect(rows.map((row) => row.runId)).toEqual(['0000', '0002']);
    expect(rows.every((row) => row.source === SOURCE_REPLAY)).toBe(true);
  });

  it('shows only ingested runs for --e2e', async () => {
    const rows = await listRunSummaries(tmp, 'forecast', undefined, { e2e: 'only' });
    expect(rows.map((row) => row.runId)).toEqual(['0001', '0003']);
    expect(rows.every((row) => row.source === SOURCE_E2E)).toBe(true);
  });

  it('shows both when asked, with the source on every row', async () => {
    const rows = await listRunSummaries(tmp, 'forecast', undefined, { e2e: 'include' });
    expect(rows.map((row) => [row.runId, row.source])).toEqual([
      ['0000', SOURCE_REPLAY],
      ['0001', SOURCE_E2E],
      ['0002', SOURCE_REPLAY],
      ['0003', SOURCE_E2E],
    ]);
  });

  it('counts findings against the previous run of the same source, never across the two', async () => {
    const asked: Array<[RunId, RunId]> = [];
    await listRunSummaries(
      tmp,
      'forecast',
      async (base, head) => {
        asked.push([base, head]);
        return 0;
      },
      { e2e: 'include' },
    );
    // 0002 against 0000 (both replay) and 0003 against 0001 (both e2e); never 0001 against 0000.
    expect(asked).toEqual([
      ['0000', '0002'],
      ['0001', '0003'],
    ]);
  });
});

describe('pair resolution across sources', () => {
  async function seedReplay(): Promise<RunId> {
    const run = await writeFixtureRun({ root: tmp, flow: 'forecast', steps: [{ id: 'cart' }] });
    return run.runId;
  }

  async function seedIngest(traceHash: string): Promise<RunId> {
    const run = await writeFixtureRun({
      root: tmp,
      flow: 'forecast',
      steps: [{ id: 'cart' }],
      meta: makeE2eRunMeta('forecast', { traceHash }),
    });
    return run.runId;
  }

  it('keeps the default pair on the replay timeline, ignoring ingested runs entirely', async () => {
    await seedReplay();               // 0000
    await seedReplay();               // 0001
    await seedIngest('sha256:1');     // 0002

    expect(await resolvePair(tmp, 'forecast')).toEqual({
      flow: 'forecast',
      base: '0000',
      head: '0001',
    });
  });

  it('pairs e2e with e2e when the e2e timeline is asked for', async () => {
    await seedReplay();               // 0000
    await seedIngest('sha256:1');     // 0001
    await seedReplay();               // 0002
    await seedIngest('sha256:2');     // 0003

    expect(await resolvePair(tmp, 'forecast', undefined, undefined, { source: 'e2e' })).toEqual({
      flow: 'forecast',
      base: '0001',
      head: '0003',
    });
  });

  it('refuses to switch timelines silently when a flow holds nothing but ingested runs', async () => {
    await seedIngest('sha256:1');
    await seedIngest('sha256:2');

    await expect(resolvePair(tmp, 'forecast')).rejects.toMatchObject({
      code: 'no-runs',
      message: 'flow "forecast" has no replay runs yet; every run it has is e2e',
      hint: 'These runs were ingested; ask for that timeline: vdiff diff forecast --e2e',
    });
  });

  it('says how to ingest one when the e2e timeline is asked for and is empty', async () => {
    await seedReplay();

    await expect(
      resolvePair(tmp, 'forecast', undefined, undefined, { source: 'e2e' }),
    ).rejects.toMatchObject({
      code: 'no-runs',
      message: 'flow "forecast" has no e2e runs yet; every run it has is replay',
      hint: 'Ingest one: vdiff e2e --from trace <path>',
    });
  });

  it('refuses a named run from the other timeline when a timeline was asked for by name', async () => {
    const replay = await seedReplay();   // 0000
    await seedIngest('sha256:1');        // 0001

    await expect(
      resolvePair(tmp, 'forecast', undefined, replay, { source: 'e2e' }),
    ).rejects.toMatchObject({
      code: 'source-mismatch',
      message: 'head run 0000 came from replay, not e2e',
      hint: 'e2e runs: 0001',
    });
  });

  it('permits a cross-source pair when the user names both ends — it is a real question', async () => {
    const replay = await seedReplay();          // 0000
    const ingested = await seedIngest('sha256:1'); // 0001

    // Flagged at high severity by the diff engine (D27), not refused here.
    expect(await resolvePair(tmp, 'forecast', replay, ingested)).toEqual({
      flow: 'forecast',
      base: '0000',
      head: '0001',
    });
  });

  it('keeps a named e2e head paired with an e2e base, not with the replay run before it', async () => {
    await seedReplay();                            // 0000
    await seedIngest('sha256:1');                  // 0001
    await seedReplay();                            // 0002
    const head = await seedIngest('sha256:2');     // 0003

    // No --e2e: the head is named explicitly, and its base must follow it onto its own timeline.
    expect(await resolvePair(tmp, 'forecast', undefined, head)).toEqual({
      flow: 'forecast',
      base: '0001',
      head,
    });
  });

  it('names the timeline when an ingested head has nothing before it', async () => {
    await seedReplay();                            // 0000
    const head = await seedIngest('sha256:1');     // 0001

    await expect(resolvePair(tmp, 'forecast', undefined, head)).rejects.toMatchObject({
      code: 'no-base',
      message:
        'flow "forecast" has no run ingested from a trace before 0001 to compare against',
    });
  });
});
