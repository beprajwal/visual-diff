/**
 * visual-diff — shared contracts.
 *
 * Every module codes against this file. It is the JSON contract at each module edge (spec §5) and
 * the on-disk schema for the store (spec §6). Self-contained on purpose: no imports, so it can be
 * consumed by the CLI, the runner, the diff engine, the report server and the browser-side report
 * UI alike.
 */

/* ------------------------------------------------------------------ primitives */

/** Zero-padded, monotonically increasing run identifier, e.g. "0007". */
export type RunId = string;
/** Author-assigned stable step id. Load-bearing for D4 alignment (spec §4). */
export type StepId = string;
/** Viewport identifier in "WIDTHxHEIGHT" form, e.g. "1280x800". */
export type ViewportId = string;
/** "<base>..<head>", e.g. "0003..0007". */
export type PairId = string;
/** ISO-8601 UTC timestamp. */
export type IsoDate = string;
/** "sha256:<hex>". */
export type Sha256 = string;

export type JsonPrimitive = string | number | boolean | null;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/* ------------------------------------------------------------------ flow spec (§6, D8) */

/** Closed step vocabulary. Anything outside this list fails validation (spec §6, §10). */
export const STEP_VERBS = [
  'goto',
  'click',
  'fill',
  'press',
  'hover',
  'scroll',
  'waitFor',
  'viewport',
  'mask',
  'shoot',
  'expect',
] as const;
export type StepVerb = (typeof STEP_VERBS)[number];

/**
 * Explicitly rejected verbs. A fixed sleep is how a half-rendered frame gets captured, so the
 * validator refuses it by name rather than merely omitting it (spec §6).
 */
export const FORBIDDEN_STEP_VERBS = ['sleep', 'wait', 'waitForTimeout', 'pause', 'delay'] as const;
export type ForbiddenStepVerb = (typeof FORBIDDEN_STEP_VERBS)[number];

export interface ScrollAction {
  /** Scroll this element into view. */
  selector?: string;
  /** Absolute window scroll offsets. */
  x?: number;
  y?: number;
  to?: 'top' | 'bottom';
}

export interface Expectation {
  selector: string;
  visible?: boolean;
  hidden?: boolean;
  text?: string;
  count?: number;
}

export interface Step {
  id: StepId;
  goto?: string;
  click?: string;
  fill?: Record<string, string>;
  press?: string;
  hover?: string;
  scroll?: ScrollAction;
  /** Switch the viewport for this step onward within the current context. */
  viewport?: ViewportId;
  waitFor?: string;
  /** Selectors painted over before capture (clocks, order ids, relative timestamps). */
  mask?: string[];
  /** Whether this step produces a shot. Defaults to true. */
  shoot?: boolean;
  expect?: Expectation[];
}

export type NetworkMode = 'record' | 'replay' | 'off';

export interface FlowNetwork {
  mode: NetworkMode;
  /** HAR filename relative to .visual-diff/flows/. Required when mode is 'record' or 'replay'. */
  har?: string;
}

export interface FlowSpec {
  version: 1;
  flow: string;
  /** Overridable by config and CLI (spec §6). */
  baseUrl?: string;
  viewports: ViewportId[];
  network: FlowNetwork;
  steps: Step[];
}

/** The exact spec a run executed, persisted as flow.snapshot.yaml. */
export type FlowSnapshot = FlowSpec;

