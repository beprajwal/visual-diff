/**
 * cli — in-memory implementations of the module edges (`Ports`), plus fixture builders.
 *
 * Used by the colocated command tests and by the `--json` contract tests in `tests/contract`.
 * They are real values, not throwing stubs: a test that forgets to configure a port still gets a
 * well-formed empty answer, so a failure points at the assertion rather than at the double.
 *
 * Kept in `src/` rather than `tests/` because the CLI's contract tests live outside this module
 * and need the same doubles; that is also why every builder takes an override object.
 */

import {
  DEFAULTS,
  DIFF_ENGINE_VERSION,
  type Config,
  type DiffResult,
  type DiffSummary,
  type FeedbackEntry,
  type FlowSpec,
  type PairRef,
  type RunId,
  type RunMeta,
  type RunResult,
  type RunSummary,
  type ServeInfo,
} from '../types.js';

import type { AdapterInstallDetail, FileOutcome } from '../adapters/index.js';

import type { HarnessInfo, Ports, ServeHandle, StorePort } from './ports.js';

/**
 * The registry as the CLI sees it. Deliberately mirrors the real one (spec §5 registers exactly
 * one adapter in slice 1); `src/adapters/index.test.ts` is what pins the real list.
 */
export function fakeHarnesses(): HarnessInfo[] {
  return [{ id: 'claude-code', label: 'Claude Code' }];
}

/** A successful first install: three managed files, all created. */
export function fakeInstallDetail(
  overrides: Partial<AdapterInstallDetail> = {},
): AdapterInstallDetail {
  const files: FileOutcome[] = [
    { path: '.claude/skills/visual-diff/SKILL.md', status: 'created' },
    { path: '.claude/commands/vdiff.md', status: 'created' },
    { path: '.claude/commands/vdiff-review.md', status: 'created' },
  ];
  return {
    id: 'claude-code',
    written: files.map((file) => file.path),
    skipped: [],
    files,
    ...overrides,
  };
}

export function fakeConfig(root = '/project', overrides: Partial<Config> = {}): Config {
  return {
    root,
    dir: `${root}/.visual-diff`,
    app: {
      install: 'npm ci',
      dev: 'npm run dev -- --port $PORT',
      readyOn: 'http://localhost:$PORT/',
      readyTimeoutMs: DEFAULTS.readyTimeoutMs,
    },
    diff: {
      minRegionArea: DEFAULTS.diff.minRegionArea,
      maxRegions: DEFAULTS.diff.maxRegions,
      antialiasTolerance: DEFAULTS.diff.antialiasTolerance,
      ignore: [...DEFAULTS.diff.ignore],
    },
    network: { redact: [...DEFAULTS.network.redact], scrub: DEFAULTS.network.scrub },
    retention: { keepRuns: DEFAULTS.retention.keepRuns },
    ...overrides,
  };
}

export function fakeFlowSpec(overrides: Partial<FlowSpec> = {}): FlowSpec {
  return {
    version: 1,
    flow: 'checkout',
    baseUrl: 'http://localhost:5173',
    viewports: ['1280x800', '390x844'],
    network: { mode: 'replay', har: 'checkout.har' },
    steps: [
      { id: 'cart', goto: '/cart', waitFor: '[data-test=cart-list]', shoot: true },
      { id: 'pay-form', click: '[data-test=pay]', waitFor: 'text=Payment', shoot: true },
    ],
    ...overrides,
  };
}

export function fakeRunMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: '0007',
    flow: 'checkout',
    flowHash: 'sha256:0000',
    revision: { sha: '9f8e7d6c5b4a', ref: 'feat/pay', dirty: true, dirtyHash: 'sha256:1111' },
    mode: 'attach',
    network: 'replay',
    harHits: 41,
    harMisses: 0,
    viewports: ['1280x800'],
    status: 'ok',
    failedSteps: [],
    env: {
      tool: '0.1.0',
      node: 'v20.11.0',
      playwright: '1.49.0',
      chromium: '131.0.0.0',
      os: 'darwin-arm64',
      deviceScaleFactor: DEFAULTS.deviceScaleFactor,
    },
    startedAt: '2026-08-08T10:00:00Z',
    finishedAt: '2026-08-08T10:00:41Z',
    unstable: false,
    pinned: false,
    pruned: false,
    warnings: [],
    ...overrides,
  };
}

export function fakeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  const meta = fakeRunMeta();
  return {
    runId: meta.runId,
    flow: meta.flow,
    revision: meta.revision,
    mode: meta.mode,
    status: meta.status,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    viewports: meta.viewports,
    failedSteps: [],
    unstable: false,
    pinned: false,
    pruned: false,
    findingsCount: null,
    ...overrides,
  };
}

export function fakeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  const meta = fakeRunMeta();
  return {
    runDir: '/project/.visual-diff/runs/checkout/0007',
    meta,
    steps: [
      {
        id: 'cart',
        index: 0,
        status: 'ok',
        shoot: true,
        startedAt: '2026-08-08T10:00:00Z',
        finishedAt: '2026-08-08T10:00:12Z',
        durationMs: 12_000,
        viewports: {
          '1280x800': {
            viewport: '1280x800',
            screenshot: 'steps/cart/1280x800/screenshot.png',
            dom: 'steps/cart/1280x800/dom.json',
            a11y: 'steps/cart/1280x800/a11y.json',
            width: 1280,
            height: 2400,
            nodeCount: 312,
            truncated: false,
          },
        },
        truncated: false,
        consoleErrors: 0,
        networkRequests: 12,
        harMisses: 0,
      },
    ],
    ...overrides,
  };
}

