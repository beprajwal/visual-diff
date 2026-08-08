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
  ServeInfo,
  ServeOptions,
  ValidationResult,
} from '../types.js';

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
  /** Timeline rows, oldest first. */
  listRuns(flow: string): Promise<RunSummary[]>;
  /** Defaults to N-1 vs N when base/head are omitted (spec §9). */
  resolvePair(flow: string, base?: RunId, head?: RunId): Promise<PairRef>;
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
}
