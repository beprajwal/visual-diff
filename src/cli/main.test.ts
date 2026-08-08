/**
 * The `--json` envelope is the agent-facing API across four harnesses (spec §11.6), so these are
 * whole-object assertions rather than spot checks: any change to a shape has to show up here.
 * They also pin the exit-code contract, including the deliberate one — `diff` exits 0 with
 * findings present.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EXIT,
  type CliEnvelope,
  type DiffResult,
  type Finding,
  type StepDiff,
  type ViewportDiff,
} from '../types.js';
import { runCli, type CliRuntime } from './main.js';
import { createBufferWriter, type BufferWriter } from './output.js';
import type { Ports } from './ports.js';
import {
  createTestPorts,
  createTestStore,
  emptyDiffSummary,
  fakeDiffResult,
  fakeFeedbackEntry,
  fakeInstallDetail,
  fakeRunMeta,
  fakeRunResult,
  fakeRunSummary,
  fakeServeInfo,
} from './testing.js';

interface Harness extends CliRuntime {
  writer: BufferWriter;
}

function harness(overrides: Partial<CliRuntime> = {}): Harness {
  const writer = createBufferWriter();
  return {
    cwd: '/project',
    ports: createTestPorts(),
    version: '0.1.0',
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
    ...overrides,
    writer,
  };
}

function envelope<T>(harnessed: Harness): CliEnvelope<T> {
  const stdout = harnessed.writer.stdout();
  expect(stdout.trimEnd().split('\n'), 'stdout must hold exactly one JSON object').toHaveLength(1);
  return JSON.parse(stdout) as CliEnvelope<T>;
}

const tempDirs: string[] = [];
async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdiff-cli-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

/* ------------------------------------------------------------------ init */

describe('vdiff init', () => {
  it('emits the scaffold envelope and exits 0', async () => {
    const cwd = await tempProject();
    const h = harness({ cwd });

    expect(await runCli(['init', '--json'], h)).toBe(EXIT.OK);
    expect(envelope(h)).toEqual({
      ok: true,
      command: 'init',
      version: '0.1.0',
      data: {
        root: cwd,
        dir: join(cwd, '.visual-diff'),
        created: ['.visual-diff/config.yaml', '.visual-diff/flows/example.yaml'],
        skipped: [],
        gitignore: 'created',
      },
    });
  });
});

/* ------------------------------------------------------------------ flow check */

describe('vdiff flow check', () => {
  it('reports a valid spec with its step ids', async () => {
    const h = harness();
    expect(await runCli(['flow', 'check', 'checkout', '--json'], h)).toBe(EXIT.OK);

    expect(envelope(h)).toEqual({
      ok: true,
      command: 'flow check',
      version: '0.1.0',
      data: {
        flow: 'checkout',
        path: '/project/.visual-diff/flows/checkout.yaml',
        valid: true,
        steps: 2,
        viewports: ['1280x800', '390x844'],
        stepIds: ['cart', 'pay-form'],
        warnings: [],
      },
    });
  });

  it('exits 2 with file, line and offending key for an invalid spec (spec §10)', async () => {
    const ports: Ports = createTestPorts({
      parseFlowFile: async () => ({
        ok: false,
        issues: [
          {
            code: 'sleep-forbidden',
            message: 'a fixed sleep captures half-rendered frames; use waitFor',
            at: {
              file: '/project/.visual-diff/flows/checkout.yaml',
              line: 12,
              column: 5,
              key: 'steps[2].sleep',
            },
          },
        ],
      }),
    });
    const h = harness({ ports });

    expect(await runCli(['flow', 'check', 'checkout', '--json'], h)).toBe(EXIT.CONFIG_ERROR);
    expect(envelope(h)).toEqual({
      ok: false,
      command: 'flow check',
      version: '0.1.0',
      error: {
        code: 'flow-invalid',
        message: "flow 'checkout' is invalid: 1 issue",
        exitCode: EXIT.CONFIG_ERROR,
        issues: [
          {
            code: 'sleep-forbidden',
            message: 'a fixed sleep captures half-rendered frames; use waitFor',
            at: {
              file: '/project/.visual-diff/flows/checkout.yaml',
              line: 12,
              column: 5,
              key: 'steps[2].sleep',
            },
          },
        ],
      },
    });
  });
});

