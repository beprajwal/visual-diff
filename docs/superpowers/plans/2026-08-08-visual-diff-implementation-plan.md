# Visual Diff — Implementation Plan (Slice 1)

Date: 2026-08-08
Spec: `docs/superpowers/specs/2026-08-08-visual-diff-design.md` (the authority; this plan adds no behavior it does not describe)
Status: Ready to build

---

## 0. Ground rules for every build agent

- One npm package `visual-diff`, one binary `vdiff`. TypeScript, Node 20+, ESM, vitest. (§12)
- `src/types.ts` is the single shared contract file. **Nobody edits it.** Import types from it; if a
  contract must change, report it upward instead of editing.
- The on-disk store *is* the inter-module interface (§5). A module never reaches into another
  module's internals — it reads and writes the paths that `store/paths.ts` constructs.
- Every module exposes a JSON contract at its edge, so package extraction later is mechanical (§5).
- Pure logic (flow parse/validate, structural diff, region clustering, DOM attribution, node
  matching, severity) is written test-first (§11.4).
- No stubs, no `throw new Error("not implemented")`, no leftover TODOs.

### Dependencies this plan assumes (planner does not edit `package.json`)

Runtime: `playwright`, `pixelmatch`, `pngjs`, `preact`, `yaml`, `zod`.
Dev: `typescript`, `vitest`, `@types/node`, `@types/pngjs`, **`esbuild`**.

`esbuild` is the one addition beyond the stack named in the brief and it is forced by §9/§12: the
report UI must ship as a **prebuilt single self-contained asset** with no build at install and no
external requests, so the Preact UI has to be bundled at package-build time by
`scripts/build-ui.mjs`. If `esbuild` cannot be added, the fallback is to hand-write the report UI as
a single pre-authored `.js` file with no JSX and no imports — significantly worse, and it should be
escalated rather than silently chosen.

Note: `pixelmatch` ships its own types; `pngjs` needs `@types/pngjs`.

---

## 1. File tree of `src/`

Test files are colocated (`*.test.ts`) per the brief; cross-module tests live in `tests/`.

