/**
 * cli — the module edges the CLI consumes (spec §5).
 *
 * The CLI holds no domain logic: it parses argv, calls one function on another module, and renders
 * the answer. This file is the declaration of exactly which functions those are — the config
 * loader, the flow parser, the store facade, the runner, the diff engine and the report server.
 *
 * Declaring them as an interface (rather than importing the modules directly at the top of every
 * command) buys two things:
 *
 *  1. The command tests exercise real argument handling, real exit-code mapping and the real
 *     `--json` envelope against in-memory fakes, with no browser, no store on disk and no
 *     dependency on module build order.
 *  2. The set of functions the CLI depends on is written down in one place, which is what makes
 *     "the CLI is harness-agnostic and every module exposes a JSON contract at its edge" checkable
 *     rather than notional.
 *
 * `deps.ts` binds this interface to the real modules; nothing else in `src/cli` imports them.
 */

import type {
  Config,
  DiffEngineOptions,
  DiffResult,
  FeedbackEntry,
  FlowSpec,
  PairRef,
  RunId,
  RunOptions,
  RunResult,
  RunSummary,
  ScenarioName,
  ScenarioSpec,
  ServeInfo,
  ServeOptions,
  ValidationResult,
} from '../types.js';
import type {
  HarnessInstallDetail,
  HarnessTargets,
  InstallOptions,
  InstallScope,
  InstallTargetId,
  ManagedFile,
  TargetKind,
} from '../adapters/index.js';
import type {
  CommentDocument,
  CommentInput,
  ExportReport,
  ExportRequest,
} from '../ci/index.js';
import type { E2eOrigin, E2eSourceFormat } from './e2e.js';
import type { VariantName, VariantSpec } from './variant.js';

/**
 * Which runs of a *bucket* a read includes, for the two axes that have one.
 *
 * Distinct from naming a scenario or a variant, which narrows to a value. A bucket is a whole
 * timeline: variant runs are exploratory and kept out of the regression history (D24), ingested runs
 * are a separate timeline with a separate retention bucket (e2e §7, D27). `exclude` is what the
 * store does by default on both, so `vdiff runs <flow>` and `vdiff diff <flow>` keep meaning exactly
 * what they meant before either feature existed.
 */
export type TimelineFilter = 'exclude' | 'include' | 'only';

/**
 * How stored runs are narrowed, on the axes of run identity beyond `(flow, revision)`.
 *
 * One object rather than positional arguments because the filters compose — "the denser layout, in
 * the empty state" is a reasonable question (variants spec §5) — and because the store already takes
 * an options object for `scenario`.
 *
 * `variant` is the recorded value, so `VARIANT_NONE` selects the regression timeline (runs captured
 * without a variant) and a name selects one proposal's runs. Omitting it selects *everything*,
 * which is what `vdiff diff <flow> 0003 0007` naming two runs outright has to keep doing.
 *
 * `variants` and `e2e` are the bucket switches, and the field names are the store's own so this
 * object is passed through rather than translated. Both default — in the *store*, not here — to
 * `exclude`. That default is why an ingested run never becomes half of a pair nobody asked for
 * (D27): the two capture methods differ in browser, timing, image format and scale, and a default
 * that crossed them would greet a first-time user with a wall of findings about the capture rather
 * than about their application. Crossing stays reachable by naming two runs outright, and the
 * resulting pair is flagged at high severity rather than refused.
 */
export interface RunFilter {
  scenario?: ScenarioName;
  variant?: VariantName;
  /** Which variant runs to include. Omitted means the store's default, `exclude` (D24). */
  variants?: TimelineFilter;
  /** Which ingested runs to include. Omitted means the store's default, `exclude` (D27). */
  e2e?: TimelineFilter;
}

/** A running report server. `close()` releases the port and removes `serve.json`. */
export interface ServeHandle {
  info: ServeInfo;
  close(): Promise<void>;
}

/**
 * The store facade (`store/index.ts#openStore`). Every path the CLI prints or hands to another
 * module is constructed by the store — the CLI never joins a store path itself (spec §5: the
 * on-disk store *is* the interface between modules).
 */