/* ------------------------------------------------------------------ run */

describe('vdiff run', () => {
  it('passes every flag through to the runner', async () => {
    const seen: unknown[] = [];
    const ports = createTestPorts({
      runFlow: async (options) => {
        seen.push(options);
        return fakeRunResult();
      },
    });
    const h = harness({ ports });

    await runCli(
      [
        'run',
        'checkout',
        '--at',
        'HEAD~2',
        '--viewport',
        '390x844',
        '--record',
        '--continue-on-error',
        '--no-scrub',
        '--json',
      ],
      h,
    );

    expect(seen[0]).toEqual({
      flow: 'checkout',
      // The runner is a library function, so the CLI hands it the directory it resolved from.
      cwd: '/project',
      at: 'HEAD~2',
      viewports: ['390x844'],
      network: 'record',
      continueOnError: true,
      noScrub: true,
      json: true,
    });
  });

  it('exits 0 and returns the run result when every step replayed', async () => {
    const h = harness();
    expect(await runCli(['run', 'checkout', '--json'], h)).toBe(EXIT.OK);

    const result = envelope<{ runDir: string; meta: { status: string } }>(h);
    expect(result.ok).toBe(true);
    expect(result.command).toBe('run');
    expect(result.data?.meta.status).toBe('ok');
    expect(result.data?.runDir).toBe('/project/.visual-diff/runs/checkout/0007');
  });

  it('exits 1 on a partial run but still returns the evidence (spec §7, §9)', async () => {
    const ports = createTestPorts({
      runFlow: async () =>
        fakeRunResult({
          meta: fakeRunMeta({
            status: 'partial',
            failedSteps: ['pay-click'],
            warnings: [
              { kind: 'har-miss', message: '2 requests missed the HAR', urls: ['/api/rates'] },
            ],
          }),
        }),
    });
    const h = harness({ ports });

    expect(await runCli(['run', 'checkout', '--json'], h)).toBe(EXIT.RUN_FAILURE);

    const result = envelope<{ meta: { status: string } }>(h);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'run-partial', exitCode: EXIT.RUN_FAILURE });
    expect(result.data?.meta.status).toBe('partial');
    expect(result.warnings).toEqual(['har-miss: 2 requests missed the HAR /api/rates']);
  });
});

/* ------------------------- run: the retained log is printed, not just located (spec §10) ------ */

