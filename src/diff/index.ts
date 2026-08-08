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
  type CachedDiffResult,
  type DiffCacheOptions,
} from './cache.js';

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
