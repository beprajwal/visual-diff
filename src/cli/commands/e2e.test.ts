/**
 * `vdiff e2e` and `vdiff e2e list` against the in-memory ingestion edge (e2e spec §6, §8).
 *
 * The refusal *messages* are asserted verbatim, not merely the failure. Every one of them exists
 * because the alternative is a silent wrong answer — an ingestion of nothing that exits 0, several
 * unrelated tests merged into one flow, or a run with no screenshots sitting in a timeline pairing
 * with its neighbours — and a message that named the wrong thing would send the reader somewhere
 * useless. The exit codes are pinned for the same reason: exit 2 is "config or spec error", and a
 * batch that matched no archive is exactly that.
 */

import { describe, expect, it } from 'vitest';

import { EXIT } from '../../types.js';
import type { CommandContext } from '../command.js';
import { CliFailure } from '../error.js';
import {
  createTestE2e,
  createTestPorts,
  fakeArchivePlan,
  fakeIngestPlan,
  fakeIngestReport,
  fakeIngestedRun,
} from '../testing.js';
import { e2eIngest, e2eList } from './e2e.js';

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: '/project',
    ports: createTestPorts(),
    version: '0.1.0',
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
    ...overrides,
  };
}

/** A context whose ingestion edge is seeded, plus the recorder that saw every request. */
function withE2e(seed: Parameters<typeof createTestE2e>[0] = {}): {
  ctx: CommandContext;
  state: ReturnType<typeof createTestE2e>['state'];
} {
  const e2e = createTestE2e(seed);
  const ctx = context({
    ports: createTestPorts({
      planE2eIngest: e2e.planE2eIngest,
      ingestE2eTraces: e2e.ingestE2eTraces,
    }),
  });
  return { ctx, state: e2e.state };
}

const ingestInvocation = {
  kind: 'e2e-ingest' as const,
  from: 'trace' as const,
  pattern: 'test-results/**/trace.zip',
  json: false,
};

const listInvocation = { ...ingestInvocation, kind: 'e2e-list' as const };

async function failure(run: Promise<unknown>): Promise<CliFailure> {
  try {
    await run;
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(CliFailure);
    return thrown as CliFailure;
  }
  throw new Error('expected the command to fail');
}

