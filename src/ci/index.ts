/**
 * ci — the module edge for CI mode (CI spec §7).
 *
 * Two things and no third: render a stored diff (`renderComment`), and write it out as a portable
 * bundle (`exportBundle`). Both are pure functions of the store's contents plus URLs the caller
 * supplies; neither opens a socket, holds a token, or knows what a pull request is (D29). Posting,
 * pushing and uploading belong to whatever transports the result — for GitHub, the composite action
 * in `action.yml`.
 *
 * Nothing here imports the CLI, the runner or the report server. `store/paths.ts` is the only edge it
 * reaches for, and only to find images the diff engine already recorded the location of.
 */

export {
  DEFAULT_MAX_FINDINGS,
  DEFAULT_MAX_IMAGES,
  MAX_COMMENT_BYTES,
  markerFor,
  renderComment,
  renderCommentWithGate,
} from './comment.js';
export type { CommentDocument, CommentInput } from './comment.js';

export { GATE_LEVELS, GATE_NONE, evaluateGate, isGateLevel } from './gate.js';
export type { GateLevel, GateVerdict } from './gate.js';

export {
  BUNDLE_FILES,
  CROPS_DIR,
  IMAGES_DIR,
  IMAGE_SELECTIONS,
  allFindings,
  cropPath,
  isImageSelection,
  selectCells,
  shotCells,
  shotPath,
  sortFindings,
  stepScopedFindings,
} from './layout.js';
export type { ImageSelection, ShotCell, ShotSide } from './layout.js';

export { exportBundle } from './export.js';
export type { BundleRunInfo, BundleSummary, ExportReport, ExportRequest } from './export.js';

export { escapeHtml, renderReportPage } from './report-html.js';
export type { ReportPageInput } from './report-html.js';