```
src/
  types.ts                              ALL shared contracts + frozen DEFAULTS. Written once by scaffold, never edited.
  version.ts                            Reads package version; exports TOOL_VERSION and re-exports DIFF_ENGINE_VERSION.
  index.ts                              Programmatic entry: re-exports runFlow, computeDiff, serveReport, store readers, types.

  util/
    errors.ts                           VdiffError class carrying CliError (code, message, exitCode 0|1|2, hint, issues). §10
    errors.test.ts                      Exit-code mapping per §10 table row → exitCode.
    fs.ts                               mkdirp, readJson, writeJson, exists, rmrf, copyDir, tail(file, n) for server logs.
    atomic.ts                           writeFileAtomic + writeDirAtomic (temp path then rename) — crash-mid-run guard. §10
    atomic.test.ts                      Asserts temp dir never visible under final name; rename is the only publish step.
    json.ts                             Stable-key JSON.stringify for snapshot-stable findings.json / meta.json.
    hash.ts                             sha256 helpers: hashString, hashFile, hashJsonStable → "sha256:..." strings.
    duration.ts                         "90s"/"2m"/"1500ms" → ms; ms → human. Used by config readyTimeout.
    duration.test.ts                    Parse table incl. rejection of unitless and negative values.
    id.ts                               Zero-padded run ids ("0007"), nextRunId(existing[]), pairId(base,head), findingId(n).
    id.test.ts                          Monotonic ids, gap tolerance, 4-digit padding, pair id round-trip.
    logger.ts                           Level-filtered stderr logger; silent when --json so stdout stays pure JSON.
    port.ts                             Ephemeral free-port allocation (bind :0, read, release) for spawn mode and serve.
    selector.ts                         Selector→node matching helpers shared by diff/ignore and flow mask handling.
    selector.test.ts                    data-test / attribute / tag / class selector matching against DomNode fixtures.

  config/
    defaults.ts                         Re-exports DEFAULTS from types.ts and builds a fully-defaulted Config skeleton.
    schema.ts                           zod schema for .visual-diff/config.yaml (app/diff/network/retention/baseUrl).
    load.ts                             Locate project root + .visual-diff, parse YAML with line info, apply defaults → Config.
    load.test.ts                        Defaults filled, unknown keys rejected with file+line+key (§10 row 1), readyTimeout parsed.

  flow/
    schema.ts                           zod schema for flow YAML v1; closed verb list; rejects sleep and unknown verbs. §6/§8
    parse.ts                            YAML→AST with line/column retained, then schema → ValidationResult<FlowSpec>.
    parse.test.ts                       Line-accurate errors, duplicate id, missing id, unknown verb, sleep, bad viewport.
    validate.ts                         Post-schema semantic checks: id uniqueness/shape, viewport format, har required in replay.
    validate.test.ts                    Each §10 row-1 failure mode produces one issue with the offending key.
    serialize.ts                        FlowSpec → canonical YAML for flow.snapshot.yaml and for `vdiff flow new` scaffolds.
    serialize.test.ts                   parse(serialize(spec)) === spec round-trip; snapshot is byte-stable.
    hash.ts                             flowHash = sha256 of canonical serialization (order-independent of comments/whitespace).
    hash.test.ts                        Comment/whitespace changes do not move the hash; a selector change does.
    structural-diff.ts                  Stage 1: align two FlowSpecs by step id → FlowDiffEntry[] (matched/added/removed/spec-changed).
    structural-diff.test.ts             Insertion, deletion, reorder, selector rename → spec-changed with detail string. §8 stage 1
    index.ts                            Module edge: parseFlowFile, parseFlowSource, diffFlows, hashFlow, serializeFlow.

  store/
    paths.ts                            Every path in the §6 tree, constructed in one place. No other file joins store paths.
    paths.test.ts                       Step dirs keyed by id not ordinal; pair dir "0003..0007"; viewport dir naming.
    lock.ts                             .locks/<flow>.lock with pid+host+startedAt; stale-PID detection and takeover. §10
    lock.test.ts                        Second acquire fails; lock with dead pid is reclaimed; release removes file.
    run-store.ts                        Create run in temp dir, write meta/flow.snapshot/steps, atomic rename; list/read runs.
    run-store.test.ts                   Partial run invisible until rename; nextRunId; meta round-trip; run listing order.
    run-load.ts                         Load a run dir into LoadedRun (meta, flow, StepResults, DomSnapshots, console, network).
    run-load.test.ts                    Loads a committed fixture run dir; missing shot → shot absent, not a throw.
    diff-store.ts                       findings.json + crops cache keyed by (base, head, engineVersion); read/write/invalidate.
    diff-store.test.ts                  Cache hit on identical key, miss on engineVersion bump, crops path stability.
    feedback-store.ts                   Append pending.jsonl, read pending, ack → move to archive/<date>.jsonl.
    feedback-store.test.ts              Append is line-atomic; ack archives exactly what was read and leaves the rest pending.
    retention.ts                        keepRuns pruning: delete blobs, keep meta.json + flow.snapshot.yaml; pin; diff-referenced runs never pruned. §6
    retention.test.ts                   Pinned exempt, diff-referenced exempt, pruned run keeps meta and is marked pruned.
    index.ts                            Module edge: openStore(config) → Store facade used by runner, diff, report, cli.

  runner/
    git.ts                              Read-only git: sha, ref, dirty, dirtyHash (diff HEAD + untracked list), show file at sha. §6/§7
    git.test.ts                         dirtyHash changes with content and with untracked files; never invokes a mutating command.
    worktree.ts                         git worktree add --detach into cache/worktrees/<sha>; reap orphans at startup; never touch user tree. §10
    deps.ts                             lockfile hash → cache/deps/<hash>; symlink node_modules; install on miss; retain install.log. §7
    serve-app.ts                        Attach probe of readyOn, else spawn config.app.dev on an allocated port; poll ready; keep last 50 log lines. §7/§10
    determinism.ts                      Init script source (TZ/locale/frozen clock/seeded Math.random), CSS kill-switch, scrollbar disable. §7
    determinism.test.ts                 Init script is a single string, runs before app code, seeds are fixed and reproducible.
    browser.ts                          Chromium launch, per-viewport context factory (deviceScaleFactor 2, reduced motion), missing-browser message. §10
    settle.ts                           Pre-shoot gate: document.fonts.ready + two idle rAFs + zero in-flight HAR requests. Never a timer. §7
    viewport.ts                         "1280x800" ⇄ Viewport; viewport worker pool with concurrency cap. §7
    viewport.test.ts                    Parse/format round-trip, invalid strings rejected, pool respects cap and isolates failures.
    har.ts                              recordHar on first run; routeFromHAR with notFound:'abort'; scrubbing; hit/miss accounting. §6/§7
    har.test.ts                         Authorization/Cookie/Set-Cookie and network.redact headers dropped unless --no-scrub.
    dom-extract.ts                      In-page serializer string: visible nodes, stable path, role, acc name, rect, STYLE_PROPS, CAPTURED_ATTRS, 5000 cap. §7/§12
    dom-extract.test.ts                 Pure helpers (path building, cap truncation, style picking) tested without a browser.
    capture.ts                          Per step per viewport: screenshot, dom.json, a11y.json; step console.json/network.json windows. §7
    driver.ts                           Execute the closed step vocabulary; failure → record error+DOM+shot, downstream blocked, --continue-on-error re-anchor at next goto. §7
    driver.test.ts                      Blocked propagation and re-anchor logic tested as a pure state machine over step lists.
    run.ts                              Orchestrator: lock → resolve revision → attach|spawn → replay viewports → RunMeta → atomic append. §7
    index.ts                            Module edge: runFlow(options) → RunResult.

  diff/
    image.ts                            pngjs decode/encode ⇄ PixelImage (RGBA Uint8Array).
    pixel.ts                            Stage 2: pixelmatch with antialias tolerance; dimension mismatch is its own finding, then compare common area. §8
    pixel.test.ts                       Identical images → 0; dimension change → dimensionsChanged + common-area ratio, not 1.0.
    regions.ts                          Stage 3: connected components over the mask, proximity merge, minRegionArea drop, maxRegions cap + collapsed remainder. §8
    regions.test.ts                     Hand-built masks: two blobs stay two, near blobs merge, tiny dropped, >max collapses to one entry.
    ignore.ts                           Excludes flow mask rects and config.diff.ignore selector rects from regions and findings. §8
    ignore.test.ts                      A change entirely inside a mask or ignored selector yields zero findings.
    attribute.ts                        Stage 4: hit-test region against both DomSnapshots; smallest fully-containing node, preferring changed rects; degrades to nearest retained ancestor when truncated. §8/§12
    attribute.test.ts                   Nested-node fixtures pick the button not the body; truncated snapshot falls back to ancestor.
    node-diff.ts                        Stage 5: match by test-id → role+name → path; classify added/removed/moved/resized/text/style/attr. §8
    node-diff.test.ts                   Each classification, plus stable matching under reordering and under a renamed path.
    severity.ts                         Heuristics: lost accessible name / new console error / contrast < 4.5 / layout shift past threshold = high; 1px radius = low. Orders only, never hides. §8
    severity.test.ts                    Each named heuristic; asserts nothing is ever filtered out by severity.
    contrast.ts                         WCAG relative-luminance contrast ratio from computed color/backgroundColor.
    contrast.test.ts                    Known WCAG pairs (black/white 21:1, the 4.5 boundary cases).
    console-network.ts                  Step-scoped findings: new console errors, HAR misses, new/failed requests. §8 kinds console|network
    console-network.test.ts             Only *new* errors on head produce findings; resolved errors do not.
    a11y-diff.ts                        Compares a11y.json trees: lost/changed accessible name and role → kind a11y. §8
    a11y-diff.test.ts                   Name loss is high severity; pure role reorder is not a finding.
    crops.ts                            Writes crops/f<n>.png from the head screenshot for each finding region. §6/§9
    findings.ts                         Merges region + node changes + step-scoped signals into Finding[]; assigns f<n> ids and labels. §8
    findings.test.ts                    Region+node merge shape matches the §8 example JSON exactly.
    summary.ts                          DiffSummary aggregation (counts by severity/kind, step buckets, max pixel ratio).
    engine.ts                           Pure top level: two run dirs + DiffEngineOptions → DiffResult. No network, no browser. Cache-aware. §8
    engine.test.ts                      Golden pairs under tests/fixtures/runs → snapshot findings.json (§11.3 driver).
    index.ts                            Module edge: computeDiff(baseDir, headDir, options) → DiffResult.

  report/
    server.ts                           http.createServer bound to 127.0.0.1 on an ephemeral port; token gate; writes serve.json. §9
    routes.ts                           Route table: /api/flows, /api/runs/:flow, /api/diff/:base..:head, /api/events, /api/feedback, blobs, static UI.
    api.ts                              Handlers for flows/runs/diff, incl. pruned-run response carrying the exact backfill command. §9/§10
    api.test.ts                         Contract snapshots for each endpoint; pruned pair returns backfill, not 500.
    blobs.ts                            Serves screenshots/pixel/crops from the store; path-traversal guard; correct content types.
    blobs.test.ts                       "../" and absolute paths rejected; only paths inside .visual-diff are served.
    auth.ts                             Session-token check (query param on first load, cookie after) for every route. §9
    auth.test.ts                        Missing/wrong token → 401 on API, SSE and blobs alike.
    sse.ts                              SSE hub: client registry, heartbeat, typed ServerEvent serialization.
    sse.test.ts                         Event framing, multi-client fanout, disconnect cleanup.
    watcher.ts                          Watches runs/ for a completed run, recomputes the diff to completion, *then* emits the event. §9
    watcher.test.ts                     Event only fires after findings.json exists — never a half-computed pair.
    feedback-api.ts                     Validates POST /api/feedback and appends to pending.jsonl. Executes nothing else. §9/D6
    feedback-api.test.ts                Valid entry appended with id/ts/status; malformed rejected; no process/git/build path exists.
    assets.ts                           Resolves the prebuilt UI bundle shipped in the package; no CDN, no install-time build. §9
    index.ts                            Module edge: serveReport(options) → ServeInfo + close().
    ui/
      main.tsx                          Preact mount, hash routing (flow/pair/step/viewport), keyboard map j k [ ] o f. §9
      state.ts                          App state: selected pair/step/viewport, follow-live vs pinned pair, findings-only filter.
      state.test.ts                     Follow-live advances on run event; pinned pair shows the badge instead of jumping. §9
      client.ts                         fetch wrappers over the API + EventSource subscription with reconnect.
      keys.ts                           Keyboard map as a pure table (key → action) so it is testable without a DOM.
      keys.test.ts                      j/k step nav, [/] iteration nav, o overlay, f findings-only; no double binding.
      components/Header.tsx             Flow selector, base/head pickers with SHA + ref + dirty badge + timestamp, live indicator.
      components/Filmstrip.tsx          Step thumbnails with change-count badges: red failed, green + added, dashed removed, gray = identical.
      components/FocusPane.tsx          Side-by-side default; hosts overlay/swipe view modes and the region layer.
      components/OverlayView.tsx        Onion-skin with opacity slider.
      components/SwipeView.tsx          Draggable divider.
      components/RegionLayer.tsx        Region boxes over the head image; click selects the finding.
      components/RightRail.tsx          Findings for the selected step grouped by severity, expandable to property-level changes.
      components/FindingItem.tsx        One finding row: kind, severity, element, change list.
      components/ViewportTabs.tsx       Viewport tab bar.
      components/FeedbackBox.tsx        Comment box on a region/finding → POST /api/feedback.
      components/Warnings.tsx           Run-level warnings: HAR misses, unstable git, DOM truncated, blocked steps.
      styles.css                        Report stylesheet, inlined into the single bundle.

  adapters/
    index.ts                            Adapter registry. Slice 1 registers exactly one; the seam exists so later harnesses drop in. §5
    claude-code.ts                      Writes the visual-diff skill plus /vdiff and /vdiff-review command files that shell out to the CLI. §9
    claude-code.test.ts                 Writes expected paths, is idempotent, never overwrites user edits without reporting them.
    templates/skill.md                  The loop: ensure a flow exists → vdiff run → vdiff diff --json → summarize → hand over report URL.
    templates/vdiff.md                  /vdiff slash command.
    templates/vdiff-review.md           /vdiff-review slash command (serve + read feedback --json --ack).

  cli/
    main.ts                             bin entry: parse argv, dispatch, map VdiffError → exit code 0|1|2, flush --json envelope. §9
    args.ts                             Dependency-free argv parser: command, positionals, flags, --json everywhere.
    args.test.ts                        Flag/positional parsing for every §9 command line, unknown flag → exit 2.
    output.ts                           CliEnvelope<T> writer for --json and the human renderer for tty. §9
    output.test.ts                      --json writes exactly one JSON object to stdout and nothing else.
    commands/init.ts                    Scaffold .visual-diff/config.yaml, gitignore rules, example flow. §6/§9
    commands/flow.ts                    `vdiff flow new|check <name>` — scaffold or validate without running. §9
    commands/run.ts                     `vdiff run <flow> [--at] [--viewport] [--record|--no-net] [--continue-on-error]`. §9
    commands/runs.ts                    `vdiff runs <flow>` timeline: SHA, dirty, status, findings count. §9
    commands/diff.ts                    `vdiff diff <flow> [base] [head]`, defaults N-1 vs N, exits 0 even with findings. §9
    commands/serve.ts                   `vdiff serve [--open] [--port]`. §9
    commands/feedback.ts                `vdiff feedback [--json] [--ack]`. §9
    commands/pin.ts                     `vdiff pin|prune <run>`. §6/§9
    commands/install-browser.ts         `vdiff install-browser` — playwright chromium install. §10
```

