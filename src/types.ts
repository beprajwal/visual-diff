/**
 * visual-diff — shared contracts.
 *
 * Every module codes against this file. It is the JSON contract at each module edge (spec §5) and
 * the on-disk schema for the store (spec §6). Self-contained on purpose: no imports, so it can be
 * consumed by the CLI, the runner, the diff engine, the report server and the browser-side report
 * UI alike.
 *
 * Bare section references (§6, D4) are to `2026-08-08-visual-diff-design.md`. References marked
 * "mocking spec" are to `2026-08-10-api-mocking-design.md`, which adds scenarios (D10–D14).
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

/**
 * An arbitrary JSON document. The scenario layer carries recorded and synthetic response bodies
 * around as data, so it needs a name for "any JSON" (mocking spec §5).
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

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

/**
 * `mock` is a first-class mode alongside the slice-1 three, not an implicit fallback: it runs with
 * no HAR at all and aborts every unmatched request (mocking spec D13). It is structurally recorded
 * in meta.json and badged in the report, because fidelity under it is only as good as the scenario.
 */
export const NETWORK_MODES = ['record', 'replay', 'off', 'mock'] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

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

/* ------------------------------------------------- scenarios (mocking spec §5, §11, D10–D13) */

/**
 * RFC 7386 JSON merge patch, the default patch format because it reads naturally in YAML (mocking
 * spec §5). `null` at a key deletes that key, an object merges recursively, and any other value
 * replaces its target wholesale. Implemented in-repo, never as a dependency (mocking spec §11).
 */
export type MergePatch = JsonValue;

/** The six RFC 6902 operations (mocking spec §5, §11). */
export const JSON_PATCH_OPS = ['add', 'remove', 'replace', 'move', 'copy', 'test'] as const;
export type JsonPatchOp = (typeof JSON_PATCH_OPS)[number];

/**
 * One RFC 6902 operation, split by `op` so `value` and `from` are required exactly where the RFC
 * requires them and rejected where it does not — which is what "malformed RFC 6902 op" means in the
 * validation list (mocking spec §8). Used for the array indices and removals merge patch cannot
 * express (mocking spec §5).
 */
export type JsonPatchOperation =
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: JsonValue }
  | { op: 'move'; path: string; from: string }
  | { op: 'copy'; path: string; from: string }
  | { op: 'test'; path: string; value: JsonValue };

export type JsonPatch = JsonPatchOperation[];

/**
 * `overlay` patches a recording and passes unmatched requests through to it; `mock` involves no
 * recording at all and aborts unmatched requests as misses (mocking spec §5, D13).
 */
export const SCENARIO_MODES = ['overlay', 'mock'] as const;
export type ScenarioMode = (typeof SCENARIO_MODES)[number];

/** Scenario name, matching the filename stem of `.visual-diff/scenarios/<name>.yaml`. */
export type ScenarioName = string;

/**
 * The scenario recorded for a run that had none (mocking spec §6). Reserved: no scenario file may
 * take this name (mocking spec §11), so `meta.scenario === SCENARIO_NONE` is unambiguous and
 * slice-1 runs stay readable.
 */
export const SCENARIO_NONE = 'none';

/**
 * Request matcher. `method` is optional and defaults to any; `url` is a required glob applied to
 * the full URL including query string (mocking spec §5, §11).
 */
export interface RuleMatch {
  method?: string;
  url: string;
  /**
   * 1-based selector of the nth occurrence of an otherwise identical request, counted per
   * `(method, url)` within a run (mocking spec §5, §11). Below 1 is a validation error (§8).
   */
  nth?: number;
}

/** A binary `respond.body`, distinguished from a JSON body by the `base64` key (mocking spec §5). */
export interface Base64Body {
  base64: string;
}

/**
 * `respond.body` accepts an object (serialized as JSON), a string, or `{ base64: … }` for binary
 * (mocking spec §5). Narrow with `'base64' in body` before treating it as JSON.
 */
