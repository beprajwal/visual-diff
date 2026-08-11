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
  SCENARIO_NONE,
  type Config,
  type DiffResult,
  type DiffSummary,
  type FeedbackEntry,
  type FlowSpec,
  type PairRef,
  type PairScenarios,
  type RunId,
  type RunMeta,
  type RunResult,
  type RunSummary,
  type ScenarioName,
  type ScenarioSpec,
  type ServeInfo,
} from '../types.js';

import { exportBundle, renderComment } from '../ci/index.js';

import type {
  FileOutcome,
  HarnessInstallDetail,
  HarnessTargets,
  InstallOptions,
  InstallScope,
  ManagedFile,
} from '../adapters/index.js';

import type {
  E2eArchivePlan,
  E2eIngestPlan,
  E2eIngestReport,
  E2eIngestedRun,
  HarnessInfo,
  Ports,
  RunFilter,
  ServeHandle,
  StorePort,
  TimelineFilter,
} from './ports.js';
import { sourceOf, type RunSource } from './e2e.js';
import { isKept, VARIANT_NONE, variantOf, type VariantName, type VariantSpec } from './variant.js';

/**
 * The registry as the CLI sees it. Deliberately mirrors one row of the real one; the real table is
 * pinned by `src/adapters/index.test.ts`, and the note is present because install output prints it.
 */
export function fakeHarnesses(): HarnessInfo[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      kinds: ['skills', 'commands', 'instructions'],
      scopes: ['project', 'global'],
      notes: ['a copy in ~/.claude/skills overrides this project one'],
      next: ['`vdiff init` to scaffold .visual-diff/, then `vdiff run <flow>`.'],
    },
    // The CI target, so install output's two shapes — an agent harness and a workflow installer —
    // are both exercised by the command tests (CI spec D34).
    {
      id: 'github-actions',
      label: 'GitHub Actions',
      kinds: ['workflows'],
      scopes: ['project'],
      notes: ['nothing is committed for you'],
      next: ['Commit .github/workflows/ and open a pull request.'],
    },
  ];
}

/** The directories the fake harness claims, per scope. */
export function fakeTargets(scope: InstallScope = 'project'): HarnessTargets {
  return {
    scope,
    skills: '.claude/skills',
    commands: '.claude/commands',
    instructions: null,
    workflows: null,
  };
}

/**
 * What a fake adapter composes. Real frontmatter carrying the version stamp, because `--check`
 * reads that stamp back and a body without one would skip the path being tested.
 */
export function fakeManagedFiles(scope: InstallScope = 'project', version = '0.1.0'): ManagedFile[] {
  const stamp = `metadata:\n  x-vdiff-version: "${version}"\n  x-vdiff-source: "@beprajwal/visual-diff"`;
  return [
    {
      path: '.claude/skills/visual-diff/SKILL.md',
      body: `---\nname: visual-diff\n${stamp}\n---\n\n# Visual Diff (${scope})\n`,
    },
    {
      path: '.claude/commands/vdiff.md',
      body: `---\ndescription: "run"\n${stamp}\n---\n\nRun it.\n`,
    },
    {
      path: '.claude/commands/vdiff-review.md',
      body: `---\ndescription: "review"\n${stamp}\n---\n\nReview it.\n`,
    },
  ];
}

/** Everything the adapter ports were asked for, plus the files the fake believes exist. */
export interface TestInstallState {
  /** Absolute path → body, exactly as last written. Seed it to simulate an existing install. */
  disk: Map<string, string>;
  /** Absolute paths this fake wrote. A path only in `disk` reads as edited by a human. */
  ours: Set<string>;
  /** Every install (or dry run), in order. */
  installs: Array<{ id: string; root: string; options: InstallOptions }>;
  /** Every `adapterFiles` request, in order. */
  composed: Array<{ id: string; scope: InstallScope }>;
}

/**
 * An in-memory stand-in for the adapter edges.
 *
 * It models the one behaviour the install command depends on and cannot fake for itself: a file
 * that is already exactly what we would write is `unchanged`, one we wrote and would now write
 * differently is `updated`, and one we did not write is `preserved`. That is enough for the
 * envelope, precedence and drift tests; the byte-level round trip runs against the real adapter
 * registry in `install.test.ts`.
 */