export interface StorePort {
  /** Absolute path of `.visual-diff/flows`. */
  flowsDir(): string;
  /** Absolute path of `.visual-diff/flows/<flow>.yaml`. */
  flowFile(flow: string): string;
  /** Flow names that have a spec or at least one run. */
  listFlows(): Promise<string[]>;
  /**
   * Timeline rows, oldest first, optionally narrowed (mocking spec §7, variants spec §5). The
   * filter belongs to the store rather than the CLI because `findingsCount` is measured against the
   * previous run *of the same identity*, which a caller filtering the returned array cannot undo.
   */
  listRuns(flow: string, filter?: RunFilter): Promise<RunSummary[]>;
  /**
   * Defaults to N-1 vs N when base/head are omitted (spec §9). `scenario` narrows that default to
   * runs captured under it, because "did the empty state break between these revisions?" needs
   * like-for-like pairs (mocking spec §6, D12); `SCENARIO_NONE` narrows it to runs that had none.
   *
   * `variant` is different in kind, and deliberately so (D24): for a variant the question is not
   * regression but the proposal itself, so the default pair is the newest run of that variant
   * against the nearest run *without* one at the same revision. The store resolves that, because
   * which runs exist at which revision is store knowledge.
   */
  resolvePair(flow: string, base?: RunId, head?: RunId, filter?: RunFilter): Promise<PairRef>;
  /** Absolute path of `runs/<flow>/<runId>`. */
  runDir(flow: string, runId: RunId): string;
  /** Absolute path of `diffs/<flow>/<base>..<head>/findings.json`. */
  diffFile(pair: PairRef): string;
  /** Absolute path of the default export bundle directory for a pair (CI spec §5). */
  exportDir(pair: PairRef): string;
  /** Cached `findings.json` for the pair, or null when it has never been computed. */
  readDiff(pair: PairRef): Promise<DiffResult | null>;
  /** Persists `findings.json` (plus crops) and returns its absolute path. */
  writeDiff(pair: PairRef, result: DiffResult): Promise<string>;
  /** Exempts a run from retention pruning (spec §6). */
  pinRun(flow: string, runId: RunId): Promise<RunSummary>;
  /** Deletes a run's blobs, keeping meta.json and flow.snapshot.yaml (spec §6). */
  pruneRun(flow: string, runId: RunId): Promise<RunSummary>;
  /** Unacknowledged lines of `feedback/pending.jsonl`, oldest first. */
  readPendingFeedback(flow?: string): Promise<FeedbackEntry[]>;
  /**
   * Moves the given entries to `feedback/archive/<date>.jsonl` and returns that file's path —
   * null when nothing was acknowledged, so "acked 0 → <path>" is unrepresentable.
   */
  ackFeedback(entries: FeedbackEntry[]): Promise<{ archive: string | null; acked: FeedbackEntry[] }>;
}

/* ------------------------------------------------------------------ the e2e edge (§6) */

/**
 * One `vdiff e2e` invocation, as the ingestion module receives it.
 *
 * The CLI resolves nothing here — not the glob, not the archive's contents, not the flow name. It
 * hands over exactly what was typed plus the directory relative paths are relative to, because
 * *which files a pattern names* and *what a trace's title maps onto* are both ingestion knowledge
 * (D26), and a CLI that expanded the glob itself would have to agree with the reader about symlinks,
 * ordering and case sensitivity forever.
 */
export interface E2eIngestRequest {
  /** The reader to use. Only `trace` ships in this slice (§2). */
  from: E2eSourceFormat;
  /** Path or glob, exactly as typed. */
  pattern: string;
  /** Directory a relative `pattern` resolves against — the directory `vdiff` was invoked from. */
  cwd: string;
  /** Override the flow name derived from the test title (§6). Absent when it was not given. */
  flow?: string;
}

/**
 * One archive the ingestion would read, as `vdiff e2e list` reports it (§6: "show what would be
 * ingested, without writing").
 *
 * `list` and the real ingestion answer the same questions off the same plan, so the fields here are
 * the fields ingestion needs anyway. A `list` that computed less would be a preview of something
 * other than what runs.
 */
export interface E2eArchivePlan {
  /** Absolute path of the archive. */
  path: string;
  /** Content hash of the archive — the key ingestion is idempotent on (§6). */
  hash: string;
  /** The flow this archive becomes a run of, after any `--flow` override (D26). */
  flow: string;
  /** The test title the flow name came from; null for a trace that carries none. */
  title: string | null;
  /** Step ids the trace's steps map onto, in order, already disambiguated (D26, §8). */
  steps: string[];
  /** Screenshots the archive holds. Zero is refused at ingest — nothing to diff (§8). */
  shots: number;
  /** Playwright trace format version, as recorded on the first line of each `*.trace` stream. */
  traceVersion: number;
  /** Capture conditions the archive records (§7). */
  origin: E2eOrigin;
  /**
   * True when a run already exists for this hash. Ingestion is idempotent (§6), so this archive
   * produces no second run — `list` says so up front rather than letting a re-run look like a no-op.
   */
  alreadyIngested: boolean;
  /** The run id an earlier ingestion produced for this hash; null when the archive is new. */
  runId: RunId | null;
  /** Per-archive notices: duplicate step titles disambiguated with a stable suffix, and so on (§8). */
  notices: string[];
}