### Non-`src` files this plan implies

```
scripts/build-ui.mjs                    esbuild bundle of src/report/ui → dist/ui/report.js (single self-contained asset).
scripts/build-fixture-history.mjs       Builds the §11.2 fixture git history in a temp dir from fixtures/app + fixtures/commits.
fixtures/app/                           Small Vite app (§11.2). Doubles as demo and manual QA.
fixtures/commits/01..06/                Six patch sets: label edit, restyle, layout shift, added step, renamed selector, console error.
tests/fixtures/runs/<case>/{base,head}/ Committed miniature run directories for golden diff tests (§11.3).
tests/golden/engine.golden.test.ts      Snapshots findings.json for every committed pair.
tests/integration/determinism.test.ts   §11.1
tests/integration/history.test.ts       §11.2
tests/integration/network-isolation.test.ts §11.5
tests/integration/worktree-safety.test.ts   §11.8 / §10
tests/contract/cli-json.test.ts         §11.6
tests/integration/report-ui.test.ts     §11.7 UI smoke via Playwright against the report itself.
```

---

## 2. Shared contracts — the exact contents of `src/types.ts`

This is the file the scaffold agent writes verbatim. Every module imports from it and nothing else
redefines these shapes. `DEFAULTS` lives here so `config/defaults.ts` cannot drift from the spec.