describe('vdiff run — dev server never ready (spec §10)', () => {
  /** A run directory holding a `server.log` of `lines` numbered lines. */
  async function failedRun(
    logName: string,
    lines: number,
  ): Promise<{ runDir: string; ports: Ports }> {
    const root = await tempProject();
    const runDir = join(root, '.visual-diff', 'runs', 'checkout', '0007');
    await mkdir(runDir, { recursive: true });
    const body = Array.from({ length: lines }, (_, i) => `boot line ${i + 1}`).join('\n');
    await writeFile(join(runDir, logName), `${body}\n`, 'utf8');

    const ports = createTestPorts({
      runFlow: async () =>
        fakeRunResult({
          runDir,
          steps: [],
          meta: fakeRunMeta({
            status: 'failed',
            failure: {
              kind: 'server-not-ready',
              message: 'dev server never became ready at http://localhost:5173/ within 60000ms',
              logPath: logName,
            },
          }),
        }),
    });
    return { runDir, ports };
  }

  it('prints the last 50 lines of the server log and exits 1', async () => {
    const { ports } = await failedRun('server.log', 200);
    const h = harness({ ports });

    expect(await runCli(['run', 'checkout'], h)).toBe(EXIT.RUN_FAILURE);

    const stderr = h.writer.stderr();
    expect(stderr).toContain('dev server never became ready');
    expect(stderr).toContain('last 50 lines of server.log');
    // The tail is exactly the last 50 lines: 151..200 present, 150 and earlier gone.
    for (let line = 151; line <= 200; line += 1) {
      expect(stderr, `line ${line}`).toContain(`boot line ${line}\n`);
    }
    expect(stderr).not.toContain('boot line 150\n');
    expect(stderr).not.toContain('boot line 1\n');
  });

  it('carries the same tail in the --json envelope, so an agent never has to open the file', async () => {
    const { runDir, ports } = await failedRun('server.log', 60);
    const h = harness({ ports });

    expect(await runCli(['run', 'checkout', '--json'], h)).toBe(EXIT.RUN_FAILURE);

    const result = envelope(h);
    expect(result.error?.code).toBe('run-server-not-ready');
    const hint = result.error?.hint ?? '';
    expect(hint).toContain(join(runDir, 'server.log'));
    expect(hint).toContain('boot line 60');
    expect(hint).toContain('boot line 11');
    expect(hint).not.toContain('boot line 10\n');
  });

  it('prints a short log whole, with no "last N lines" claim', async () => {
    const { ports } = await failedRun('server.log', 3);
    const h = harness({ ports });

    await runCli(['run', 'checkout', '--json'], h);
    const hint = envelope(h).error?.hint ?? '';
    expect(hint).not.toContain('last 50 lines');
    expect(hint).toContain('boot line 1');
    expect(hint).toContain('boot line 3');
  });

  it('does the same for a retained install.log', async () => {
    const { ports } = await failedRun('install.log', 4);
    const h = harness({ ports });

    await runCli(['run', 'checkout', '--json'], h);
    expect(envelope(h).error?.hint).toContain('install.log');
  });

  it('falls back to naming the log when it cannot be read, and still exits 1', async () => {
    const ports = createTestPorts({
      runFlow: async () =>
        fakeRunResult({
          steps: [],
          meta: fakeRunMeta({
            status: 'failed',
            failure: { kind: 'server-not-ready', message: 'never ready', logPath: 'server.log' },
          }),
        }),
    });
    const h = harness({ ports });

    expect(await runCli(['run', 'checkout', '--json'], h)).toBe(EXIT.RUN_FAILURE);
    expect(envelope(h).error?.hint).toBe('log: server.log');
  });
});

/* ------------------------------------------------------------------ runs */

describe('vdiff runs', () => {
  it('emits the timeline, pruned entries included', async () => {
    const store = createTestStore({
      runs: {
        checkout: [
          fakeRunSummary({ runId: '0003', pruned: true, findingsCount: 4 }),
          fakeRunSummary({ runId: '0007', findingsCount: null }),
        ],
      },
    });
    const h = harness({ ports: createTestPorts({ openStore: async () => store }) });

    expect(await runCli(['runs', 'checkout', '--json'], h)).toBe(EXIT.OK);

    const result = envelope<{ flow: string; runs: Array<{ runId: string; pruned: boolean }> }>(h);
    expect(result.command).toBe('runs');
    expect(result.data?.flow).toBe('checkout');
    expect(result.data?.runs.map((run) => run.runId)).toEqual(['0003', '0007']);
    expect(result.data?.runs[0]?.pruned).toBe(true);
  });

  it('renders a table in human mode and writes nothing to stderr', async () => {
    const store = createTestStore({ runs: { checkout: [fakeRunSummary({ runId: '0007' })] } });
    const h = harness({ ports: createTestPorts({ openStore: async () => store }) });

    expect(await runCli(['runs', 'checkout'], h)).toBe(EXIT.OK);
    expect(h.writer.stdout()).toContain('RUN');
    expect(h.writer.stdout()).toContain('0007');
    expect(h.writer.stderr()).toBe('');
  });
});

/* ------------------------------------------------------------------ diff */