describe('vdiff e2e list', () => {
  it('hands the pattern, the cwd and the format straight to the reader, unexpanded', async () => {
    const { ctx, state } = withE2e();
    await e2eList(ctx, { ...listInvocation, flow: 'weather' });

    expect(state.calls).toEqual([
      {
        call: 'plan',
        from: 'trace',
        pattern: 'test-results/**/trace.zip',
        cwd: '/project',
        flow: 'weather',
      },
    ]);
  });

  it('writes nothing: it never reaches the ingestion call at all (§6)', async () => {
    const { ctx, state } = withE2e();
    await e2eList(ctx, listInvocation);
    expect(state.calls.map((call) => call.call)).toEqual(['plan']);
  });

  it('returns the plan verbatim as its --json payload', async () => {
    const plan = fakeIngestPlan();
    const { ctx } = withE2e({ plan });
    const result = await e2eList(ctx, listInvocation);
    expect(result.data).toBe(plan);
  });

  it('says up front that this is a preview, then tabulates every archive', async () => {
    const { ctx } = withE2e({
      plan: fakeIngestPlan({
        archives: [
          fakeArchivePlan({ flow: 'weather', path: '/t/a.zip' }),
          fakeArchivePlan({ flow: 'search', path: '/t/b.zip', shots: 3 }),
        ],
      }),
    });
    const result = await e2eList(ctx, listInvocation);

    expect(result.human[0]).toBe(
      "2 trace archives matched 'test-results/**/trace.zip' — nothing written, this is a preview",
    );
    const text = result.human.join('\n');
    expect(text).toContain('FLOW');
    expect(text).toContain('weather');
    expect(text).toContain('search');
    expect(text).toContain('/t/a.zip');
    expect(text).toContain('v8');
  });

  it('shows an already-ingested archive as such, with the run it became', async () => {
    const { ctx } = withE2e({
      plan: fakeIngestPlan({
        archives: [fakeArchivePlan({ alreadyIngested: true, runId: '0004' })],
      }),
    });
    const text = (await e2eList(ctx, listInvocation)).human.join('\n');
    expect(text).toContain('ingested as 0004');
    expect(text).toContain(
      "1 of 1 already ingested — ingestion is keyed by the archive's content hash, so re-running" +
        ' writes nothing for them',
    );
  });

  it('shows a shot-less archive as "nothing to diff" rather than as a bare 0', async () => {
    // `list` is where a reader meets this before it becomes an error halfway through a batch, and
    // a bare `0` in a SHOTS column reads as an unremarkable number.
    const { ctx } = withE2e({ plan: fakeIngestPlan({ archives: [fakeArchivePlan({ shots: 0 })] }) });
    expect((await e2eList(ctx, listInvocation)).human.join('\n')).toContain('0 — nothing to diff');
  });

  it('surfaces per-archive notices, prefixed with the flow they belong to', async () => {
    const { ctx } = withE2e({
      plan: fakeIngestPlan({
        archives: [
          fakeArchivePlan({
            flow: 'search',
            notices: ['two steps titled "run the search"; ids disambiguated as -1 and -2'],
          }),
        ],
      }),
    });
    expect((await e2eList(ctx, listInvocation)).human).toContain(
      'search: two steps titled "run the search"; ids disambiguated as -1 and -2',
    );
  });

  it('warns about e2e-map.yaml entries no trace in the batch carries (§8)', async () => {
    const { ctx } = withE2e({
      plan: fakeIngestPlan({ unmatchedMapEntries: ['weather › shows the forecast'] }),
    });
    expect((await e2eList(ctx, listInvocation)).warnings).toEqual([
      'e2e-map.yaml pins a title no trace in this batch carries: weather › shows the forecast' +
        ' — the pinned step ids are not being applied',
    ]);
  });

  it('pluralises that warning rather than saying "1 titles"', async () => {
    const { ctx } = withE2e({
      plan: fakeIngestPlan({ unmatchedMapEntries: ['one', 'two'] }),
    });
    expect((await e2eList(ctx, listInvocation)).warnings?.[0]).toContain(
      'pins 2 titles no trace in this batch carries: one, two',
    );
  });

  it('refuses a pattern that matched nothing, rather than previewing an empty batch', async () => {
    const { ctx } = withE2e({ plan: fakeIngestPlan({ archives: [] }) });
    const error = await failure(e2eList(ctx, listInvocation));

    expect(error.code).toBe('e2e-no-archives');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.message).toBe("no trace archives matched 'test-results/**/trace.zip'");
    expect(error.hint).toBe(
      'quote the pattern so this tool expands it rather than the shell, and check the path' +
        " — `vdiff e2e list --from trace 'test-results/**/trace.zip'`",
    );
  });
});