```ts
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
  | 'console-error';

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
```

---

## 3. Build order and dependency edges

Each phase depends only on phases above it. Items within a phase are independent and may be built
in parallel by separate agents.

```
P0  types.ts + version.ts                     (no deps)
     │
P1  util/*                                    ← types
     │
P2  config/*        flow/*                    ← types, util            (parallel)
     │                  │
P3  store/*                                   ← types, util, config, flow
     │                  │
P4  diff/*          runner/*                  ← types, util, config, flow, store   (parallel)
     │                  │
P5  report/server (server, routes, api, blobs, auth, sse, watcher, feedback-api, assets)
                                              ← types, util, config, store, diff
    report/ui/*                               ← types only (browser bundle)        (parallel with server)
    adapters/*                                ← types, util                         (parallel)
     │
P6  cli/*                                     ← everything
     │
P7  fixtures/app + fixture history + integration tests   ← cli
```

Precise edges worth calling out:

- `flow/structural-diff.ts` is imported by `diff/engine.ts` (stage 1) and by nothing else. It is
  the only flow→diff edge.
- `store/run-load.ts` is the only way `diff/` reads a run. `diff/` never imports from `runner/`.
- `runner/` writes runs exclusively through `store/run-store.ts`, which is the only writer of the
  atomic temp-then-rename sequence.