export function createTestInstall(seed: Partial<TestInstallState> = {}): {
  state: TestInstallState;
  adapterFiles: Ports['adapterFiles'];
  adapterTargets: Ports['adapterTargets'];
  installAdapter: Ports['installAdapter'];
} {
  const state: TestInstallState = {
    disk: seed.disk ?? new Map<string, string>(),
    ours: seed.ours ?? new Set<string>(),
    installs: seed.installs ?? [],
    composed: seed.composed ?? [],
  };

  return {
    state,
    adapterFiles: async (id: string, scope: InstallScope): Promise<ManagedFile[]> => {
      state.composed.push({ id, scope });
      return fakeManagedFiles(scope);
    },
    adapterTargets: async (_id: string, scope: InstallScope): Promise<HarnessTargets> =>
      fakeTargets(scope),
    installAdapter: async (
      id: string,
      root: string,
      options: InstallOptions,
    ): Promise<HarnessInstallDetail> => {
      state.installs.push({ id, root, options });
      const files = fakeManagedFiles(options.scope ?? 'project', options.version ?? '0.1.0');
      const outcomes: FileOutcome[] = files.map((file) => {
        const key = `${root}/${file.path}`;
        const existing = state.disk.get(key);
        const planned: FileOutcome['status'] =
          existing === undefined
            ? 'created'
            : existing === file.body
              ? 'unchanged'
              : state.ours.has(key)
                ? 'updated'
                : 'preserved';
        const status =
          planned === 'preserved' && options.force === true ? 'updated' : planned;
        if ((status === 'created' || status === 'updated') && options.dryRun !== true) {
          state.disk.set(key, file.body);
          state.ours.add(key);
        }
        return { path: file.path, status };
      });
      return {
        id: id as HarnessInstallDetail['id'],
        written: outcomes
          .filter((o) => o.status === 'created' || o.status === 'updated')
          .map((o) => o.path),
        skipped: outcomes
          .filter((o) => o.status === 'unchanged' || o.status === 'preserved')
          .map((o) => o.path),
        files: outcomes,
      };
    },
  };
}

/** The version stamp the fake writes, read back the way the real adapter reads it. */
export function fakeReadInstalledVersion(content: string): string | null {
  const match = /x-vdiff-version:\s*"([^"]*)"/.exec(content);
  return match === null ? null : (match[1] as string);
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

export function fakeScenarioSpec(overrides: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return {
    version: 1,
    scenario: 'empty-forecast',
    description: 'No forecast data, for checking the empty state',
    mode: 'overlay',
    rules: [
      {
        id: 'forecast-empty',
        match: { method: 'GET', url: '**/v1/forecast**' },
        patch: { hourly: { temperature_2m: [] } },
      },
      { id: 'no-analytics', match: { url: '**/analytics/**' }, abort: true },
    ],
    ...overrides,
  };
}

/**
 * A variant with one rule per verb the report and the CLI have to render, so a summary built from
 * it exercises the whole vocabulary rather than the one verb that happened to be written first.
 */
