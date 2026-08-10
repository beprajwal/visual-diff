/**
 * store — module edge (plan §3).
 *
 * The on-disk store *is* the interface between modules (spec §5): the runner writes runs through
 * it, the diff engine reads runs through it, the report reads both through it, and none of them
 * joins a store path itself. `openStore(config)` binds a project root once and hands back that
 * whole surface.
 */

import * as diffStore from './diff-store.js';
import * as e2eMap from './e2e-map.js';
import * as feedbackStore from './feedback-store.js';
import * as lockModule from './lock.js';
import * as paths from './paths.js';
import * as retention from './retention.js';
import * as revision from './revision.js';
import * as runLoad from './run-load.js';
import * as runStore from './run-store.js';
import { parseFlowSnapshot, serializeFlowSnapshot } from './snapshot.js';
import { keepE2eRunsOf } from './internal/e2e.js';
import type { E2eRunInfo, E2eRunSummary, RunSource } from './internal/e2e.js';
import { keepVariantRunsOf } from './internal/variant.js';
import type { VariantName } from './internal/variant.js';
import type { E2eMap } from './e2e-map.js';
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
  listRuns(flow: string, options?: ListRunSummariesOptions): Promise<E2eRunSummary[]>;
  /** The scenario each run of the flow was captured under (mocking spec §6). */
  listRunScenarios(flow: string): Promise<Map<RunId, ScenarioName>>;
  /** The variant each run of the flow was captured under (variants spec §5). */
  listRunVariants(flow: string): Promise<Map<RunId, VariantName>>;
  /** The source each run of the flow came from (e2e spec §7). */
  listRunSources(flow: string): Promise<Map<RunId, RunSource>>;
  /** The e2e block of every ingested run of the flow (e2e spec §7). */
  listE2eRuns(flow: string): Promise<Map<RunId, E2eRunInfo>>;
  /**
   * The run one archive was already ingested as, or null — the idempotency check `vdiff e2e` makes
   * before writing anything (e2e spec §6).
   */
  findRunByTraceHash(flow: string, traceHash: string): Promise<RunId | null>;
  /**
   * Normalised test title → the flow it is already ingested into (e2e spec D26). What keeps flow
   * names stable across ingests: a title that has been seen before never gets a new name.
   */
  e2eFlowIndex(): Promise<Map<string, string>>;
  /** `.visual-diff/e2e-map.yaml`, or an empty map when the project has none (e2e spec D26). */
  loadE2eMap(): Promise<E2eMap>;
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
    listRunSources: (flow) => runStore.readSourceIndex(root, flow),
    listE2eRuns: (flow) => runStore.readE2eIndex(root, flow),
    findRunByTraceHash: (flow, traceHash) => runStore.findRunByTraceHash(root, flow, traceHash),
    e2eFlowIndex: () => runStore.readE2eFlowIndex(root),
    loadE2eMap: () => e2eMap.loadE2eMapOrThrow(root),
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
    // Three buckets, so neither a run of proposals nor a CI run's worth of ingested traces can
    // ever evict the capture history (variants spec §5, e2e spec §7).
    applyRetention: (flow) =>
      retention.pruneFlow(root, flow, {
        keepRuns: config.retention.keepRuns,
        keepVariantRuns: keepVariantRunsOf(config.retention),
        keepE2eRuns: keepE2eRunsOf(config.retention),
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
  findRunByTraceHash,
  latestRunId,
  listFlows,
  listRunIds,
  listRunSummaries,
  readE2eFlowIndex,
  readE2eIndex,
  readFlowSnapshotSource,
  readRunIdentityIndex,
  readRunMeta,
  readRunMetaOrNull,
  readScenarioIndex,
  readSourceIndex,
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
/**
 * The source axis of run identity (e2e spec §7, D27), exported from the store edge for the reason
 * the scenario and variant helpers are: the ingest command, the diff engine, the CLI and the report
 * all need to read a run's source, and none of them may reimplement "absent means replay".
 */
export {
  DEFAULT_KEEP_E2E_RUNS,
  E2E_DUPLICATE_STEP_TITLES,
  E2E_MAP_UNMATCHED,
  REVISION_UNKNOWN_SHA,
  RUN_SOURCES,
  SOURCE_E2E,
  SOURCE_REPLAY,
  UNKNOWN_REVISION,
  assertRunSourceConsistent,
  describeSource,
  duplicateStepTitlesWarning,
  e2eInfoOf,
  isE2eRun,
  isUnknownRevision,
  keepE2eRunsOf,
  normalizeE2eMeta,
  parseRunSource,
  sameSource,
  sourceOf,
  traceHashOf,
  unmatchedMapWarning,
} from './internal/e2e.js';
export type {
  DuplicateStepTitle,
  E2eConfig,
  E2eFilter,
  E2eRetentionConfig,
  E2eRunInfo,
  E2eRunMeta,
  E2eRunSummary,
  E2eRunWarning,
  E2eRunWarningKind,
  E2eSuiteMeta,
  FullRetentionConfig,
  MaybeE2e,
  RunSource,
} from './internal/e2e.js';
/**
 * Title mapping (D26): the only translation from what a trace carries — titles — to the ids the
 * diff engine needs. Exported whole because the ingest command derives names with it and the report
 * has to be able to explain a name it sees.
 */
export {
  MAX_SLUG_LENGTH,
  TITLE_SEPARATOR,
  allocateFlowName,
  assignStepIds,
  flowNameForTitle,
  normalizeTitle,
  parseLocation,
  parseTestTitle,
  sameTitle,
  slugify,
  specStem,
  splitTitle,
} from './internal/e2e-title.js';
export type { ParsedTestTitle, StepIdAssignment } from './internal/e2e-title.js';
export {
  createE2eMapper,
  emptyE2eMap,
  loadE2eMap,
  loadE2eMapOrThrow,
  parseE2eMapSource,
} from './e2e-map.js';
export type { E2eMap, E2eMapFile, E2eMapper } from './e2e-map.js';
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
