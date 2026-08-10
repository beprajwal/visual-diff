/**
 * Report server ports (spec §9).
 *
 * The server never reaches into another module's internals: it talks to the store through
 * {@link ReportStore} and to the diff engine through {@link ComputeDiffFn}. Both are injected, so
 * the CLI wires the real `store/` facade and `diff/index.ts#computeDiff` while tests wire fakes.
 *
 * `ComputeDiffFn` is exactly the signature fixed by `DiffEngineOptions` / `DiffResult` in
 * `src/types.ts`, which is the only overlap between the diff engine and this module.
 *
 * Note what is *absent* from these ports, deliberately and permanently (spec §9, D6): there is no
 * "run", "build", "spawn", "install" or git operation. The page executes nothing. The single
 * mutating operation reachable from an HTTP request is {@link ReportStore.appendFeedback}.
 */

import type {
  DiffEngineOptions,
  DiffResult,
  FeedbackEntry,
  RunId,
  RunMeta,
  RunSummary,
} from '../../types.js';
import type { RunAttribution } from '../attribution.js';
import type { RunVariantAttribution } from '../variant.js';

/** The diff engine's edge: two run directories in, one DiffResult out. No network, no browser. */
export type ComputeDiffFn = (
  baseRunDir: string,
  headRunDir: string,
  options: DiffEngineOptions,
) => Promise<DiffResult>;

/** One entry of `GET /api/flows`. */
export interface FlowInfo {
  name: string;
  runs: number;
  latest: RunId | null;
}

/** A feedback entry before the store assigns its id. */
export type FeedbackDraft = Omit<FeedbackEntry, 'id'>;

/**
 * Everything the report server needs from the on-disk store (spec §6). Read-only except for the
 * feedback append.
 */
export interface ReportStore {
  /** Absolute path to the `.visual-diff` directory. */
  readonly root: string;
  /** Absolute path to `.visual-diff/runs`. */
  readonly runsDir: string;

  listFlows(): Promise<FlowInfo[]>;
  /** Run ids for a flow, ascending. */
  listRunIds(flow: string): Promise<RunId[]>;
  /** Timeline rows for `GET /api/runs/:flow`, ascending. */
  listRuns(flow: string): Promise<RunSummary[]>;
  readMeta(flow: string, runId: RunId): Promise<RunMeta | null>;
  /** One timeline row, or null when the run is unknown. */
  readRunSummary(flow: string, runId: RunId): Promise<RunSummary | null>;
  /** Absolute path of a run directory. Does not assert existence. */
  runDir(flow: string, runId: RunId): string;
  /**
   * What the scenario layer did to each step of a run, folded from the `network.json` files
   * (mocking spec §8). Null when the run is unknown; empty rows when it had no scenario.
   */
  readAttribution(flow: string, runId: RunId): Promise<RunAttribution | null>;
  /**
   * What the variant layer did to each step of a run, folded from `variant.json` (variants spec
   * §7). Null when the run is unknown; empty rows when it had no variant.
   *
   * A second route rather than a field on {@link readAttribution}, for the reason attribution is a
   * route at all: it is a property of *one run*, and the two axes were shaped by different specs
   * whose rules have their own ids. Folding them into one payload would make a cross-variant pair
   * unable to say which side did what.
   */
  readVariantAttribution(flow: string, runId: RunId): Promise<RunVariantAttribution | null>;
  /** A previously stored `findings.json`, or null when nothing is cached. */
  readCachedDiff(flow: string, base: RunId, head: RunId): Promise<DiffResult | null>;
  /**
   * Resolve a blob path relative to `.visual-diff` to an absolute file path, or null when the
   * path escapes the store, names a disallowed area, or does not exist.
   */
  resolveBlob(relPath: string): Promise<string | null>;
  /** The one write reachable from an HTTP request: append a line to feedback/pending.jsonl. */
  appendFeedback(draft: FeedbackDraft): Promise<FeedbackEntry>;
}
