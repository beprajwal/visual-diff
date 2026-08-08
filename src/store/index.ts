/**
 * store — module edge (plan §3).
 *
 * The on-disk store *is* the interface between modules (spec §5): the runner writes runs through
 * it, the diff engine reads runs through it, the report reads both through it, and none of them
 * joins a store path itself. `openStore(config)` binds a project root once and hands back that
 * whole surface.
 */

import * as diffStore from './diff-store.js';
import * as feedbackStore from './feedback-store.js';
import * as lockModule from './lock.js';
import * as paths from './paths.js';
import * as retention from './retention.js';
import * as revision from './revision.js';
import * as runLoad from './run-load.js';
import * as runStore from './run-store.js';
import { parseFlowSnapshot, serializeFlowSnapshot } from './snapshot.js';
import type { AckResult, ReadFeedbackFilter } from './feedback-store.js';
import type { AcquireLockOptions, LockHandle } from './lock.js';
import type { PruneResult } from './retention.js';
import type { RunDraft } from './run-store.js';
import type {
  Config,
  DiffResult,
  FeedbackEntry,
  FeedbackInput,
  LoadedRun,
  PairRef,
  Revision,
  RunId,
  RunMeta,
  RunSummary,
} from '../types.js';

export interface Store {
  readonly config: Config;
  /** Project root: the directory containing `.visual-diff`. */
  readonly root: string;
  /** Absolute path of `.visual-diff`. */
  readonly dir: string;

  /* runs */
  listFlows(): Promise<string[]>;
  listRunIds(flow: string): Promise<RunId[]>;
  latestRunId(flow: string): Promise<RunId | null>;
  readMeta(flow: string, runId: RunId): Promise<RunMeta>;
  listRuns(flow: string): Promise<RunSummary[]>;
  loadRun(flow: string, runId: RunId, options?: runLoad.LoadRunOptions): Promise<LoadedRun>;
  runDir(flow: string, runId: RunId): string;
  beginRun(flow: string): Promise<RunDraft>;
  reapAbandonedRuns(flow: string): Promise<string[]>;
  resolvePair(flow: string, base?: string, head?: string): Promise<PairRef>;

  /* diffs */
  readDiff(pair: PairRef, engineVersion?: string): Promise<DiffResult | null>;
  /** Persists `findings.json` for the pair named inside `result`; returns its absolute path. */
  writeDiff(result: DiffResult): Promise<string>;
  invalidateDiff(pair: PairRef): Promise<void>;
  listStoredPairs(flow: string): Promise<PairRef[]>;

  /* feedback */
  appendFeedback(
    input: FeedbackInput,
    options?: feedbackStore.AppendFeedbackOptions,
  ): Promise<FeedbackEntry>;
  readPendingFeedback(filter?: ReadFeedbackFilter): Promise<FeedbackEntry[]>;
  ackFeedback(ids: readonly string[]): Promise<AckResult>;

  /* retention */
  pin(flow: string, runId: RunId, pinned?: boolean): Promise<RunMeta>;
  prune(flow: string, runId: RunId): Promise<PruneResult>;
  applyRetention(flow: string): Promise<PruneResult>;

  /* misc */
  acquireLock(flow: string, options?: AcquireLockOptions): Promise<LockHandle>;
  readRevision(): Promise<Revision>;
}