export interface Viewport {
  id: ViewportId;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ validation (§10) */

export interface SourceLocation {
  file: string;
  line?: number;
  column?: number;
  /** The offending key path, e.g. "steps[2].sleep". */
  key?: string;
}

export interface ValidationIssue {
  /** Stable machine code, e.g. "unknown-verb", "duplicate-id", "sleep-forbidden". */
  code: string;
  message: string;
  at: SourceLocation;
}

export type ValidationResult<T> =
  | { ok: true; value: T; warnings: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

/* ------------------------------------------------------------------ config (§6) */

export interface AppConfig {
  install?: string;
  dev: string;
  /** URL probed for readiness; $PORT is substituted. */
  readyOn: string;
  readyTimeoutMs: number;
}

export interface DiffConfig {
  minRegionArea: number;
  maxRegions: number;
  antialiasTolerance: number;
  /** Selectors whose rects are excluded from regions and findings. */
  ignore: string[];
}

export interface NetworkConfigFile {
  /** Header/field names scrubbed from recorded HARs, in addition to the always-dropped set. */
  redact: string[];
  /** Disabled only by an explicit --no-scrub (spec §6). */
  scrub: boolean;
}

export interface RetentionConfig {
  keepRuns: number;
}

export interface Config {
  /** Absolute path to the project root (the directory containing .visual-diff). */
  root: string;
  /** Absolute path to the .visual-diff directory. */
  dir: string;
  /** Default base URL when a flow does not set one. */
  baseUrl?: string;
  app: AppConfig;
  diff: DiffConfig;
  network: NetworkConfigFile;
  retention: RetentionConfig;
}

/* ------------------------------------------------------------------ runs (§6, §7) */

export type RunMode = 'attach' | 'spawn';
export type RunStatus = 'ok' | 'partial' | 'failed';

export interface Revision {
  sha: string;
  ref: string | null;
  dirty: boolean;
  /** sha256 of `git diff HEAD` plus the untracked file list. Distinguishes consecutive WIP runs. */
  dirtyHash?: Sha256;
}

export interface RunEnv {
  tool: string;
  node: string;
  playwright: string;
  chromium: string;
  os: string;
  deviceScaleFactor: number;
}

export type RunFailureKind =
  | 'install'
  | 'server-not-ready'
  | 'flow-missing'
  | 'flow-invalid'
  | 'browser-missing'
  | 'locked'
  | 'internal';

export interface RunFailure {
  kind: RunFailureKind;
  message: string;
  /** Retained log (install.log, server.log) relative to the run directory. */
  logPath?: string;
}

export type RunWarningKind =
  | 'har-miss'
  | 'har-recorded'
  | 'unstable-git'
  | 'dom-truncated'
  | 'step-blocked'
  | 'console-error'
  /** The pre-shoot settle gate hit its deadline: a screenshot was taken with requests outstanding. */
  | 'settle-timeout';

export interface RunWarning {
  kind: RunWarningKind;
  message: string;
  urls?: string[];
  steps?: StepId[];
}

/** meta.json */
export interface RunMeta {
  runId: RunId;
  flow: string;
  flowHash: Sha256;
  revision: Revision;
  mode: RunMode;
  network: NetworkMode;
  harHits: number;
  harMisses: number;
  viewports: ViewportId[];
  status: RunStatus;
  failedSteps: StepId[];
  env: RunEnv;
  startedAt: IsoDate;
  finishedAt: IsoDate;
  /** Git state moved between run start and end in attach mode (spec §7). */
  unstable: boolean;
  /** Exempt from retention pruning. */
  pinned: boolean;
  /** Blobs deleted by retention; meta.json and flow.snapshot.yaml survive. */
  pruned: boolean;
  warnings: RunWarning[];
  failure?: RunFailure;
}

export type StepStatus = 'ok' | 'failed' | 'blocked' | 'skipped';

export interface StepFailure {
  message: string;
  verb?: StepVerb;
  selector?: string;
  stack?: string;
  /** Failure screenshot, relative to the run directory. */
  screenshot?: string;
  /** Failure DOM snapshot, relative to the run directory. */
  dom?: string;
}

/** One captured artifact bundle for one step at one viewport (a "shot"). */
export interface ShotResult {
  viewport: ViewportId;
  /** Paths relative to the run directory. */
  screenshot: string;
  dom: string;
  a11y: string;
  width: number;
  height: number;
  nodeCount: number;
  truncated: boolean;
}

/** step.json */
export interface StepResult {
  id: StepId;
  index: number;
  status: StepStatus;
  shoot: boolean;
  startedAt: IsoDate;
  finishedAt: IsoDate;
  durationMs: number;
  /** The selector actually used after resolution, for the D4 drift signal. */
  resolvedSelector?: string;
  viewports: Record<ViewportId, ShotResult>;
  /** True when any viewport hit the DOM node cap. */
  truncated: boolean;
  consoleErrors: number;
  networkRequests: number;
  harMisses: number;
  /**
   * Present only when the pre-shoot settle gate lost its race in at least one viewport, i.e. the
   * screenshot for this step was taken with requests still outstanding and is not a deterministic
   * capture. Absent is the normal, settled case — the field is never written as a "0 outstanding"
   * record, so its presence alone is the signal.
   */
  unsettled?: { waitedMs: number; inFlight: number; urls: string[] };
  failure?: StepFailure;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

/** console.json entry */
export interface ConsoleEntry {
  step: StepId;
  viewport: ViewportId;
  level: ConsoleLevel;
  text: string;
  url?: string;
  line?: number;
  ts: IsoDate;
}

export type HarMatch = 'hit' | 'miss' | 'recorded' | 'bypassed';

/** network.json entry */
export interface NetworkEntry {
  step: StepId;
  viewport: ViewportId;
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  harMatch: HarMatch;
  durationMs: number | null;
  failure?: string;
}

/* ------------------------------------------------------------------ DOM capture (§7, §12) */

/**
 * The fixed subset of computed styles captured per node. Closed on purpose: snapshotting all
 * computed styles is enormous and almost none of it ever changes (spec §7).
 */
export const STYLE_PROPS = [
  'color',
  'backgroundColor',
  'backgroundImage',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textTransform',
  'textDecorationLine',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderColor',
  'borderStyle',
  'borderRadius',
  'boxShadow',
  'display',
  'position',
  'opacity',
  'zIndex',
  'margin',
  'padding',
  'visibility',
] as const;
export type StyleProp = (typeof STYLE_PROPS)[number];
export type StyleSubset = Record<StyleProp, string>;

/** The closed attribute subset retained per node, feeding the `attr` node-change kind (spec §8). */
export const CAPTURED_ATTRS = [
  'id',
  'class',
  'href',
  'src',
  'alt',
  'title',
  'type',
  'name',
  'value',
  'placeholder',
  'disabled',
  'checked',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-hidden',
  'aria-expanded',
  'aria-disabled',
  'data-test',
  'data-testid',
  'data-test-id',
] as const;
export type CapturedAttr = (typeof CAPTURED_ATTRS)[number];

export interface DomNode {
  /** Stable structural path, e.g. "html>body>div:nth-of-type(2)>button". */
  path: string;
  parent: string | null;
  depth: number;
  tag: string;
  /** Value of the first present data-test attribute, the strongest node-matching key. */
  testId?: string;
  role?: string;
  /** Accessible name. */
  name?: string;
  text?: string;
  rect: Rect;
  visible: boolean;
  styles: StyleSubset;
  attrs: Partial<Record<CapturedAttr, string>>;
}

/** dom.json */
export interface DomSnapshot {
  step: StepId;
  viewport: ViewportId;
  url: string;
  capturedAt: IsoDate;
  deviceScaleFactor: number;
  /** Full-page document size in CSS pixels. */
  document: Size;
  nodeCount: number;
  /** True when the 5,000-node cap was hit; attribution degrades to nearest retained ancestor. */
  truncated: boolean;
  /** Rects painted over by flow `mask`; excluded from regions and findings. */
  masks: Rect[];
  /** Visible nodes in document order. */
  nodes: DomNode[];
}

export interface A11yNode {
  role: string;
  name?: string;
  value?: string | number;
  description?: string;
  level?: number;
  children?: A11yNode[];
}

/** a11y.json */
export interface A11ySnapshot {
  step: StepId;
  viewport: ViewportId;
  root: A11yNode | null;
}

/* ------------------------------------------------------------------ diff engine (§8) */

/** Decoded RGBA image, 4 bytes per pixel. */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface PixelDiffResult {
  base: Size;
  head: Size;
  /** The area actually compared: the intersection when dimensions differ. */
  compared: Size;
  dimensionsChanged: boolean;
  changedPixels: number;
  /** changedPixels / (compared.w * compared.h). */
  changedRatio: number;
  /** One byte per compared pixel: 1 = changed. Row-major, width = compared.w. */
  mask: Uint8Array;
}

export interface Region {
  /** Stable within a (step, viewport) diff, e.g. "r1". */
  id: string;
  rect: Rect;
  area: number;
  changedPixels: number;
  /** changedPixels / area. */
  density: number;
}

export interface RegionSet {
  regions: Region[];
  /** Regions removed for falling below minRegionArea or landing inside a mask/ignore rect. */
  dropped: number;
  /** Regions folded into the single "N smaller changes" entry by the maxRegions cap. */
  collapsed: number;
  totalFound: number;
}

export type NodeChangeKind =
  | 'added'
  | 'removed'
  | 'moved'
  | 'resized'
  | 'text'
  | 'style'
  | 'attr';

export type NodeKeyKind = 'test-id' | 'role-name' | 'path';

export interface PropChange {
  prop: string;
  from: JsonPrimitive;
  to: JsonPrimitive;
}

export interface NodeChange {
  kind: NodeChangeKind;
  /** The stable matching key that paired these nodes. */
  key: string;
  keyKind: NodeKeyKind;
  base: DomNode | null;
  head: DomNode | null;
  changes: PropChange[];
}

export const FINDING_KINDS = [
  'content',
  'style',
  'layout',
  'structural',
  'a11y',
  'console',
  'network',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const SEVERITIES = ['high', 'med', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Sort order only. Severity never hides a finding (spec §8). */
export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, med: 1, low: 2 };

export interface FindingElement {
  selector: string;
  role?: string;
  name?: string;
  /** DomNode.path on the head side, or the base side for removals. */
  path?: string;
}

export interface Finding {
  /** "f1", "f2", ... unique within one DiffResult. */
  id: string;
  kind: FindingKind;
  severity: Severity;
  step: StepId;
  /** Absent for step-scoped findings (console, network). */
  viewport?: ViewportId;
  element?: FindingElement;
  region?: Rect;
  nodeChange?: NodeChangeKind;
  changes: PropChange[];
  /** Short structured label, e.g. "text changed". Prose summaries belong to the agent (spec §8). */
  label: string;
  /** Crop path relative to the .visual-diff directory. */
  crop?: string;
  /** Present on the single collapsed "N smaller changes" entry. */
  collapsed?: { count: number };
  /** Machine codes for the severity heuristics that fired, e.g. ["lost-accessible-name"]. */
  reasons: string[];
}

export const FLOW_DIFF_STATUSES = [
  'matched',
  'added',
  'removed',
  'spec-changed',
  'failed',
  'blocked',
] as const;
export type FlowDiffStatus = (typeof FLOW_DIFF_STATUSES)[number];

export interface FlowDiffEntry {
  id: StepId;
  status: FlowDiffStatus;
  /** e.g. "selector '#pay' -> '[data-test=pay]'". */
  detail?: string;
  baseIndex: number | null;
  headIndex: number | null;
}

export interface ViewportDiff {
  viewport: ViewportId;
  pixelChangedRatio: number;
  baseSize: Size | null;
  headSize: Size | null;
  dimensionsChanged: boolean;
  regions: Region[];
  findings: Finding[];
  /** Paths relative to the .visual-diff directory. */
  pixelPath?: string;
  regionsPath?: string;
  /** Set when one or both shots are absent (step added/removed/blocked, or run pruned). */
  missing?: 'base' | 'head' | 'both';
}

export interface StepDiff {
  id: StepId;
  status: FlowDiffStatus;
  detail?: string;
  viewports: Record<ViewportId, ViewportDiff>;
  /** Step-scoped findings with no viewport: console and network. */
  findings: Finding[];
}

export interface DiffSummary {
  totalFindings: number;
  bySeverity: Record<Severity, number>;
  byKind: Record<FindingKind, number>;
  stepsCompared: number;
  stepsChanged: number;
  stepsAdded: number;
  stepsRemoved: number;
  stepsSpecChanged: number;
  stepsFailed: number;
  stepsBlocked: number;
  maxPixelChangedRatio: number;
}

/** findings.json */
export interface DiffResult {
  engineVersion: string;
  flow: string;
  pair: { base: RunId; head: RunId };
  computedAt: IsoDate;
  baseMeta: RunMeta;
  headMeta: RunMeta;
  flowDiff: FlowDiffEntry[];
  steps: StepDiff[];
  summary: DiffSummary;
  warnings: string[];
}

export interface DiffEngineOptions {
  minRegionArea: number;
  maxRegions: number;
  antialiasTolerance: number;
  ignore: string[];
  engineVersion: string;
  /** Screenshot pixels per CSS pixel; converts DOM rects to image space. */
  deviceScaleFactor: number;
  /** Skip the cache and recompute. */
  force?: boolean;
}

/* ------------------------------------------------------------------ store (§6) */

/** A run directory loaded into memory for the diff engine. */
export interface LoadedShot {
  viewport: ViewportId;
  /** Absolute path; the engine decodes it lazily. */
  screenshotPath: string;
  dom: DomSnapshot;
  a11y: A11ySnapshot | null;
  size: Size;
}

export interface LoadedStep {
  result: StepResult;
  shots: Record<ViewportId, LoadedShot>;
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

export interface LoadedRun {
  runDir: string;
  meta: RunMeta;
  flow: FlowSnapshot;
  steps: LoadedStep[];
  stepsById: Record<StepId, LoadedStep>;
}

/** One row of the `vdiff runs` timeline. */
export interface RunSummary {
  runId: RunId;
  flow: string;
  revision: Revision;
  mode: RunMode;
  status: RunStatus;
  startedAt: IsoDate;
  finishedAt: IsoDate;
  viewports: ViewportId[];
  failedSteps: StepId[];
  unstable: boolean;
  pinned: boolean;
  pruned: boolean;
  /** Findings against the previous run; null when no diff is stored. */
  findingsCount: number | null;
}

export interface PairRef {
  flow: string;
  base: RunId;
  head: RunId;
}

/** .locks/<flow>.lock */
export interface LockInfo {
  flow: string;
  pid: number;
  host: string;
  startedAt: IsoDate;
}

/* ------------------------------------------------------------------ feedback (§9, D6) */

export type FeedbackStatus = 'pending' | 'acked';

/** One line of feedback/pending.jsonl */
export interface FeedbackEntry {
  id: string;
  ts: IsoDate;
  flow: string;
  pair: PairId;
  step?: StepId;
  viewport?: ViewportId;
  findingId?: string;
  /** Selector of the element the human pointed at. */
  element?: string;
  region?: Rect;
  /** Crop path relative to the .visual-diff directory. */
  crop?: string;
  text: string;
  status: FeedbackStatus;
  ackedAt?: IsoDate;
}

/** POST /api/feedback body. The server owns id, ts and status. */
export interface FeedbackInput {
  flow: string;
  pair: PairId;
  step?: StepId;
  viewport?: ViewportId;
  findingId?: string;
  element?: string;
  region?: Rect;
  text: string;
}

/* ------------------------------------------------------------------ report server (§9) */

/** serve.json */
export interface ServeInfo {
  url: string;
  host: string;
  port: number;
  /** Random per-session token; every route requires it. */
  token: string;
  pid: number;
  root: string;
  startedAt: IsoDate;
}

export interface HelloEvent {
  type: 'hello';
  ts: IsoDate;
  flows: string[];
}

export interface RunCompletedEvent {
  type: 'run';
  ts: IsoDate;
  flow: string;
  run: RunSummary;
}

export interface DiffReadyEvent {
  type: 'diff';
  ts: IsoDate;
  flow: string;
  pair: PairId;
  summary: DiffSummary;
}

export interface FeedbackAppendedEvent {
  type: 'feedback';
  ts: IsoDate;
  entry: FeedbackEntry;
}

export interface ServerErrorEvent {
  type: 'error';
  ts: IsoDate;
  message: string;
}

export type ServerEvent =
  | HelloEvent
  | RunCompletedEvent
  | DiffReadyEvent
  | FeedbackAppendedEvent
  | ServerErrorEvent;

export interface FlowsResponse {
  flows: Array<{ name: string; runs: number; latest: RunId | null }>;
}

export interface RunsResponse {
  flow: string;
  runs: RunSummary[];
}

/** Returned instead of an error when a pair references a pruned run (spec §10). */
export interface BackfillRequired {
  error: 'pruned';
  message: string;
  /** The exact commands to run, e.g. ["vdiff run checkout --at 9f8e7d6"]. */
  backfill: string[];
}

export type DiffResponse = DiffResult | BackfillRequired;

/* ------------------------------------------------------------------ CLI (§9) */

export const EXIT = {
  /** Success. `diff` uses this even when findings exist. */
  OK: 0,
  /** Run or replay failure. */
  RUN_FAILURE: 1,
  /** Config or spec error. */
  CONFIG_ERROR: 2,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface CliError {
  code: string;
  message: string;
  exitCode: ExitCode;
  issues?: ValidationIssue[];
  hint?: string;
}

/** The --json envelope. This shape is the agent-facing API across harnesses (spec §11.6). */
export interface CliEnvelope<T> {
  ok: boolean;
  command: string;
  version: string;
  data?: T;
  error?: CliError;
  warnings?: string[];
}

export interface RunOptions {
  flow: string;
  /**
   * Directory the project is located from — the CLI's working directory. Defaults to
   * `process.cwd()`. Explicit because the runner is a library function, not a process: a caller
   * that resolved the project once must be able to hand that answer on.
   */
  cwd?: string;
  /** Git ref for the slow path. Absent means HEAD or the dirty working tree. */
  at?: string;
  viewports?: ViewportId[];
  network?: NetworkMode;
  continueOnError?: boolean;
  baseUrl?: string;
  /** Write an unscrubbed HAR. Requires an explicit flag (spec §6). */
  noScrub?: boolean;
  json?: boolean;
}

export interface RunResult {
  runDir: string;
  meta: RunMeta;
  steps: StepResult[];
}

export interface DiffCommandOptions {
  flow: string;
  base?: RunId;
  head?: RunId;
  force?: boolean;
  json?: boolean;
}

export interface ServeOptions {
  port?: number;
  open?: boolean;
  flow?: string;
  json?: boolean;
}

export interface FeedbackOptions {
  flow?: string;
  ack?: boolean;
  json?: boolean;
}

/* ------------------------------------------------------------------ adapters (§5, §9) */

export type AdapterId = 'claude-code';

export interface AdapterInstallResult {
  id: AdapterId;
  written: string[];
  skipped: string[];
}

export interface Adapter {
  id: AdapterId;
  label: string;
  install(root: string): Promise<AdapterInstallResult>;
}

/* ------------------------------------------------------------------ defaults (§6, §12) */

/** Bumped whenever diff output could change; part of the diff cache key (spec §8). */
export const DIFF_ENGINE_VERSION = '1';

/**
 * Single source of truth for every default named in the spec. config/defaults.ts re-exports these
 * rather than restating them, so config and code cannot drift apart.
 */
export const DEFAULTS = {
  /** spec §7 */
  deviceScaleFactor: 2,
  /** spec §12 */
  maxDomNodes: 5000,
  /** spec §6 */
  viewports: ['1280x800', '390x844'] as ViewportId[],
  readyTimeoutMs: 90_000,
  diff: {
    minRegionArea: 64,
    maxRegions: 40,
    antialiasTolerance: 0.1,
    ignore: [] as string[],
  },
  retention: { keepRuns: 20 },
  network: { redact: [] as string[], scrub: true },
  /** Always dropped on HAR record regardless of config (spec §6). */
  alwaysRedactHeaders: ['authorization', 'cookie', 'set-cookie'] as string[],
  /** Concurrent viewport replays (spec §7). */
  viewportConcurrency: 2,
  /** Server log lines retained on a readiness failure (spec §10). */
  serverLogTailLines: 50,
} as const;