export type ResponseBody = JsonValue | Base64Body;

/** The `respond` verb: a wholly synthetic response (mocking spec §5). */
export interface RespondSpec {
  /** Outside 100–599 is a validation error (mocking spec §8). */
  status: number;
  headers?: Record<string, string>;
  body?: ResponseBody;
}

/** The four response verbs. Exactly one per rule; two is a validation error (mocking spec §5, §8). */
export const RESPONSE_VERBS = ['patch', 'patchOps', 'respond', 'abort'] as const;
export type ResponseVerb = (typeof RESPONSE_VERBS)[number];

/** What every rule carries, whichever verb it is built around (mocking spec §5). */
export interface ScenarioRuleBase {
  /**
   * Stable and required. It is what lets two versions of a scenario be compared structurally and
   * gives the report something to name; renaming it severs that rule's history (mocking spec §5).
   */
  id: string;
  match: RuleMatch;
  /**
   * Milliseconds. A modifier rather than a verb: it composes with any of them and is legal on its
   * own, passing the recorded response through late. Negative is a validation error (§5, §8).
   */
  delay?: number;
}

/**
 * One rule: a match plus at most one response verb (mocking spec §5). The `?: never` slots make
 * "exactly one verb per rule" a type error rather than an invented precedence order — a rule
 * carrying both `patch` and `respond` matches no branch of this union. The final branch is the
 * delay-only rule, which is why `delay` is required there and optional in the base.
 *
 * `patch` and `patchOps` are additionally rejected in `mock` mode, at validation time rather than
 * run time, since a merge patch against a nonexistent recorded body looks like it worked (§5).
 */
export type ScenarioRule = ScenarioRuleBase &
  (
    | { patch: MergePatch; patchOps?: never; respond?: never; abort?: never }
    | { patchOps: JsonPatch; patch?: never; respond?: never; abort?: never }
    | { respond: RespondSpec; patch?: never; patchOps?: never; abort?: never }
    | { abort: true; patch?: never; patchOps?: never; respond?: never }
    | { delay: number; patch?: never; patchOps?: never; respond?: never; abort?: never }
  );

/** `.visual-diff/scenarios/<name>.yaml`, committed and read from git history at the target SHA. */
export interface ScenarioSpec {
  version: 1;
  /** Must agree with the filename stem; disagreement is a validation error (mocking spec §8). */
  scenario: ScenarioName;
  description?: string;
  /** Defaults to `overlay` when the file omits it (mocking spec §5). */
  mode: ScenarioMode;
  /** Evaluated per request; first match wins in file order (mocking spec §5, §11). */
  rules: ScenarioRule[];
}

/** One row of `vdiff scenario list` (mocking spec §7). */
export interface ScenarioSummary {
  name: ScenarioName;
  mode: ScenarioMode;
  description?: string;
  ruleCount: number;
  /** Path relative to the .visual-diff directory. */
  path: string;
}

/**
 * What the scenario layer did with one request (mocking spec §8). `passthrough` is a request no
 * rule matched, served from the recording (§3); `miss` is its `mock`-mode counterpart, aborted
 * because there is no recording to fall back to (§8); `delay` is a rule that matched carrying only
 * the modifier, so the recorded response went through unchanged but late.
 */
export const SCENARIO_ACTIONS = [
  'passthrough',
  'patch',
  'patchOps',
  'respond',
  'abort',
  'delay',
  'miss',
] as const;
export type ScenarioAction = (typeof SCENARIO_ACTIONS)[number];

/**
 * Per-request attribution, written into network.json so the report can say "response modified by
 * `empty-forecast` rule `forecast-empty`" without runtime instrumentation (mocking spec §8, D11).
 */