export function openStore(config: Config): Store {
  const root = config.root;
  const findingsCountFor = (base: RunId, head: RunId, flow: string): Promise<number | null> =>
    diffStore.readFindingsCount(root, flow, base, head);

  return {
    config,
    root,
    dir: config.dir,

    listFlows: () => runStore.listFlows(root),
    listRunIds: (flow) => runStore.listRunIds(root, flow),
    latestRunId: (flow) => runStore.latestRunId(root, flow),
    readMeta: (flow, runId) => runStore.readRunMeta(root, flow, runId),
    listRuns: (flow) =>
      runStore.listRunSummaries(root, flow, (base, head) => findingsCountFor(base, head, flow)),
    loadRun: (flow, runId, options) => runLoad.loadRun(root, flow, runId, options),
    runDir: (flow, runId) => paths.runDir(root, flow, runId),
    beginRun: (flow) => runStore.beginRun(root, flow),
    reapAbandonedRuns: (flow) => runStore.reapAbandonedRuns(root, flow),
    resolvePair: (flow, base, head) => runStore.resolvePair(root, flow, base, head),

    readDiff: (pair, engineVersion) =>
      diffStore.readDiff(root, pair.flow, pair.base, pair.head, engineVersion),
    writeDiff: (result) => diffStore.writeDiff(root, result),
    invalidateDiff: (pair) => diffStore.invalidateDiff(root, pair.flow, pair.base, pair.head),
    listStoredPairs: (flow) => diffStore.listStoredPairs(root, flow),

    appendFeedback: (input, options) => feedbackStore.appendFeedback(root, input, options),
    readPendingFeedback: (filter) => feedbackStore.readPendingFeedback(root, filter),
    ackFeedback: (ids) => feedbackStore.ackFeedback(root, ids),

    pin: (flow, runId, pinned = true) => retention.pinRun(root, flow, runId, pinned),
    prune: (flow, runId) => retention.pruneRun(root, flow, runId),
    applyRetention: (flow) =>
      retention.pruneFlow(root, flow, { keepRuns: config.retention.keepRuns }),

    acquireLock: (flow, options) => lockModule.acquireLock(root, flow, options),
    readRevision: () => revision.readRevision(root),
  };
}

export { paths };
export * from './errors.js';
export {
  buildConfig,
  findProjectRoot,
  loadConfig,
  loadConfigOrThrow,
  parseConfigSource,
} from './config.js';
export type { ConfigFile, LoadConfigOptions } from './config.js';
export { parseFlowSnapshot, serializeFlowSnapshot };
export {
  acquireLock,
  isProcessAlive,
  readLock,
  withLock,
} from './lock.js';
export type { AcquireLockOptions, LockHandle };
export {
  beginRun,
  latestRunId,
  listFlows,
  listRunIds,
  listRunSummaries,
  readFlowSnapshotSource,
  readRunMeta,
  readRunMetaOrNull,
  readStepResult,
  reapAbandonedRuns,
  resolvePair,
  runExists,
  updateRunMeta,
} from './run-store.js';
export type { CommittedRun, RunDraft, RunMetaInput, ShotInput } from './run-store.js';
export { loadRun, loadRunDir } from './run-load.js';
export type { LoadRunOptions } from './run-load.js';
export {
  hasDiff,
  invalidateDiff,
  listAllStoredPairs,
  listStoredPairs,
  readDiff,
  readFindingsCount,
  readRegions,
  runsReferencedByDiffs,
  statBlob,
  writeCrop,
  writeDiff,
  writePixelDiff,
  writeRegions,
} from './diff-store.js';
export {
  ackAllPending,
  ackFeedback,
  appendFeedback,
  readArchivedFeedback,
  readPendingFeedback,
} from './feedback-store.js';
export type { AckResult, AppendFeedbackOptions, ReadFeedbackFilter } from './feedback-store.js';
export {
  PRESERVED_FILES,
  isPruneExempt,
  pinRun,
  pruneAllFlows,
  pruneFlow,
  pruneRun,
} from './retention.js';
export type { PruneFlowOptions, PruneResult, PruneSkip, PruneSkipReason } from './retention.js';
export {
  computeDirtyHash,
  git,
  headRef,
  headSha,
  isDirty,
  isGitRepo,
  readRevision,
  readWorkingTreeState,
  repoRoot,
  resolveRef,
  showFileAtRef,
  statusPorcelain,
  untrackedFiles,
} from './revision.js';
export type { WorkingTreeState } from './revision.js';
export { parseDuration, formatDuration } from './internal/duration.js';
export {
  compareRunIds,
  feedbackId,
  formatRunId,
  isRunId,
  nextRunId,
  normalizeRunId,
  pairId,
  parsePairId,
  parseRunId,
  sortRunIds,
} from './internal/id.js';
export { stableStringify, stableStringifyLine } from './internal/json.js';
export { hashFile, hashJsonStable, sha256, sha256Hex } from './internal/hash.js';
export { publishDirAtomic, writeFileAtomic, writeJsonAtomic } from './internal/atomic.js';
