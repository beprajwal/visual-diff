/**
 * Report server module edge (spec §5).
 *
 * `vdiff serve` calls {@link serveReport} with a loaded `Config`, the diff engine's `computeDiff`,
 * and nothing else. Everything the server can do is behind the ports in `deps.ts`: read the store,
 * compute a diff, append one line of feedback.
 */

export { serveReport, startReportServer, DEFAULT_HOST, SERVE_INFO_FILE } from './server.js';
export type { ReportServer, ReportServerOptions } from './server.js';

export { createFsStore, FsReportStore, toRunSummary, isValidFlowName, isValidRunId } from './store-reader.js';
export type { ComputeDiffFn, FeedbackDraft, FlowInfo, ReportStore } from './deps.js';

export { createDiffService, isBackfillRequired } from './diff-service.js';
export type { DiffService, DiffServiceOptions } from './diff-service.js';

export { createRunWatcher, announceRun, parseRunMetaPath } from './watcher.js';
export type { RunWatcher, RunWatcherOptions } from './watcher.js';

export { SseHub, formatEvent } from './sse.js';
export { createSessionToken } from './auth.js';
export { HttpError } from './http.js';