- `report/` reads runs and diffs through `store/`, and computes missing diffs by calling
  `diff/index.ts#computeDiff`. It never imports `runner/` — the page executes nothing (D6).
- `report/ui/*` imports **only** `src/types.ts` (type-only imports, erased at bundle time), which
  is what keeps the browser bundle free of Node code.
- `adapters/claude-code.ts` depends on `util/fs.ts` and templates only; it never imports the CLI,
  so adapter installation cannot pull the whole tool into memory.
- `cli/main.ts` is the only file that calls `process.exit`.

Recommended agent split: **A** = util + config + flow; **B** = store; **C** = diff; **D** = runner;
**E** = report server; **F** = report UI; **G** = cli + adapters. B blocks C and D; C and E overlap
only at `computeDiff`'s signature, which is fixed by `DiffEngineOptions` and `DiffResult` in P0.

---

## 4. Spec section → file map (nothing orphaned)

| Spec | Content | Files |
|---|---|---|
| §3 | Vocabulary: flow, step, shot, run, revision, pair, finding | `src/types.ts` (every name in the table is a type) |
| §4 D1 | capture → store → diff → report | phase structure P3–P6 |
| §4 D2 | agent-authored specs, replayed headless | `flow/*`, `runner/driver.ts` |
| §4 D3 | git-anchored replay + append-only store | `runner/git.ts`, `runner/worktree.ts`, `store/run-store.ts`, `cli/commands/run.ts` (`--at`) |
| §4 D4 | contemporaneous flow spec, aligned by id | `runner/git.ts` (`git show <sha>:…`), `flow/structural-diff.ts` |
| §4 D5 | layered pixel→DOM diff | `diff/pixel.ts`, `diff/regions.ts`, `diff/attribute.ts`, `diff/node-diff.ts` |
| §4 D6 | live push out, feedback in; page executes nothing | `report/sse.ts`, `report/watcher.ts`, `report/feedback-api.ts`, `cli/commands/feedback.ts` |
| §4 D7 | filmstrip + focused pair shell | `report/ui/components/*` |
| §4 D8 | declarative YAML, closed vocabulary | `flow/schema.ts`, `types.ts#STEP_VERBS` |
| §4 D9 | spawn per revision with HAR | `runner/serve-app.ts`, `runner/har.ts` |
| §5 | module seams, JSON contract at each edge | each module's `index.ts`; `src/index.ts` |
| §6 store tree | `.visual-diff/` layout, step dirs keyed by id | `store/paths.ts` |
| §6 meta.json | run metadata incl. dirtyHash | `types.ts#RunMeta`, `runner/git.ts`, `store/run-store.ts` |
| §6 flow spec v1 | schema, verbs, mask | `flow/schema.ts`, `flow/parse.ts`, `flow/validate.ts` |
| §6 configuration | config.yaml | `config/schema.ts`, `config/load.ts`, `config/defaults.ts` |
| §6 git boundary | flows + config committed, rest ignored | `cli/commands/init.ts` (writes the gitignore block) |
| §6 HAR scrubbing | Authorization/Cookie/Set-Cookie + redact; `--no-scrub` | `runner/har.ts`, `types.ts#DEFAULTS.alwaysRedactHeaders` |
| §6 retention | keep 20, keep meta forever, pin, diff-referenced exempt | `store/retention.ts`, `cli/commands/pin.ts` |
| §7 fast path | attach: probe readyOn, drive directly | `runner/serve-app.ts` |
| §7 slow path | worktree, dep cache, flow from git, spawn, teardown | `runner/worktree.ts`, `runner/deps.ts`, `runner/serve-app.ts`, `runner/git.ts` |
| §7 determinism | CSS kill, TZ/locale/clock/random, scrollbars, settle gate, masks | `runner/determinism.ts`, `runner/settle.ts`, `runner/browser.ts`, `runner/capture.ts` |
| §7 capture | screenshot, dom.json, a11y.json, console/network per step | `runner/capture.ts`, `runner/dom-extract.ts` |
| §7 viewport isolation | independent contexts, worker cap | `runner/viewport.ts`, `runner/browser.ts` |
| §7 network | record then replay, `notFound:'abort'`, misses as warnings | `runner/har.ts` |
| §7 step failure | blocked downstream, partial run, `--continue-on-error` | `runner/driver.ts` |
| §7 two guards | git moved → `unstable`; lockfile-keyed dep cache | `runner/run.ts`, `runner/deps.ts` |
| §8 pure function + cache | two run dirs in, findings.json out | `diff/engine.ts`, `store/diff-store.ts` |
| §8 stage 1 | structural flow diff | `flow/structural-diff.ts` |
| §8 stage 2 | pixel diff, dimension mismatch handling | `diff/pixel.ts`, `diff/image.ts` |
| §8 stage 3 | region clustering, drop, cap, collapse | `diff/regions.ts` |
| §8 stage 4 | DOM attribution | `diff/attribute.ts` |
| §8 stage 5 | node matching and classification | `diff/node-diff.ts`, `diff/findings.ts` |
| §8 kinds + severity | seven kinds, heuristic severity, never hides | `types.ts#FINDING_KINDS`, `diff/severity.ts`, `diff/contrast.ts`, `diff/a11y-diff.ts`, `diff/console-network.ts` |
| §8 findings.json shape | the example JSON | `types.ts#DiffResult`, `diff/findings.ts`, `diff/summary.ts` |
| §8 noise control | minRegionArea, tolerance, mask, ignore | `diff/regions.ts`, `diff/ignore.ts` |
| §8 prose belongs to agent | structured findings only | `adapters/templates/skill.md`; no model/network code anywhere in `src/` |
| §9 server | 127.0.0.1, ephemeral port, serve.json, token | `report/server.ts`, `report/auth.ts` |
| §9 API | flows/runs/diff/blobs/events/feedback | `report/routes.ts`, `report/api.ts`, `report/blobs.ts`, `report/sse.ts`, `report/feedback-api.ts` |
| §9 shell | header, filmstrip, focus pane, right rail, viewport tabs, keys | `report/ui/*` |
| §9 live channel | follow newest, badge when pinned, diff before event | `report/watcher.ts`, `report/ui/state.ts` |
| §9 feedback | pending.jsonl append, crop path | `report/feedback-api.ts`, `store/feedback-store.ts`, `diff/crops.ts` |
| §9 CLI surface | ten commands, `--json`, exit codes | `cli/main.ts`, `cli/args.ts`, `cli/output.ts`, `cli/commands/*` |
| §9 Claude Code integration | skill + two commands | `adapters/claude-code.ts`, `adapters/templates/*` |
| §10 | every failure row | `util/errors.ts` (+ the per-row owners listed in §5 below) |
| §11 | testing | §5 of this plan |
| §12 | package/binary, pixelmatch, Preact, 5000-node cap, TS+Node 20 ESM | `package.json`, `diff/pixel.ts`, `report/ui/*`, `types.ts#DEFAULTS.maxDomNodes` |
| §13 | next slices | out of scope; `adapters/index.ts` is the seam that keeps subsystem 1 cheap |

