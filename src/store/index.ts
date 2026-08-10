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
import { keepVariantRunsOf } from './internal/variant.js';
import type { VariantName, VariantRunSummary } from './internal/variant.js';
import type { AckResult, ReadFeedbackFilter } from './feedback-store.js';
import type { AcquireLockOptions, LockHandle } from './lock.js';
import type { PruneResult } from './retention.js';
import type {
  ListRunSummariesOptions,
  ResolvePairOptions,
  RunDraft,
} from './run-store.js';
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
  ScenarioName,
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
  /**
   * The timeline, optionally narrowed to one scenario (mocking spec §7) or one variant, and by
   * default excluding ephemeral variant runs (variants spec §5, D24).
   */
  listRuns(flow: string, options?: ListRunSummariesOptions): Promise<VariantRunSummary[]>;
  /** The scenario each run of the flow was captured under (mocking spec §6). */
  listRunScenarios(flow: string): Promise<Map<RunId, ScenarioName>>;
  /** The variant each run of the flow was captured under (variants spec §5). */
  listRunVariants(flow: string): Promise<Map<RunId, VariantName>>;
  loadRun(flow: string, runId: RunId, options?: runLoad.LoadRunOptions): Promise<LoadedRun>;
  runDir(flow: string, runId: RunId): string;
  beginRun(flow: string): Promise<RunDraft>;
  reapAbandonedRuns(flow: string): Promise<string[]>;
  /** Same-scenario by default; `options.scenario` restricts both ends (mocking spec §6, §7). */
  resolvePair(
    flow: string,
    base?: string,
    head?: string,
    options?: ResolvePairOptions,
  ): Promise<PairRef>;

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
  /** `--keep`: promote a variant run into the permanent timeline (variants spec §5). */
  keep(flow: string, runId: RunId, kept?: boolean): Promise<RunMeta>;
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
    listRuns: (flow, options) =>
      runStore.listRunSummaries(
        root,
        flow,
        (base, head) => findingsCountFor(base, head, flow),
        options,
      ),
    listRunScenarios: (flow) => runStore.readScenarioIndex(root, flow),
    listRunVariants: (flow) => runStore.readVariantIndex(root, flow),
    loadRun: (flow, runId, options) => runLoad.loadRun(root, flow, runId, options),
    runDir: (flow, runId) => paths.runDir(root, flow, runId),
    beginRun: (flow) => runStore.beginRun(root, flow),
    reapAbandonedRuns: (flow) => runStore.reapAbandonedRuns(root, flow),
    resolvePair: (flow, base, head, options) =>
      runStore.resolvePair(root, flow, base, head, options),

    readDiff: (pair, engineVersion) =>
      diffStore.readDiff(root, pair.flow, pair.base, pair.head, engineVersion),
    writeDiff: (result) => diffStore.writeDiff(root, result),
    invalidateDiff: (pair) => diffStore.invalidateDiff(root, pair.flow, pair.base, pair.head),
    listStoredPairs: (flow) => diffStore.listStoredPairs(root, flow),

    appendFeedback: (input, options) => feedbackStore.appendFeedback(root, input, options),
    readPendingFeedback: (filter) => feedbackStore.readPendingFeedback(root, filter),
    ackFeedback: (ids) => feedbackStore.ackFeedback(root, ids),

    pin: (flow, runId, pinned = true) => retention.pinRun(root, flow, runId, pinned),
    keep: (flow, runId, kept = true) => retention.keepRun(root, flow, runId, kept),
    prune: (flow, runId) => retention.pruneRun(root, flow, runId),
    // Two buckets, so a run of proposals can never evict the capture history (variants spec §5).
    applyRetention: (flow) =>
      retention.pruneFlow(root, flow, {
        keepRuns: config.retention.keepRuns,
        keepVariantRuns: keepVariantRunsOf(config.retention),
      }),

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
  readRunIdentityIndex,
  readRunMeta,
  readRunMetaOrNull,
  readScenarioIndex,
  readStepResult,
  readVariantIndex,
  reapAbandonedRuns,
  resolvePair,
  runExists,
  updateRunMeta,
} from './run-store.js';
export type {
  CommittedRun,
  ListRunSummariesOptions,
  ResolvePairOptions,
  RunDraft,
  RunIdentity,
  RunMetaInput,
  ShotInput,
} from './run-store.js';
export {
  normalizeRunMeta,
  normalizeScenarioName,
  sameScenario,
  scenarioOf,
} from './internal/scenario.js';
/**
 * The variant axis of run identity (variants spec §5, D24). Exported from the store edge for the
 * same reason the scenario helpers are: the runner, the CLI and the report all need to read a run's
 * variant, and none of them may reimplement "absent means none".
 */
export {
  DEFAULT_KEEP_VARIANT_RUNS,
  VARIANT_NONE,
  captureHint,
  describeRevision,
  describeVariant,
  isEphemeralVariantRun,
  isKept,
  isVariantRun,
  keepVariantRunsOf,
  normalizeVariantMeta,
  normalizeVariantName,
  retentionBucketOf,
  runIdentityKey,
  sameRevision,
  sameVariant,
  variantOf,
} from './internal/variant.js';
export type {
  MaybeVariant,
  RetentionBucket,
  VariantConfig,
  VariantFilter,
  VariantName,
  VariantRetentionConfig,
  VariantRunMeta,
  VariantRunSummary,
} from './internal/variant.js';
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
  keepRun,
  pinRun,
  pruneAllFlows,
  pruneFlow,
  pruneRun,
  retentionCandidates,
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