function findingFixture(): Finding {
  return {
    id: 'f1',
    kind: 'content',
    severity: 'med',
    step: 'pay-form',
    viewport: '1280x800',
    element: { selector: '[data-test=pay]', role: 'button', name: 'Pay now' },
    region: { x: 6, y: 56, w: 86, h: 19 },
    nodeChange: 'text',
    changes: [
      { prop: 'text', from: 'Pay', to: 'Pay now' },
      { prop: 'width', from: 52, to: 78 },
    ],
    label: 'text changed',
    reasons: [],
  };
}

function diffWithFindings(): DiffResult {
  const viewport: ViewportDiff = {
    viewport: '1280x800',
    pixelChangedRatio: 0.021,
    baseSize: { w: 1280, h: 2400 },
    headSize: { w: 1280, h: 2400 },
    dimensionsChanged: false,
    regions: [{ id: 'r1', rect: { x: 6, y: 56, w: 86, h: 19 }, area: 1634, changedPixels: 900, density: 0.55 }],
    findings: [findingFixture()],
  };
  const step: StepDiff = {
    id: 'pay-form',
    status: 'matched',
    viewports: { '1280x800': viewport },
    findings: [],
  };
  return fakeDiffResult({
    steps: [step],
    flowDiff: [
      { id: 'receipt', status: 'added', baseIndex: null, headIndex: 3 },
      {
        id: 'pay-click',
        status: 'spec-changed',
        detail: "selector '#pay' -> '[data-test=pay]'",
        baseIndex: 2,
        headIndex: 2,
      },
    ],
    summary: emptyDiffSummary({
      totalFindings: 1,
      bySeverity: { high: 0, med: 1, low: 0 },
      stepsCompared: 1,
      stepsChanged: 1,
      stepsAdded: 1,
      stepsSpecChanged: 1,
      maxPixelChangedRatio: 0.021,
    }),
  });
}

describe('vdiff diff', () => {
  it('exits 0 even when findings exist — findings are information, not a gate (spec §9)', async () => {
    const ports = createTestPorts({ computeDiff: async () => diffWithFindings() });
    const h = harness({ ports });

    const code = await runCli(['diff', 'checkout', '0003', '0007', '--json'], h);

    expect(code).toBe(EXIT.OK);
    const result = envelope<{ result: DiffResult }>(h);
    expect(result.ok).toBe(true);
    expect(result.data?.result.summary.totalFindings).toBe(1);
  });

  it('exits 0 with high-severity findings too', async () => {
    const severe = diffWithFindings();
    severe.summary.bySeverity = { high: 9, med: 0, low: 0 };
    severe.summary.totalFindings = 9;
    const h = harness({ ports: createTestPorts({ computeDiff: async () => severe }) });

    expect(await runCli(['diff', 'checkout', '0003', '0007'], h)).toBe(EXIT.OK);
  });

  it('computes, stores and reports the pair', async () => {
    const store = createTestStore({
      runs: { checkout: [fakeRunSummary({ runId: '0003' }), fakeRunSummary({ runId: '0007' })] },
    });
    const dirs: string[][] = [];
    const ports = createTestPorts({
      openStore: async () => store,
      computeDiff: async (baseDir, headDir) => {
        dirs.push([baseDir, headDir]);
        return diffWithFindings();
      },
    });
    const h = harness({ ports });

    expect(await runCli(['diff', 'checkout', '--json'], h)).toBe(EXIT.OK);

    // Defaults are N-1 vs N, resolved by the store.
    expect(dirs[0]).toEqual([
      '/project/.visual-diff/runs/checkout/0003',
      '/project/.visual-diff/runs/checkout/0007',
    ]);
    expect(store.state.calls).toContain('writeDiff checkout/0003..0007');

    const result = envelope<{ pair: unknown; path: string; cached: boolean }>(h);
    expect(result.data?.pair).toEqual({ flow: 'checkout', base: '0003', head: '0007' });
    expect(result.data?.cached).toBe(false);
    expect(result.data?.path).toBe(
      '/project/.visual-diff/diffs/checkout/0003..0007/findings.json',
    );
  });

  it('reuses a stored diff rather than recomputing (spec §8)', async () => {
    const store = createTestStore({
      runs: { checkout: [fakeRunSummary({ runId: '0003' }), fakeRunSummary({ runId: '0007' })] },
      diffs: { 'checkout/0003..0007': diffWithFindings() },
    });
    let computed = 0;
    const ports = createTestPorts({
      openStore: async () => store,
      computeDiff: async () => {
        computed += 1;
        return diffWithFindings();
      },
    });
    const h = harness({ ports });

    expect(await runCli(['diff', 'checkout', '--json'], h)).toBe(EXIT.OK);
    expect(computed).toBe(0);
    expect(envelope<{ cached: boolean }>(h).data?.cached).toBe(true);
  });

  it('recomputes when the stored diff came from an older engine version', async () => {
    const stale = fakeDiffResult({ engineVersion: '0' });
    const store = createTestStore({
      runs: { checkout: [fakeRunSummary({ runId: '0003' }), fakeRunSummary({ runId: '0007' })] },
      diffs: { 'checkout/0003..0007': stale },
    });
    let computed = 0;
    const ports = createTestPorts({
      openStore: async () => store,
      computeDiff: async () => {
        computed += 1;
        return diffWithFindings();
      },
    });
    const h = harness({ ports });

    await runCli(['diff', 'checkout', '--json'], h);
    expect(computed).toBe(1);
  });

  it('prints the finding table in human mode', async () => {
    const h = harness({ ports: createTestPorts({ computeDiff: async () => diffWithFindings() }) });
    await runCli(['diff', 'checkout', '0003', '0007'], h);

    const stdout = h.writer.stdout();
    expect(stdout).toContain('checkout  0003..0007');
    expect(stdout).toContain('1 findings');
    expect(stdout).toContain('[data-test=pay]');
    expect(stdout).toContain('text changed');
    expect(stdout).toContain('2.1%');
  });
});