export interface ScenarioAttribution {
  /** The scenario in force for the run, or `SCENARIO_NONE`. */
  scenario: ScenarioName;
  /** The rule that matched, or null when none did. */
  ruleId: string | null;
  action: ScenarioAction;
  /** True when the body the page received differs from the recorded one. */
  bodyChanged: boolean;
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
  /**
   * Runs kept per `(flow, scenario)`, not per flow (mocking spec §6). Per-flow pruning would let a
   * frequently-run scenario evict the history of a rarely-run one, which is backwards: the
   * rarely-run scenario is the one whose history cannot be reconstructed from memory.
   */
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
  | 'internal'
  /** Named scenario absent, including at the target SHA — rejected as a missing flow is (§8, D4). */
  | 'scenario-missing'
  /** Scenario failed validation: unknown key, two verbs on a rule, `patch` in mock mode … (§8). */
  | 'scenario-invalid'
  /**
   * A rule could not be applied at run time and the run fails naming it: it matched a request with
   * no recorded response, or patched a non-JSON body (mocking spec §8).
   */
  | 'scenario-failed';

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
  | 'settle-timeout'
  /**
   * A scenario rule matched nothing for the whole run, so the user may believe they are looking at
   * a patched state while actually seeing the recording. The single most important warning in the
   * mocking spec (§8): it lists the offending rule ids in `rules`.
   */
  | 'scenario-rule-unmatched'
  /** `mock` mode: a request no rule matched was aborted, with no recording to fall back to (§8). */
  | 'mock-miss';

export interface RunWarning {
  kind: RunWarningKind;
  message: string;
  urls?: string[];
  steps?: StepId[];
  /** Scenario rule ids this warning is about, e.g. the rules that never matched (mocking §8). */
  rules?: string[];
}

/** meta.json */
export interface RunMeta {
  runId: RunId;
  flow: string;
  /**
   * The third axis of run identity, `(flow, revision, scenario)` — recorded here rather than in the
   * run path, so run ids stay monotonic per flow and scenario names never become path components
   * (mocking spec §6, D12). `SCENARIO_NONE` for a run captured without one. Required here and
   * defaulted to `SCENARIO_NONE` by the store when the field is absent on disk, so slice-1
   * meta.json stays readable while in-memory code never has to handle "unknown" (mocking spec §6).
   */
  scenario: ScenarioName;
  flowHash: Sha256;
  revision: Revision;
  mode: RunMode;
  network: NetworkMode;
  harHits: number;
  harMisses: number;
  /**
   * Requests a scenario rule answered outright — `respond` or `abort` (mocking spec §8). These are
   * deliberately *not* `harHits`: they never consulted the recording, and counting them there
   * would report a replay's HAR coverage as higher than it is.
   *
   * It exists because in `mock` mode `harHits` is necessarily 0, so "har 0 hit" would be a true
   * sentence that reads as a total failure of a run that in fact served every request from its
   * scenario. Optional, so a slice-1 `meta.json` that predates the field is unchanged and reads
   * back as 0.
   */
  scenarioServed?: number;
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
  /**
   * What the scenario layer did with this request (mocking spec §8). Written for every request of a
   * scenario run; absent on runs with no scenario, so a slice-1 network.json is unchanged and an
   * absent value reads as "no scenario was in force", not as "unknown".
   */
  attribution?: ScenarioAttribution;
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

/**
 * Machine codes for the two pairings the tool permits but refuses to let pass as ordinary
 * regressions (mocking spec §6). They appear in findings.json, CLI output and the report; a
 * same-scenario pair carries neither.
 */
export const PAIR_LABELS = ['cross-scenario', 'mock-vs-recorded'] as const;
export type PairLabel = (typeof PAIR_LABELS)[number];

/**
 * How the two paired runs relate on the scenario axis (mocking spec §6). Diffs pair same-scenario
 * runs by default, because "did the empty state break between these revisions?" needs like-for-like
 * pairs (D12); the flags below are how the other two pairings state what the tool does not know.
 */
export interface PairScenarios {
  /** The scenario each side ran, `SCENARIO_NONE` when it ran none. */
  base: ScenarioName;
  head: ScenarioName;
  /**
   * Different scenarios: a legitimate question — it compares two states rather than two revisions —
   * so it is permitted and labelled `cross-scenario` rather than refused (mocking spec §6).
   */
  crossScenario: boolean;
  /**
   * Exactly one side is a mock-only run: a fiction compared against a measurement. Labelled
   * `mock-vs-recorded` at high severity, with both runs badged (mocking spec §6).
   */
  mockVsRecorded: boolean;
}

/** findings.json */
export interface DiffResult {
  engineVersion: string;
  flow: string;
  pair: { base: RunId; head: RunId };
  computedAt: IsoDate;
  baseMeta: RunMeta;
  headMeta: RunMeta;
  /**
   * Scenario labelling for this pair (mocking spec §6). Absent on diffs stored before this slice,
   * which are same-scenario by construction; present and all-false for a same-scenario pair.
   */
  scenarios?: PairScenarios;
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
  /** The scenario column of the timeline, and what `--scenario` filters on (mocking spec §7). */
  scenario: ScenarioName;
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
  /**
   * Capture under this scenario (mocking spec §7). Absent means `SCENARIO_NONE`. Combining it with
   * `network: 'record'` is a hard error: recording captures reality and a scenario alters it, so a
   * HAR blending both is neither (mocking spec §2).
   */
  scenario?: ScenarioName;
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
  /** Restrict run selection to runs captured under this scenario (mocking spec §7). */
  scenario?: ScenarioName;
  force?: boolean;
  json?: boolean;
}

/**
 * `vdiff scenario new <name>` (mocking spec §7). `cwd` carries the same meaning it does on
 * RunOptions: the directory the project is located from.
 */
export interface ScenarioNewOptions {
  name: ScenarioName;
  cwd?: string;
  json?: boolean;
}

/** `--json` data for `vdiff scenario new` (mocking spec §7). */
export interface ScenarioNewResult {
  scenario: ScenarioName;
  /** Path of the written file, relative to the .visual-diff directory. */
  path: string;
  mode: ScenarioMode;
}

/** `vdiff scenario check <name>` — validate without running (mocking spec §7). */
export interface ScenarioCheckOptions {
  name: ScenarioName;
  cwd?: string;
  json?: boolean;
}

/**
 * `--json` data for `vdiff scenario check` (mocking spec §7). A failed check is a `CliError` at exit
 * 2 carrying its issues (mocking spec §8), so this shape describes a scenario that passed: the
 * warnings are what a valid scenario still has to say about itself.
 */
export interface ScenarioCheckResult {
  scenario: ScenarioSummary;
  warnings: ValidationIssue[];
}

/** `vdiff scenario list` — enumerate scenarios and their modes (mocking spec §7). */
export interface ScenarioListOptions {
  cwd?: string;
  json?: boolean;
}

/** `--json` data for `vdiff scenario list` (mocking spec §7). */
export interface ScenarioListResult {
  scenarios: ScenarioSummary[];
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

/**
 * Every harness this build can install into (harness-packaging spec §4).
 *
 * The registry in `src/adapters/harnesses.ts` derives its own `HarnessId` from the table rows, and
 * a test pins the two unions to each other — this declaration is the published one, so leaving it
 * naming a single harness while four are installable would make the package's own types lie about
 * what `vdiff install` accepts.
 */
export type AdapterId = 'claude-code' | 'codex' | 'opencode' | 'pi';

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
  /** mocking spec §5 — a scenario file that omits `mode:` is an overlay. */
  scenarioMode: 'overlay' as ScenarioMode,
  /** mocking spec §6, §11 — what a run captured without a scenario records. */
  scenarioNone: SCENARIO_NONE,
  /** Always dropped on HAR record regardless of config (spec §6). */
  alwaysRedactHeaders: ['authorization', 'cookie', 'set-cookie'] as string[],
  /** Concurrent viewport replays (spec §7). */
  viewportConcurrency: 2,
  /** Server log lines retained on a readiness failure (spec §10). */
  serverLogTailLines: 50,
} as const;