/** What `vdiff e2e list` reports, and what `vdiff e2e` acts on. Writes nothing. */
export interface E2eIngestPlan {
  from: E2eSourceFormat;
  /** The pattern exactly as typed, echoed so a `--json` consumer need not re-read argv. */
  pattern: string;
  /** Every archive the pattern named, in a stable order. Empty when it matched nothing. */
  archives: E2eArchivePlan[];
  /**
   * `e2e-map.yaml` entries pinning a title no archive in this plan carries (§8). A stale map entry
   * silently doing nothing is the same failure as a never-matched scenario rule, so it is listed
   * rather than ignored.
   */
  unmatchedMapEntries: string[];
  /** Anything else the reader wants said about the plan as a whole. */
  warnings: string[];
}

/** One archive that became — or already was — a run. */
export interface E2eIngestedRun {
  path: string;
  hash: string;
  flow: string;
  runId: RunId;
  /** True when the hash was already ingested, so no second run was written (§6). */
  reused: boolean;
  steps: string[];
  shots: number;
  notices: string[];
}

/** What `vdiff e2e --from trace <path|glob>` did. */
export interface E2eIngestReport {
  from: E2eSourceFormat;
  pattern: string;
  runs: E2eIngestedRun[];
  unmatchedMapEntries: string[];
  warnings: string[];
}

export interface Ports {
  /** `config/load.ts` — locates the project root and applies defaults. Exit 2 when invalid. */
  loadConfig(cwd: string): Promise<Config>;
  /** `flow/index.ts` — parse + validate a spec file without running it. */
  parseFlowFile(file: string): Promise<ValidationResult<FlowSpec>>;

  /*
   * The scenario edge (`mocking/index.ts`). Scenario *file layout* lives there rather than in the
   * store because `.visual-diff/scenarios/<name>.yaml` is defined by the mocking spec (§5
   * "Storage") and read from git history at the target SHA by the same module that parses it. The
   * CLI still constructs no path itself.
   */

  /** Absolute path of `.visual-diff/scenarios`. Async only because the edge is loaded on first use. */
  scenariosDir(config: Config): Promise<string>;
  /** Absolute path of `.visual-diff/scenarios/<name>.yaml`. */
  scenarioFile(config: Config, name: ScenarioName): Promise<string>;
  /** Scenario names with a spec file on disk, sorted. */
  listScenarios(config: Config): Promise<ScenarioName[]>;
  /**
   * Parse + validate a scenario file without running it (mocking spec §7, §8). Same contract as
   * {@link parseFlowFile}: issues carry file, line and offending key, and the messages are the
   * feature's user interface, so the CLI prints them verbatim.
   */
  parseScenarioFile(file: string): Promise<ValidationResult<ScenarioSpec>>;

  /*
   * The variant edge (`variant/index.ts`), the exact shape of the scenario edge above and for the
   * same reasons: `.visual-diff/variants/<name>.yaml` is defined by the variants spec (§4
   * "Storage") and read from git history at the target SHA by the module that parses it.
   */

  /** Absolute path of `.visual-diff/variants`. Async only because the edge is loaded on first use. */
  variantsDir(config: Config): Promise<string>;
  /** Absolute path of `.visual-diff/variants/<name>.yaml`. */
  variantFile(config: Config, name: VariantName): Promise<string>;
  /** Variant names with a spec file on disk, sorted. */
  listVariants(config: Config): Promise<VariantName[]>;
  /**
   * Parse + validate a variant file without running it (variants spec §6, §7). Same contract as
   * {@link parseFlowFile}: issues carry file, line and offending key, and the messages are the
   * feature's user interface, so the CLI prints them verbatim.
   */
  parseVariantFile(file: string): Promise<ValidationResult<VariantSpec>>;

  /*
   * The e2e edge (`e2e/index.ts`). Two calls over one request shape, deliberately: `vdiff e2e list`
   * promises to write nothing (§6), and the only way to keep that promise honestly is for the
   * preview and the ingestion to be the *same* computation with the write at the end of one of them.
   */