/* ------------------------------------------------------------------ serve */

describe('vdiff serve', () => {
  it('emits the serve info, then blocks until shutdown and closes', async () => {
    let closed = false;
    let waited = false;
    const ports = createTestPorts({
      serveReport: async (config, options) => {
        expect(config.root).toBe('/project');
        expect(options).toEqual({ open: true, json: true, port: 4321 });
        return {
          info: fakeServeInfo(),
          close: async () => {
            closed = true;
          },
        };
      },
    });
    const h = harness({
      ports,
      waitForShutdown: async () => {
        waited = true;
      },
    });

    expect(await runCli(['serve', '--open', '--port', '4321', '--json'], h)).toBe(EXIT.OK);
    expect(envelope(h)).toEqual({
      ok: true,
      command: 'serve',
      version: '0.1.0',
      data: fakeServeInfo(),
    });
    expect(waited).toBe(true);
    expect(closed).toBe(true);
  });
});

/* ------------------------------------------------------------------ feedback */

describe('vdiff feedback', () => {
  it('returns pending comments and leaves them pending without --ack', async () => {
    const store = createTestStore({ pending: [fakeFeedbackEntry()] });
    const h = harness({ ports: createTestPorts({ openStore: async () => store }) });

    expect(await runCli(['feedback', '--json'], h)).toBe(EXIT.OK);
    expect(envelope(h)).toEqual({
      ok: true,
      command: 'feedback',
      version: '0.1.0',
      data: { count: 1, entries: [fakeFeedbackEntry()], acked: false, archive: null },
    });
    expect(store.state.pending).toHaveLength(1);
    expect(store.state.calls).not.toContain('ackFeedback 1');
  });

  it('archives exactly what it read with --ack (spec §9)', async () => {
    const store = createTestStore({ pending: [fakeFeedbackEntry(), fakeFeedbackEntry({ id: 'fb_02' })] });
    const h = harness({ ports: createTestPorts({ openStore: async () => store }) });

    expect(await runCli(['feedback', '--json', '--ack'], h)).toBe(EXIT.OK);

    const result = envelope<{ count: number; archive: string; entries: Array<{ status: string }> }>(h);
    expect(result.data?.count).toBe(2);
    expect(result.data?.archive).toBe('/project/.visual-diff/feedback/archive/2026-08-08.jsonl');
    expect(result.data?.entries.every((entry) => entry.status === 'acked')).toBe(true);
    expect(store.state.pending).toEqual([]);
    expect(store.state.calls).toContain('ackFeedback 2');
  });

  it('does not archive when there is nothing pending', async () => {
    const store = createTestStore({ pending: [] });
    const h = harness({ ports: createTestPorts({ openStore: async () => store }) });

    await runCli(['feedback', '--json', '--ack'], h);
    expect(envelope<{ archive: string | null }>(h).data?.archive).toBeNull();
    expect(store.state.calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ pin / prune */

describe('vdiff pin | prune', () => {
  it('pins a run, resolving the flow when only a run id was given', async () => {
    const store = createTestStore({ runs: { checkout: [fakeRunSummary({ runId: '0007' })] } });
    const h = harness({ ports: createTestPorts({ openStore: async () => store }) });

    expect(await runCli(['pin', '0007', '--json'], h)).toBe(EXIT.OK);
    expect(envelope(h)).toEqual({
      ok: true,
      command: 'pin',
      version: '0.1.0',
      data: { flow: 'checkout', runId: '0007', pinned: true },
    });
    expect(store.state.calls).toContain('pinRun checkout 0007');
  });

  it('refuses an ambiguous run id instead of guessing the flow', async () => {
    const store = createTestStore({
      runs: {
        checkout: [fakeRunSummary({ runId: '0007' })],
        settings: [fakeRunSummary({ runId: '0007', flow: 'settings' })],
      },
    });
    const h = harness({ ports: createTestPorts({ openStore: async () => store }) });

    expect(await runCli(['pin', '0007', '--json'], h)).toBe(EXIT.CONFIG_ERROR);
    const result = envelope(h);
    expect(result.error?.code).toBe('run-ambiguous');
    expect(result.error?.hint).toBe('vdiff pin checkout 0007');
    expect(store.state.calls).toEqual([]);
  });

  it('reports an unknown run as a config error', async () => {
    const store = createTestStore({ runs: { checkout: [fakeRunSummary({ runId: '0007' })] } });
    const h = harness({ ports: createTestPorts({ openStore: async () => store }) });

    expect(await runCli(['prune', 'checkout', '0001', '--json'], h)).toBe(EXIT.CONFIG_ERROR);
    expect(envelope(h).error?.code).toBe('run-not-found');
  });

  it('prunes a run and prints the backfill command', async () => {
    const store = createTestStore({ runs: { checkout: [fakeRunSummary({ runId: '0007' })] } });
    const h = harness({ ports: createTestPorts({ openStore: async () => store }) });

    expect(await runCli(['prune', 'checkout', '0007'], h)).toBe(EXIT.OK);
    expect(h.writer.stdout()).toContain('vdiff run checkout --at 9f8e7d6c5b4a');
    expect(store.state.calls).toContain('pruneRun checkout 0007');
  });
});

/* ------------------------------------------------------------------ install */

describe('vdiff install <harness>', () => {
  it('emits the adapter report and exits 0', async () => {
    const h = harness();
    expect(await runCli(['install', 'claude-code', '--json'], h)).toBe(EXIT.OK);

    const result = envelope<{
      harness: string;
      label: string;
      root: string;
      written: string[];
      dryRun: boolean;
    }>(h);
    expect(result.command).toBe('install');
    expect(result.data?.harness).toBe('claude-code');
    expect(result.data?.label).toBe('Claude Code');
    expect(result.data?.root).toBe('/project');
    expect(result.data?.written).toContain('.claude/skills/visual-diff/SKILL.md');
    expect(result.data?.dryRun).toBe(false);
  });

  it('--list emits the documented envelope and never asks the adapter to write', async () => {
    const seen: unknown[] = [];
    const ports = createTestPorts({
      installAdapter: async (id, root, options) => {
        seen.push({ id, root, options });
        return fakeInstallDetail();
      },
    });
    const h = harness({ cwd: '/project', ports });

    expect(await runCli(['install', '--list', '--json'], h)).toBe(EXIT.OK);

    const result = envelope<{ harnesses: Array<{ id: string; label: string; files: string[] }> }>(h);
    expect(result.ok).toBe(true);
    expect(result.command).toBe('install');
    expect(result.data?.harnesses[0]?.id).toBe('claude-code');
    expect(result.data?.harnesses[0]?.files).toContain('.claude/skills/visual-diff/SKILL.md');
    expect(seen).toEqual([{ id: 'claude-code', root: '/project', options: { dryRun: true } }]);
  });

  it('exits 2 on an unknown harness and lists the supported ones', async () => {
    const h = harness();
    expect(await runCli(['install', 'opencode', '--json'], h)).toBe(EXIT.CONFIG_ERROR);

    expect(envelope(h).error).toEqual({
      code: 'unknown-harness',
      message: "unknown harness 'opencode'",
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'supported harnesses: claude-code',
    });
  });

  it('exits 2 when the harness argument is missing', async () => {
    const h = harness();
    expect(await runCli(['install', '--json'], h)).toBe(EXIT.CONFIG_ERROR);
    expect(envelope(h).error?.code).toBe('missing-argument');
  });

  it('hands --dir, --force and --dry-run to the adapter', async () => {
    const seen: unknown[] = [];
    const ports = createTestPorts({
      installAdapter: async (id, root, options) => {
        seen.push({ id, root, options });
        return fakeInstallDetail();
      },
    });
    const h = harness({ cwd: '/project', ports });

    expect(
      await runCli(['install', 'claude-code', '--dir', 'apps/web', '--force', '--dry-run'], h),
    ).toBe(EXIT.OK);
    expect(seen[0]).toEqual({
      id: 'claude-code',
      root: join('/project', 'apps/web'),
      options: { force: true, dryRun: true },
    });
    expect(h.writer.stdout()).toContain('dry run');
  });
});

/* ------------------------------------------------------------------ install-browser */

describe('vdiff install-browser', () => {
  it('reports success and the command it ran', async () => {
    const h = harness({ spawn: async () => ({ code: 0, stdout: 'downloaded', stderr: '' }) });

    expect(await runCli(['install-browser', '--json'], h)).toBe(EXIT.OK);
    const result = envelope<{ browser: string; installed: boolean; command: string }>(h);
    expect(result.data?.browser).toBe('chromium');
    expect(result.data?.installed).toBe(true);
    expect(result.data?.command).toContain('install chromium');
  });

  it('exits 1 when the install fails', async () => {
    const h = harness({
      spawn: async () => ({ code: 1, stdout: '', stderr: 'no network' }),
    });

    expect(await runCli(['install-browser', '--json'], h)).toBe(EXIT.RUN_FAILURE);
    expect(envelope(h).error).toMatchObject({
      code: 'browser-install-failed',
      exitCode: EXIT.RUN_FAILURE,
    });
  });
});

/* ------------------------------------------------------------------ help, version, errors */

describe('help, version and argument errors', () => {
  it('prints usage for a bare invocation and exits 0', async () => {
    const h = harness();
    expect(await runCli([], h)).toBe(EXIT.OK);
    const stdout = h.writer.stdout();
    expect(stdout).toContain('vdiff run <flow>');
    expect(stdout).toContain('vdiff diff` exits 0 even when findings exist');
  });

  it('emits the version envelope', async () => {
    const h = harness();
    expect(await runCli(['--version', '--json'], h)).toBe(EXIT.OK);
    expect(envelope(h)).toEqual({
      ok: true,
      command: 'version',
      version: '0.1.0',
      data: { version: '0.1.0' },
    });
  });

  it('exits 2 on an unknown command, in JSON when JSON was asked for', async () => {
    const h = harness();
    expect(await runCli(['frobnicate', '--json'], h)).toBe(EXIT.CONFIG_ERROR);
    expect(envelope(h)).toEqual({
      ok: false,
      command: 'vdiff',
      version: '0.1.0',
      error: {
        code: 'unknown-command',
        message: "unknown command 'frobnicate'",
        exitCode: EXIT.CONFIG_ERROR,
        hint: 'vdiff --help',
      },
    });
  });

  it('writes human errors to stderr, keeping stdout clean for pipelines', async () => {
    const h = harness();
    expect(await runCli(['run'], h)).toBe(EXIT.CONFIG_ERROR);
    expect(h.writer.stdout()).toBe('');
    expect(h.writer.stderr()).toContain('missing-argument');
  });

  it('maps a module error that carries a CliError payload straight to its exit code', async () => {
    class StoreLikeError extends Error {
      readonly code = 'locked';
      readonly exitCode = EXIT.RUN_FAILURE;
      readonly hint = 'another vdiff run holds .locks/checkout.lock';
    }
    const ports = createTestPorts({
      openStore: async () => {
        throw new StoreLikeError('flow checkout is locked by pid 999');
      },
    });
    const h = harness({ ports });

    expect(await runCli(['runs', 'checkout', '--json'], h)).toBe(EXIT.RUN_FAILURE);
    expect(envelope(h).error).toEqual({
      code: 'locked',
      message: 'flow checkout is locked by pid 999',
      exitCode: EXIT.RUN_FAILURE,
      hint: 'another vdiff run holds .locks/checkout.lock',
    });
  });

  it('treats an unrecognised throw as an internal run failure', async () => {
    const ports = createTestPorts({
      openStore: async () => {
        throw new Error('ENOENT: no such file');
      },
    });
    const h = harness({ ports });

    expect(await runCli(['runs', 'checkout', '--json'], h)).toBe(EXIT.RUN_FAILURE);
    expect(envelope(h).error).toEqual({
      code: 'internal',
      message: 'ENOENT: no such file',
      exitCode: EXIT.RUN_FAILURE,
    });
  });
});

/* ------------------------------------------------------------------ stdout purity */

describe('--json output purity (spec §11.6)', () => {
  it('never writes anything but the envelope to stdout, on success or failure', async () => {
    const cwd = await tempProject();
    const cases: Array<{ argv: string[]; runtime?: Partial<CliRuntime> }> = [
      { argv: ['init', '--json'], runtime: { cwd } },
      { argv: ['flow', 'check', 'checkout', '--json'] },
      { argv: ['run', 'checkout', '--json'] },
      { argv: ['runs', 'checkout', '--json'] },
      { argv: ['diff', 'checkout', '0003', '0007', '--json'] },
      { argv: ['serve', '--json'] },
      { argv: ['feedback', '--json'] },
      { argv: ['install', 'claude-code', '--json'], runtime: { cwd } },
      { argv: ['install', 'nope', '--json'] },
      { argv: ['install-browser', '--json'] },
      { argv: ['--version', '--json'] },
      { argv: ['--help', '--json'] },
      { argv: ['nope', '--json'] },
    ];

    for (const testCase of cases) {
      const h = harness(testCase.runtime ?? {});
      await runCli(testCase.argv, h);
      const stdout = h.writer.stdout();
      expect(() => JSON.parse(stdout) as unknown, testCase.argv.join(' ')).not.toThrow();
      expect(h.writer.stderr(), testCase.argv.join(' ')).toBe('');
    }
  });

  it('leaves the scaffolded config on disk, not just in the envelope', async () => {
    const cwd = await tempProject();
    const h = harness({ cwd });
    await runCli(['init', '--json'], h);

    const config = await readFile(join(cwd, '.visual-diff', 'config.yaml'), 'utf8');
    expect(config).toContain('keepRuns: 20');
    const gitignore = await readFile(join(cwd, '.gitignore'), 'utf8');
    expect(gitignore).toContain('!.visual-diff/flows/');
  });
});
