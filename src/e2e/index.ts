/**
 * Module edge for `e2e/` (e2e spec §2, §4, §7, §8).
 *
 * E2E mode ingests artifacts an existing suite already produced. This module is the ingestion half:
 * archive in, `E2eIngest` out, plus the conversion into the shot payload the diff engine consumes.
 * It writes nothing, runs nothing, and knows nothing about the store — deciding what a run looks
 * like on disk is the ingest layer's job, and `vdiff e2e` is the CLI's.
 *
 * Nothing outside this module reaches past this file. In particular `playwright/` is private: the
 * point of §2's format-agnostic seam is that a second reader can be added without any consumer
 * learning what a `frame-snapshot` is, and every consumer that imports `playwright/reader.js`
 * directly is a place that would have to change when one is.
 *
 * The one thing this layer deliberately does **not** own is `.visual-diff/e2e-map.yaml`. The map's
 * parsing, its stale-entry warning (§8) and its `ignore` list are about a project's configuration,
 * not about a trace's contents; `E2eReadOptions.stepIds` takes the resolved mapping as data instead.
 */

export {
  E2E_MISSING_CAPABILITIES,
  E2E_NOTICE_KINDS,
  E2E_SOURCE_FORMATS,
  type E2eCapabilities,
  type E2eCaptureMetadata,
  type E2eConsoleEntry,
  type E2eDom,
  type E2eDomNode,
  type E2eIngest,
  type E2eMissingCapability,
  type E2eNetworkEntry,
  type E2eNodeState,
  type E2eNotice,
  type E2eNoticeKind,
  type E2eReadOptions,
  type E2eShot,
  type E2eSniffResult,
  type E2eSourceFormat,
  type E2eSourceReader,
  type E2eStep,
  type E2eStepOrigin,
  type E2eStepTitleSource,
  type E2eTest,
} from './types.js';

export {
  E2E_ERROR_CODES,
  E2eError,
  archiveUnreadable,
  isE2eError,
  noScreenshots,
  notATrace,
  traceCorrupt,
  traceVersionUnsupported,
  type E2eErrorCode,
} from './errors.js';

export {
  MAX_FLOW_NAME_LENGTH,
  SAFE_NAME_RE,
  TITLE_SEPARATOR,
  assignStepIds,
  flowNameFromTitle,
  parseTestTitle,
  shortHash,
  slugify,
  stepIdFromTitle,
  titleKeyOf,
  type AssignedStepIds,
  type ParsedTestTitle,
  type StepIdInput,
} from './titles.js';

export {
  UNAVAILABLE_A11Y,
  UNAVAILABLE_RECT,
  UNAVAILABLE_STYLES,
  toDomSnapshot,
  toShotPayload,
  toShotPayloads,
  type E2eShotPayload,
} from './to-shots.js';

export { readJpegSize, isJpeg, type JpegSize } from './jpeg.js';

export {
  MAX_TRACE_VERSION,
  MIN_TRACE_VERSION,
  SUPPORTED_TRACE_VERSIONS,
  UNDECLARED_TRACE_VERSION,
  isSupportedTraceVersion,
} from './playwright/version.js';

export { PlaywrightTraceReader, playwrightTraceReader } from './playwright/reader.js';

export { readSource, readerFor, readers } from './registry.js';

export { decodeJpeg, encodePng, frameToPng, isPng, readPngSize, ImageDecodeError } from './image.js';
export type { ConvertedFrame, DecodedImage } from './image.js';

export { discoverArchives, hasMagic, segmentMatcher } from './discover.js';

/**
 * The ingest half of the slice: the two calls `cli/deps.ts` binds `MODULE_SPECIFIERS.e2e` to.
 *
 * They live behind this edge with the reader rather than in `store/` because ingesting is a decision
 * about *what a run should be*, and the store's job is to hold whatever it is told to. The direction
 * of the dependency follows: `ingest.ts` imports `store/index.js`, and nothing in `store/` knows this
 * module exists.
 */
export { planIngest, ingestTraces, E2E_FROM_KINDS } from './ingest.js';
export type {
  E2eArchivePlan,
  E2eFromKind,
  E2eIngestPlan,
  E2eIngestReport,
  E2eIngestRequest,
  E2eIngestedRun,
} from './ingest.js';