export function fakeVariantSpec(overrides: Partial<VariantSpec> = {}): VariantSpec {
  return {
    version: 1,
    variant: 'denser-forecast',
    description: 'Tighter cards, air quality hidden, upsell promoted',
    rules: [
      { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
      { id: 'hide-air-quality', match: '[data-test=air-quality]', hide: true },
      {
        id: 'promote-upsell',
        clone: {
          from: { step: 'pricing', match: '[data-test=plan-card]:first-child' },
          into: '[data-test=sidebar]',
          position: 'prepend',
          times: 1,
        },
      },
    ],
    ...overrides,
  };
}

export function fakePairScenarios(overrides: Partial<PairScenarios> = {}): PairScenarios {
  return {
    base: SCENARIO_NONE,
    head: SCENARIO_NONE,
    crossScenario: false,
    mockVsRecorded: false,
    ...overrides,
  };
}

/**
 * `RunMeta` as this slice's tests need it: with the variant axis (variants spec §5) declared
 * optional, so the default fixture is what a `meta.json` written before variants existed looks
 * like — no key at all — and a test that cares passes one explicitly.
 */
export type FakeRunMeta = RunMeta & { variant?: VariantName; source?: RunSource; e2e?: object };
export type FakeRunSummary = RunSummary & { variant?: VariantName; source?: RunSource };

export function fakeRunMeta(overrides: Partial<FakeRunMeta> = {}): FakeRunMeta {
  return {
    runId: '0007',
    flow: 'checkout',
    scenario: SCENARIO_NONE,
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

export function fakeRunSummary(overrides: Partial<FakeRunSummary> = {}): FakeRunSummary {
  const meta = fakeRunMeta();
  return {
    runId: meta.runId,
    flow: meta.flow,
    scenario: meta.scenario,
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

/**
 * The store's narrowing, as the fake implements it: both axes of run identity, each compared
 * against the *recorded* value — so `{ variant: 'none' }` selects the runs that had none, exactly
 * as it does for a scenario.
 */
/**
 * Whether a run in a bucket survives that bucket's switch.
 *
 * `inBucket` is the run's membership, `filter` the request. Omitting the switch is `exclude`, which
 * is what the store does and therefore what a double has to do for the commands written against it
 * to be exercised honestly.
 */
function passesBucket(inBucket: boolean, filter: TimelineFilter | undefined): boolean {
  switch (filter ?? 'exclude') {
    case 'include':
      return true;
    case 'only':
      return inBucket;
    default:
      return !inBucket;
  }
}

function narrow(runs: readonly RunSummary[], filter?: RunFilter): RunSummary[] {
  if (filter === undefined) return [...runs];
  return runs.filter((run) => {
    if (filter.scenario !== undefined && run.scenario !== filter.scenario) return false;
    // The bucket switches, defaulted to `exclude` exactly as the store defaults them — so a fake
    // seeded with an ingested run keeps it out of the plain timeline, which is the behaviour the
    // `runs` and `diff` commands are written against.
    if (!passesBucket(sourceOf(run) === 'e2e', filter.e2e)) return false;
    // Naming a variant overrides the bucket switch, exactly as the real store does: asking for a
    // proposal by name is an unambiguous request to see it, promoted or not.
    if (filter.variant !== undefined) return variantOf(run) === filter.variant;
    return passesBucket(variantOf(run) !== VARIANT_NONE && !isKept(run), filter.variants);
  });
}

/* ------------------------------------------------------------------ the e2e edge (§6) */

/** One archive a fake plan holds. Defaults describe a healthy trace: titled, with shots, new. */
export function fakeArchivePlan(overrides: Partial<E2eArchivePlan> = {}): E2eArchivePlan {
  return {
    path: '/project/test-results/weather-forecast-chromium/trace.zip',
    hash: 'sha256:aaaa',
    flow: 'weather-shows-the-forecast',
    title: 'weather.spec.ts:12 › weather › shows the forecast',
    steps: ['open-the-dashboard', 'run-the-search'],
    shots: 5,
    traceVersion: 8,
    origin: {
      traceHash: 'sha256:aaaa',
      title: 'weather.spec.ts:12 › weather › shows the forecast',
      traceVersion: 8,
      browser: 'chromium',
      playwrightVersion: '1.62.1',
      platform: 'darwin',
    },
    alreadyIngested: false,
    runId: null,
    notices: [],
    ...overrides,
  };
}

export function fakeIngestPlan(overrides: Partial<E2eIngestPlan> = {}): E2eIngestPlan {
  return {
    from: 'trace',
    pattern: 'test-results/**/trace.zip',
    archives: [fakeArchivePlan()],
    unmatchedMapEntries: [],
    warnings: [],
    ...overrides,
  };
}

export function fakeIngestedRun(overrides: Partial<E2eIngestedRun> = {}): E2eIngestedRun {
  const archive = fakeArchivePlan();
  return {
    path: archive.path,
    hash: archive.hash,
    flow: archive.flow,
    runId: '0001',
    reused: false,
    steps: archive.steps,
    shots: archive.shots,
    notices: [],
    ...overrides,
  };
}

export function fakeIngestReport(overrides: Partial<E2eIngestReport> = {}): E2eIngestReport {
  return {
    from: 'trace',
    pattern: 'test-results/**/trace.zip',
    runs: [fakeIngestedRun()],
    unmatchedMapEntries: [],
    warnings: [],
    ...overrides,
  };
}

export interface TestE2eState {
  plan: E2eIngestPlan;
  report: E2eIngestReport;
  /** Every request the CLI made, in order — `plan` twice means it planned before ingesting. */
  calls: Array<{ call: 'plan' | 'ingest'; from: string; pattern: string; cwd: string; flow?: string }>;
}

/**
 * An in-memory stand-in for the ingestion edge.
 *
 * It returns whatever plan and report it was seeded with, and records what it was asked. That is
 * enough for every CLI-side decision — the refusals, the envelope, the human table — because none of
 * them depends on a real archive; the archive reading is tested against real fixture zips in the
 * ingestion module's own suite.
 */
export function createTestE2e(seed: Partial<TestE2eState> = {}): {
  state: TestE2eState;
  planE2eIngest: Ports['planE2eIngest'];
  ingestE2eTraces: Ports['ingestE2eTraces'];
} {
  const state: TestE2eState = {
    plan: seed.plan ?? fakeIngestPlan(),
    report: seed.report ?? fakeIngestReport(),
    calls: seed.calls ?? [],
  };
  return {
    state,
    planE2eIngest: async (_config, request) => {
      state.calls.push({ call: 'plan', ...request });
      return state.plan;
    },
    ingestE2eTraces: async (_config, request) => {
      state.calls.push({ call: 'ingest', ...request });
      return state.report;
    },
  };
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
    listRuns: async (flow: string, filter?: RunFilter) => narrow(store.runs[flow] ?? [], filter),
    // Mirrors the real store: the filter narrows *which* runs the N-1/N default is taken over, and
    // an explicitly named run is honoured whatever it was captured under.
    resolvePair: async (flow: string, base?: RunId, head?: RunId, filter?: RunFilter) => {
      const list = narrow(store.runs[flow] ?? [], filter);
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
    exportDir: (pair: PairRef) => `${dir}/exports/${key(pair)}`,
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

/**
 * Scenario names the default {@link createTestPorts} reports from `listScenarios`. Overridden per
 * test; kept here so the default is a real (empty) answer rather than a throwing stub.
 */
export const TEST_SCENARIOS: ScenarioName[] = [];

/** The variant equivalent of {@link TEST_SCENARIOS}: a real empty answer, not a throwing stub. */
export const TEST_VARIANTS: VariantName[] = [];

export function createTestPorts(overrides: Partial<Ports> = {}): Ports {
  const store = createTestStore();
  const adapters = createTestInstall();
  const e2e = createTestE2e();
  return {
    planE2eIngest: e2e.planE2eIngest,
    ingestE2eTraces: e2e.ingestE2eTraces,
    loadConfig: async (cwd: string) => fakeConfig(cwd),
    parseFlowFile: async () => ({ ok: true, value: fakeFlowSpec(), warnings: [] }),
    parseScenarioFile: async () => ({ ok: true, value: fakeScenarioSpec(), warnings: [] }),
    scenariosDir: async (config: Config) => `${config.dir}/scenarios`,
    scenarioFile: async (config: Config, name: ScenarioName) =>
      `${config.dir}/scenarios/${name}.yaml`,
    listScenarios: async () => [...TEST_SCENARIOS].sort(),
    parseVariantFile: async () => ({ ok: true, value: fakeVariantSpec(), warnings: [] }),
    variantsDir: async (config: Config) => `${config.dir}/variants`,
    variantFile: async (config: Config, name: VariantName) => `${config.dir}/variants/${name}.yaml`,
    listVariants: async () => [...TEST_VARIANTS].sort(),
    openStore: async () => store,
    runFlow: async () => fakeRunResult(),
    computeDiff: async () => fakeDiffResult(),
    // The CI edge is the *real* renderer and the real bundle writer: both are pure functions of a
    // stored diff (CI spec D29), so a fake would only be a second implementation of the thing under
    // test. `exportBundle` writes to whatever directory the test names, which is a temp dir.
    renderComment: async (input) => renderComment(input),
    exportBundle: async (request) => exportBundle(request),
    serveReport: async (_config: Config, _options): Promise<ServeHandle> => ({
      info: fakeServeInfo(),
      close: async () => undefined,
    }),
    listAdapters: async () => fakeHarnesses(),
    adapterFiles: adapters.adapterFiles,
    adapterTargets: adapters.adapterTargets,
    installAdapter: adapters.installAdapter,
    readInstalledVersion: async (content: string) => fakeReadInstalledVersion(content),
    ...overrides,
  };
}