describe('vdiff e2e --from trace', () => {
  it('plans before it ingests, so every refusal happens before a run directory exists', async () => {
    const { ctx, state } = withE2e();
    await e2eIngest(ctx, ingestInvocation);
    expect(state.calls.map((call) => call.call)).toEqual(['plan', 'ingest']);
  });

  it('counts what was written and what was already there', async () => {
    const { ctx } = withE2e({
      report: fakeIngestReport({
        runs: [
          fakeIngestedRun({ runId: '0001' }),
          fakeIngestedRun({ runId: '0002', reused: true, path: '/t/b.zip' }),
        ],
      }),
    });
    const result = await e2eIngest(ctx, ingestInvocation);

    expect(result.data.reused).toBe(1);
    expect(result.human[0]).toBe('ingested 2 trace archives: 1 new, 1 already present');
    const text = result.human.join('\n');
    expect(text).toContain('reused');
    expect(text).toContain('ingested');
  });

  it('points at the timeline the ingested runs landed on, which the default listing hides (D27)', async () => {
    const { ctx } = withE2e({
      report: fakeIngestReport({ runs: [fakeIngestedRun({ flow: 'weather' })] }),
    });
    expect((await e2eIngest(ctx, ingestInvocation)).human).toContain('`vdiff runs weather --e2e`');
  });

  it('names every flow when a batch spanned several', async () => {
    const { ctx } = withE2e({
      report: fakeIngestReport({
        runs: [
          fakeIngestedRun({ flow: 'weather' }),
          fakeIngestedRun({ flow: 'search', runId: '0002' }),
        ],
      }),
    });
    expect((await e2eIngest(ctx, ingestInvocation)).human).toContain(
      '`vdiff runs <flow> --e2e` — 2 flows: weather, search',
    );
  });

  it('refuses an archive with no screenshots, naming the option that was missing (§8)', async () => {
    const { ctx, state } = withE2e({
      plan: fakeIngestPlan({
        archives: [fakeArchivePlan({ path: '/t/quiet.zip', shots: 0 })],
      }),
    });
    const error = await failure(e2eIngest(ctx, ingestInvocation));

    expect(error.code).toBe('e2e-no-screenshots');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.message).toBe('/t/quiet.zip contains no screenshots, so there is nothing to diff');
    expect(error.hint).toBe(
      'Playwright records screenshots only when tracing is started with them:' +
        " `tracing.start({ screenshots: true, snapshots: true })`, or `use: { trace: 'on' }`" +
        ' under @playwright/test',
    );
    // Refused before anything was written: the ingestion call never happened.
    expect(state.calls.map((call) => call.call)).toEqual(['plan']);
  });

  it('counts the other shot-less archives rather than reporting them one run at a time', async () => {
    const { ctx } = withE2e({
      plan: fakeIngestPlan({
        archives: [
          fakeArchivePlan({ path: '/t/a.zip', shots: 0 }),
          fakeArchivePlan({ path: '/t/b.zip', shots: 0 }),
          fakeArchivePlan({ path: '/t/c.zip' }),
        ],
      }),
    });
    const error = await failure(e2eIngest(ctx, ingestInvocation));
    expect(error.message).toBe(
      '/t/a.zip contains no screenshots, so there is nothing to diff (and 1 more)',
    );
  });

  it('refuses --flow over a batch, which would merge unrelated tests into one timeline', async () => {
    const { ctx, state } = withE2e({
      plan: fakeIngestPlan({
        archives: [fakeArchivePlan({ path: '/t/a.zip' }), fakeArchivePlan({ path: '/t/b.zip' })],
      }),
    });
    const error = await failure(e2eIngest(ctx, { ...ingestInvocation, flow: 'weather' }));

    expect(error.code).toBe('e2e-flow-override-ambiguous');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.message).toBe(
      "--flow weather names one flow, but 'test-results/**/trace.zip' matched 2 trace archives",
    );
    expect(error.hint).toBe(
      'ingest them one at a time to rename each, or drop --flow and let each test title name its' +
        ' own flow',
    );
    expect(state.calls.map((call) => call.call)).toEqual(['plan']);
  });

  it('allows --flow over exactly one archive, which is what the flag is for', async () => {
    const { ctx, state } = withE2e();
    await e2eIngest(ctx, { ...ingestInvocation, flow: 'weather' });
    expect(state.calls.map((call) => call.call)).toEqual(['plan', 'ingest']);
    expect(state.calls[1]?.flow).toBe('weather');
  });

  it('refuses a pattern that matched nothing rather than reporting a successful ingestion of none', async () => {
    const { ctx } = withE2e({ plan: fakeIngestPlan({ archives: [] }) });
    const error = await failure(e2eIngest(ctx, ingestInvocation));
    expect(error.code).toBe('e2e-no-archives');
    expect(error.hint).toContain('`vdiff e2e --from trace');
  });

  it('carries the ingestion notices and the stale-map warning through to the caller', async () => {
    const { ctx } = withE2e({
      report: fakeIngestReport({
        runs: [
          fakeIngestedRun({
            flow: 'search',
            runId: '0003',
            notices: ['two steps titled "run the search"; ids disambiguated as -1 and -2'],
          }),
        ],
        unmatchedMapEntries: ['weather › shows the forecast'],
        warnings: ['trace v7 read through the apiName → title rename'],
      }),
    });
    const result = await e2eIngest(ctx, ingestInvocation);

    expect(result.human).toContain(
      'search 0003: two steps titled "run the search"; ids disambiguated as -1 and -2',
    );
    expect(result.warnings).toEqual([
      'trace v7 read through the apiName → title rename',
      'e2e-map.yaml pins a title no trace in this batch carries: weather › shows the forecast' +
        ' — the pinned step ids are not being applied',
    ]);
  });
});