export function emptyDiffSummary(overrides: Partial<DiffSummary> = {}): DiffSummary {
  return {
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
    ...overrides,
  };
}

export function fakeDiffResult(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    engineVersion: DIFF_ENGINE_VERSION,
    flow: 'checkout',
    pair: { base: '0003', head: '0007' },
    computedAt: '2026-08-08T10:05:00Z',
    baseMeta: fakeRunMeta({ runId: '0003' }),
    headMeta: fakeRunMeta({ runId: '0007' }),
    flowDiff: [],
    steps: [],
    summary: emptyDiffSummary(),
    warnings: [],
    ...overrides,
  };
}

export function fakeServeInfo(overrides: Partial<ServeInfo> = {}): ServeInfo {
  return {
    url: 'http://127.0.0.1:53211/?t=tok3n',
    host: '127.0.0.1',
    port: 53_211,
    token: 'tok3n',
    pid: 4242,
    root: '/project',
    startedAt: '2026-08-08T10:00:00Z',
    ...overrides,
  };
}

export function fakeFeedbackEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id: 'fb_01',
    ts: '2026-08-08T10:12:00Z',
    flow: 'checkout',
    pair: '0003..0007',
    step: 'pay-form',
    viewport: '1280x800',
    findingId: 'f1',
    element: '[data-test=pay]',
    region: { x: 6, y: 56, w: 86, h: 19 },
    crop: 'diffs/checkout/0003..0007/crops/f1.png',
    text: 'padding is too tight',
    status: 'pending',
    ...overrides,
  };
}

export interface TestStoreState {
  root: string;
  /** Flow name → timeline, oldest first. */
  runs: Record<string, RunSummary[]>;
  /** "<flow>/<base>..<head>" → stored diff. */
  diffs: Record<string, DiffResult>;
  pending: FeedbackEntry[];
  /** Every mutation the CLI asked for, in order — lets a test assert delegation. */
  calls: string[];
}

export function createTestStore(state: Partial<TestStoreState> = {}): StorePort & {
  state: TestStoreState;
} {
  const store: TestStoreState = {
    root: state.root ?? '/project',
    runs: state.runs ?? {},
    diffs: state.diffs ?? {},
    pending: state.pending ?? [],
    calls: state.calls ?? [],
  };
  const dir = `${store.root}/.visual-diff`;
  const key = (pair: PairRef): string => `${pair.flow}/${pair.base}..${pair.head}`;

  return {
    state: store,
    flowsDir: () => `${dir}/flows`,
    flowFile: (flow: string) => `${dir}/flows/${flow}.yaml`,
    listFlows: async () => Object.keys(store.runs),
    listRuns: async (flow: string) => store.runs[flow] ?? [],
    resolvePair: async (flow: string, base?: RunId, head?: RunId) => {
      const list = store.runs[flow] ?? [];
      const last = list[list.length - 1];
      const previous = list[list.length - 2];
      return {
        flow,
        base: base ?? previous?.runId ?? '0000',
        head: head ?? last?.runId ?? '0000',
      };
    },
    runDir: (flow: string, runId: RunId) => `${dir}/runs/${flow}/${runId}`,
    diffFile: (pair: PairRef) => `${dir}/diffs/${key(pair)}/findings.json`,
    readDiff: async (pair: PairRef) => store.diffs[key(pair)] ?? null,
    writeDiff: async (pair: PairRef, result: DiffResult) => {
      store.diffs[key(pair)] = result;
      store.calls.push(`writeDiff ${key(pair)}`);
      return `${dir}/diffs/${key(pair)}/findings.json`;
    },
    pinRun: async (flow: string, runId: RunId) => {
      store.calls.push(`pinRun ${flow} ${runId}`);
      const found = (store.runs[flow] ?? []).find((summary) => summary.runId === runId);
      return { ...(found ?? fakeRunSummary({ flow, runId })), pinned: true };
    },
    pruneRun: async (flow: string, runId: RunId) => {
      store.calls.push(`pruneRun ${flow} ${runId}`);
      const found = (store.runs[flow] ?? []).find((summary) => summary.runId === runId);
      return { ...(found ?? fakeRunSummary({ flow, runId })), pruned: true };
    },
    readPendingFeedback: async () => [...store.pending],
    ackFeedback: async (entries: FeedbackEntry[]) => {
      store.calls.push(`ackFeedback ${entries.length}`);
      const ids = new Set(entries.map((entry) => entry.id));
      store.pending = store.pending.filter((entry) => !ids.has(entry.id));
      return {
        archive: `${dir}/feedback/archive/2026-08-08.jsonl`,
        acked: entries.map((entry) => ({
          ...entry,
          status: 'acked' as const,
          ackedAt: '2026-08-08T10:20:00Z',
        })),
      };
    },
  };
}

export function createTestPorts(overrides: Partial<Ports> = {}): Ports {
  const store = createTestStore();
  return {
    loadConfig: async (cwd: string) => fakeConfig(cwd),
    parseFlowFile: async () => ({ ok: true, value: fakeFlowSpec(), warnings: [] }),
    openStore: async () => store,
    runFlow: async () => fakeRunResult(),
    computeDiff: async () => fakeDiffResult(),
    serveReport: async (_config: Config, _options): Promise<ServeHandle> => ({
      info: fakeServeInfo(),
      close: async () => undefined,
    }),
    listAdapters: async () => fakeHarnesses(),
    installAdapter: async () => fakeInstallDetail(),
    ...overrides,
  };
}