### §10 error table, row by row

| Failure | Behavior | Owner |
|---|---|---|
| Config or spec invalid | exit 2 with file, line, offending key | `config/load.ts`, `flow/parse.ts`, `flow/validate.ts`, `cli/main.ts` |
| Dev server never ready | exit 1, last 50 log lines saved to the run dir | `runner/serve-app.ts` |
| Install fails at old revision | `failed(install)`, `install.log` retained, timeline entry preserved | `runner/deps.ts`, `store/run-store.ts` |
| Flow absent at target SHA | clean rejection, not an empty run | `runner/git.ts`, `runner/run.ts` |
| Step fails | partial run, downstream blocked, failure DOM + shot | `runner/driver.ts`, `runner/capture.ts` |
| HAR miss | abort, record, run warning listing URLs | `runner/har.ts` |
| Diff references pruned run | report offers the exact backfill command | `report/api.ts` → `BackfillRequired` |
| Concurrent runs on one flow | per-flow lockfile with stale-PID detection | `store/lock.ts` |
| Crash mid-run | temp dir, atomic rename; orphan worktrees reaped at startup | `util/atomic.ts`, `store/run-store.ts`, `runner/worktree.ts` |
| Chromium missing | one-line message pointing at `vdiff install-browser` | `runner/browser.ts`, `cli/commands/install-browser.ts` |