  /** Read every archive the pattern names and report what ingestion would do. Writes nothing. */
  planE2eIngest(config: Config, request: E2eIngestRequest): Promise<E2eIngestPlan>;
  /**
   * Ingest the archives into runs. Idempotent on the archive's content hash (§6): an archive already
   * ingested yields its existing run marked `reused`, never a duplicate.
   */
  ingestE2eTraces(config: Config, request: E2eIngestRequest): Promise<E2eIngestReport>;

  /*
   * The CI edge (`ci/index.ts`). Two calls, both pure functions of a stored diff (CI spec D29): one
   * renders markdown, one writes a directory. Neither takes a token or opens a socket — posting a
   * comment and pushing images belong to whatever transports the result, which for GitHub is the
   * composite action, where the credential already lives.
   *
   * Behind the lazy edge like every other module here, and it matters for this one: the bundle
   * writer pulls in `node:fs` and the store's path builders, and `vdiff runs` must not.
   */

  /** `ci/index.ts#renderComment` — a stored diff as pull-request markdown (CI spec §6). */
  renderComment(input: CommentInput): Promise<CommentDocument>;
  /** `ci/index.ts#exportBundle` — the portable evidence bundle (CI spec §5). */
  exportBundle(request: ExportRequest): Promise<ExportReport>;

  /** `store/index.ts#openStore`. */
  openStore(config: Config): Promise<StorePort>;
  /** `runner/index.ts#runFlow`. */
  runFlow(options: RunOptions): Promise<RunResult>;
  /** `diff/index.ts#computeDiff` — pure: two run directories in, one DiffResult out. */
  computeDiff(baseDir: string, headDir: string, options: DiffEngineOptions): Promise<DiffResult>;
  /**
   * `report/index.ts#serveReport`. Takes the loaded config because the server reads the store at
   * `config.dir` — `vdiff serve` outside a project must fail as a config error, not as an empty
   * report.
   */
  serveReport(config: Config, options: ServeOptions): Promise<ServeHandle>;
  /**
   * `adapters/index.ts` — every harness this build can install, in registration order. The CLI
   * asks rather than hard-coding the list, so `vdiff install nope` names exactly the adapters that
   * are actually registered and adding one to the registry needs no CLI change.
   */
  listAdapters(): Promise<HarnessInfo[]>;
  /**
   * `adapters/index.ts#getAdapter(id).files(scope)` — every file a harness would write for one
   * scope, fully composed. Touches no directory, which is what lets `install --list` promise it
   * writes nothing.
   */
  adapterFiles(id: string, scope: InstallScope): Promise<ManagedFile[]>;
  /**
   * `adapters/index.ts#getAdapter(id).targets(scope)` — the real directories an install writes.
   * Output names these rather than the harness id, because `vdiff install codex` writing something
   * not called "codex" is otherwise baffling (D18).
   */
  adapterTargets(id: string, scope: InstallScope): Promise<HarnessTargets>;
  /**
   * `adapters/index.ts#installAdapter` — writes one harness's managed files under `root`.
   *
   * The CLI supplies `scope` and `version` because only it knows which the invocation meant and
   * which build is running. Everything about *what* the files contain stays in the adapter.
   */
  installAdapter(id: string, root: string, options: InstallOptions): Promise<HarnessInstallDetail>;
  /**
   * `adapters/index.ts#readInstalledVersion` — the version stamp of a file already on disk,
   * whichever mechanism carries it: frontmatter for a whole-file install, the block comment for
   * `AGENTS.md`. Null when the file carries none, which is what a copy written by a build from
   * before the stamp existed looks like.
   */
  readInstalledVersion(content: string): Promise<string | null>;
}

/**
 * One registered harness adapter, as the CLI needs to print it.
 *
 * `notes` are the caveats the registry records against each harness: what "installed" does *not*
 * guarantee. They are printed rather than kept internal because in every case a correctly written
 * file can still fail to be read — a personal copy overriding the project one, a duplicate staying
 * visible in a selector, or the skill mechanism being switched off by configuration.
 */
export interface HarnessInfo {
  id: InstallTargetId;
  label: string;
  /**
   * Which kinds of artifact this target writes (CI spec D34). Install output prints exactly these,
   * so a harness with no command mechanism is reported as having none (D15) while the GitHub Actions
   * target is not asked to explain why it ships no skills.
   */
  kinds: readonly TargetKind[];
  /** Scopes it has. `.github/workflows` is per repository, so the CI target has `project` only. */
  scopes: readonly InstallScope[];
  notes: readonly string[];
  /** What to do next, printed after a successful install. */
  next: readonly string[];
}
