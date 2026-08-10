/**
 * `diff/` — pixel regions, DOM attribution, tree diff, annotation model (spec §5).
 *
 * The module edge is `computeDiff`: two run directories in, one `findings.json` out, plus the
 * crops and per-viewport artifacts the report reads. Everything below it is pure and individually
 * testable. Nothing here touches the network, a browser, or Playwright.
 */

/**
 * `computeDiff` is the positional edge both consumers declare (see `edge.ts`); the request-shaped
 * engine function stays available as `computeDiffRequest` for callers that want to pin `outDir`.
 */
export { computeDiff, vdiffDirOf } from './edge.js';
export {
  computeDiff as computeDiffRequest,
  diffRuns,
  defaultDiffOptions,
  CROP_PADDING,
} from './engine.js';
export type { DiffRequest, DiffContext, DiffArtifacts, DiffRunsResult } from './engine.js';

export {
  diffCacheKey,
  diffConfigFingerprint,
  diffDirFor,
  isCacheHit,
  pairId,
  readCachedDiff,
  writeDiff,
  SCENARIOLESS_PAIR,
  type CachedDiffResult,
  type DiffCacheOptions,
} from './cache.js';

/**
 * Scenario, variant and source are dimensions of *which* runs are compared, not of what a finding
 * looks like (mocking spec §6, variants §5, e2e §7). The source axis is the one exception, and a
 * narrow one: it does not change how a finding is computed, but it does change the thresholds an
 * ingested pair is computed under (`e2e-noise.ts`) and it marks every finding it produced as
 * lacking property-level detail (e2e spec §4).
 */
export {
  isMockOnly,
  labelPair,
  pairLabels,
  pairScenarios,
  pairSources,
  pairVariants,
  sourcePairLabels,
  variantPairLabels,
  PAIR_LABEL_SEVERITY,
  REPLAY_PAIR,
  SOURCE_PAIR_LABELS,
  VARIANTLESS_PAIR,
  VARIANT_PAIR_LABELS,
} from './pairing.js';
export type {
  AnyPairLabel,
  PairFlag,
  PairLabelling,
  PairSources,
  PairVariants,
  SourceAwareDiffResult,
  SourcePairLabel,
  VariantAwareDiffResult,
  VariantPairLabel,
} from './pairing.js';

/**
 * What a pair could actually *see* (e2e spec §4). The source axis itself belongs to
 * `store/internal/e2e.ts` and is deliberately not re-exported from here: one owner per axis, so the
 * store and the engine can never disagree about what a run is.
 */
export {
  fidelityOf,
  unrecognisedSource,
  unrecognisedSourceWarning,
  withoutUnbackedChanges,
  DEGRADED_CAPTURES,
  DEGRADED_REASON,
  FULL_FIDELITY,
  UNBACKED_ATTRS,
} from './fidelity.js';
export type { DegradedCapture, PairFidelity } from './fidelity.js';

/**
 * The noise-tolerant settings an ingested pair is diffed under (e2e spec §5, D27) — provisional,
 * documented, and defined in exactly one place so they stay tunable rather than becoming folklore.
 */
export { e2eNoiseSettings, resolveDiffOptions, E2E_DIFF_DEFAULTS } from './e2e-noise.js';
export type {
  E2eAwareDiffOptions,
  E2eNoiseOverrides,
  E2eNoiseSettings,
  ResolvedDiffOptions,
} from './e2e-noise.js';

/**
 * Stage 1 (the structural flow diff) is implemented in `flow/`, because spec §5 assigns "structural
 * diff of two flow versions" there. It is re-exported at this edge — not reimplemented behind it —
 * so the engine and the report can never disagree about what a step bucket means.
 */
export { describeStepChanges, isComparable, structuralFlowDiff } from '../flow/index.js';
export type { FlowDiffInput } from '../flow/index.js';

export {
  createImage,
  cropImage,
  decodePng,
  encodePng,
  pixelDiff,
  renderPixelOverlay,
  sizeOf,
  subImage,
} from './pixel.js';
export type { PixelDiffOptions } from './pixel.js';

export { clusterRegions, connectedComponents, DEFAULT_PROXIMITY } from './regions.js';
export type { ClusterOptions, ClusterResult } from './regions.js';

export { attributeRegion, attributeSide, buildIndex, CONTAIN_TOLERANCE } from './attribution.js';
export type { Attribution, IndexedNode, SideAttribution } from './attribution.js';

export { matchNodes } from './nodeMatch.js';
export type { NodeMatch, NodePair } from './nodeMatch.js';

export { attrChanges, diffNodePair, diffNodePairs, rectChanged, styleChanges, RECT_EPSILON } from './nodeDiff.js';

export {
  classifyNodeChange,
  contrastRegression,
  effectiveBackground,
  isSubPixelStyleChange,
  lostAccessibleName,
  maxLengthDelta,
  nodeContrast,
  CONTRAST_MIN,
  LAYOUT_SHIFT_PX,
  SMALL_LENGTH_DELTA_PX,
} from './severity.js';
export type { ContrastContext, Verdict } from './severity.js';

export {
  consoleFindings,
  networkFindings,
  normalizeRequestUrl,
  structuralFindings,
} from './findings.js';

export { diffViewport, exclusionRects } from './viewportDiff.js';
export type { ShotSide, ViewportDiffInput, ViewportDiffOutput } from './viewportDiff.js';

export { loadRunDir } from './loadRun.js';
export type { LoadedRunResult } from './loadRun.js';

export { matchesAny, matchesSelector, isSupportedSelector, selectorFor } from './selector.js';
export { contrastRatio, parseCssColor, relativeLuminance } from './color.js';
export type { Rgba } from './color.js';