**Non-negotiable (§10):** worktrees are detached under `cache/`, and no code path may touch the
user's working tree, index, stashes, or HEAD. `runner/git.ts` exposes read-only commands plus
`worktree add --detach` / `worktree remove` and nothing else; this is enforced by an allowlist inside
that file and by the §11.8 test.

---

## 5. Test plan, mapped to spec §11

Ordered exactly as §11 orders them — by how much design they protect.

**§11.1 Determinism test** — `tests/integration/determinism.test.ts`.
Replay the fixture app at one revision twice; assert `DiffResult.summary.totalFindings === 0`. Then
replay five times and assert all ten pairwise-adjacent diffs are empty. Runs both viewports. This
test is the acceptance gate for everything in `runner/determinism.ts`, `runner/settle.ts` and
`runner/har.ts`; if it cannot hold green, the run knobs are wrong, not the test. Budget: fail the
suite if a single determinism run exceeds 30s wall clock (the §12 condition for revisiting
`pixelmatch`).

**§11.2 Fixture app plus scripted git history** — `fixtures/app/`, `fixtures/commits/01..06/`,
`scripts/build-fixture-history.mjs`, `tests/integration/history.test.ts`.
A small Vite app with six commits: (1) label edit, (2) restyle, (3) layout shift, (4) added step,
(5) renamed selector, (6) introduced console error. The build script materializes the history into a
temp directory at test setup — the fixture history is **not** a nested repo in this repository.
Assertions, one per commit: label edit → one `content` finding on the labelled element; restyle →
`style` findings with per-property changes and no `content`; layout shift → `layout` findings with
rect deltas; added step → `flowDiff` entry `{status:'added'}`; renamed selector → `spec-changed`
with the `'#pay' -> '[data-test=pay]'` detail and *not* an added/removed pair; console error → a
`console` finding at severity `high`. Doubles as the demo and as manual QA.

**§11.3 Golden tests on the diff engine** — `tests/fixtures/runs/<case>/{base,head}/` +
`tests/golden/engine.golden.test.ts`.
Committed pairs of miniature run directories (tiny PNGs, small `dom.json`s, hand-written
`flow.snapshot.yaml`s), snapshotting the full `findings.json`. Fast, hermetic, no browser. Cases:
text-only change, style-only change, moved element, resized element, added node, removed node,
page-height change (dimension mismatch), masked-region change (expect zero findings), ignored
selector, region cap overflow, truncated DOM snapshot. Golden output must be byte-stable, which is
why `util/json.ts` stringifies with sorted keys and why `computedAt` is normalized in the snapshot
serializer.

