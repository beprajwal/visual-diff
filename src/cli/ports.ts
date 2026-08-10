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
  HarnessId,
  HarnessInstallDetail,
  HarnessTargets,
  InstallOptions,
  InstallScope,
  ManagedFile,
} from '../adapters/index.js';
import type { VariantName, VariantSpec } from './variant.js';

/**
 * How stored runs are narrowed, on both axes of run identity beyond `(flow, revision)`.
 *
 * One object rather than two positional arguments because the two filters compose — "the denser
 * layout, in the empty state" is a reasonable question (variants spec §5) — and because the store
 * already takes an options object for `scenario`.
 *
 * `variant` is the recorded value, so `VARIANT_NONE` selects the regression timeline (runs captured
 * without a variant) and a name selects one proposal's runs. Omitting it selects *everything*,
 * which is what `vdiff diff <flow> 0003 0007` naming two runs outright has to keep doing.
 */
export interface RunFilter {
  scenario?: ScenarioName;
  variant?: VariantName;
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
  id: HarnessId;
  label: string;
  notes: readonly string[];
}