**§11.4 Unit tests on pure functions** — colocated `*.test.ts`, written test-first.
`flow/parse.ts` + `flow/validate.ts` (every §10 row-1 failure mode, with line and key),
`flow/structural-diff.ts` (all six buckets), `diff/regions.ts` (clustering, merge, drop, cap),
`diff/attribute.ts` (smallest containing node, changed-rect preference, truncation fallback),
`diff/node-diff.ts` (three key kinds, all seven change kinds), `diff/severity.ts` (each named
heuristic, plus the invariant that nothing is filtered), `diff/contrast.ts`, `util/duration.ts`,
`util/id.ts`, `util/selector.ts`, `runner/viewport.ts`, `runner/driver.ts` blocked/re-anchor state
machine, `report/ui/state.ts` and `report/ui/keys.ts`. Real assertions on real values — no
`expect(fn).toBeDefined()`.

**§11.5 Network isolation test** — `tests/integration/network-isolation.test.ts`.
Record a HAR against the fixture app, then replay with real network blocked at the browser-context
level. Assert zero outbound requests escaped, that every request reports `harMatch: 'hit'`, and that
the resulting run is byte-identical to the recorded run's shots. A deliberately removed HAR entry
must produce `harMatch:'miss'`, an aborted request, and a `har-miss` run warning listing the URL —
never a live fetch.

**§11.6 CLI `--json` contract tests** — `tests/contract/cli-json.test.ts`.
Snapshot the `CliEnvelope` for every command in §9: `init`, `flow check` (pass and fail),
`run`, `runs`, `diff`, `serve`, `feedback`, `pin`, `prune`, `install-browser`. Assert stdout is
exactly one JSON object with no log noise, and assert exit codes: 0 for success, 0 for `diff` **with
findings present**, 1 for a run failure, 2 for an invalid spec. These shapes are the agent-facing
API across four harnesses, so any change to them must show up as a snapshot diff.

**§11.7 Report tests** — colocated `report/*.test.ts` + `tests/integration/report-ui.test.ts`.
API contract snapshots for each endpoint; token rejection on every route; blob path-traversal
rejection; SSE delivery — write a new run into the store and assert the `diff` event arrives only
after `findings.json` exists on disk; feedback append round-trip through `POST /api/feedback` →
`pending.jsonl` → `vdiff feedback --json --ack` → archive. UI smoke driven by Playwright against the
served report: filmstrip renders one cell per step including blocked cells, clicking a step changes
the focus pane, `o` toggles overlay, `f` filters to findings, clicking a region opens the feedback
box and posting appends a line.

**§11.8 Working-tree safety test** — `tests/integration/worktree-safety.test.ts`.
Capture `git status --porcelain`, `git rev-parse HEAD`, `git stash list` and the index hash in the
fixture repo; run a historical replay (`--at <old sha>`), including a replay that fails mid-install
and one that fails mid-step; assert all four are byte-identical afterwards, and that
`cache/worktrees/` is empty. This is the test §10 names explicitly.

### Test infrastructure notes

- Unit and golden tests run with no browser and no network; integration tests are tagged so
  `vitest run src` stays fast for the inner loop.
- The fixture app's dev server is started through the same `runner/serve-app.ts` path the product
  uses, per §11's rule that the runner is tested against the fixture app rather than a mocked
  Playwright.
- Every temp directory used by integration tests is created under the OS temp dir and removed in
  `afterEach`, so a failed test never leaves worktrees or dep caches behind.

---

## 6. Open items to report upward (not decided by this plan)

1. **`esbuild` dev dependency** for `scripts/build-ui.mjs`, required by §9's "prebuilt static UI
   shipped inside the package". See §0 for the fallback and why it is worse.
2. **`@types/pngjs`** dev dependency; `pngjs` ships no types.
3. `package.json` needs `"type": "module"`, `"bin": { "vdiff": "dist/cli/main.js" }`, `engines.node
   >= 20`, and a `files` list that includes the prebuilt `dist/ui/` bundle.
4. `tsconfig.json` should enable `strict`, `noUncheckedIndexedAccess`, `module: "NodeNext"`, and
   `jsx: "react-jsx"` with `jsxImportSource: "preact"` for `src/report/ui`.
5. Nothing in the spec fixes the concrete shape of `scroll:` and `expect:` beyond their presence in
   the closed verb list; `ScrollAction` and `Expectation` in `src/types.ts` are the minimal shapes
   this plan proposes for them. If they should be narrower, decide before `flow/schema.ts` is built.
