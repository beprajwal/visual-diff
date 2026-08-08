/**
 * Module edge for `report/` (spec §5, §9).
 *
 * `serveReport(config, options)` is what `vdiff serve` calls. It binds the report server to the two
 * things the server itself refuses to know about: where the diff engine lives, and how this
 * platform opens a browser window.
 *
 * `--open` is handled here rather than in the CLI because launching a browser is platform detail
 * and the CLI holds no domain logic. It is also the *only* process this module ever spawns, it is
 * spawned by the operator's own command line, and nothing reachable from an HTTP request can get
 * to it — the page still executes nothing (D6, spec §9).
 */

import { spawn } from 'node:child_process';

import type { Config, ServeOptions } from '../types.js';
import { computeDiff } from '../diff/index.js';
import { startReportServer, type ReportServer } from './server/server.js';

export {
  serveReport as startReportServerWithOptions,
  startReportServer,
  DEFAULT_HOST,
  SERVE_INFO_FILE,
} from './server/server.js';
export type { ReportServer, ReportServerOptions } from './server/server.js';

export { createFsStore, FsReportStore, toRunSummary, isValidFlowName, isValidRunId } from './server/store-reader.js';
export type { ComputeDiffFn, FeedbackDraft, FlowInfo, ReportStore } from './server/deps.js';

export { createDiffService, isBackfillRequired } from './server/diff-service.js';
export type { DiffService, DiffServiceOptions } from './server/diff-service.js';

export { createRunWatcher, announceRun, parseRunMetaPath } from './server/watcher.js';
export type { RunWatcher, RunWatcherOptions } from './server/watcher.js';

export { SseHub, formatEvent } from './server/sse.js';
export { createSessionToken } from './server/auth.js';
export { HttpError } from './server/http.js';

/** Best-effort `--open`. A browser that will not start is never a reason to fail `vdiff serve`. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* no browser here; the URL is printed either way */
  }
}

/**
 * Start the live report. The returned handle is exactly what `cli/ports.ts#ServeHandle` declares:
 * the `ServeInfo` that was written to `serve.json`, and a `close()` that releases the port and
 * removes that file.
 */
export async function serveReport(
  config: Config,
  options: ServeOptions = {},
): Promise<ReportServer> {
  const server = await startReportServer({
    config,
    computeDiff,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.flow === undefined ? {} : { flow: options.flow }),
  });
  if (options.open === true) openInBrowser(server.url);
  return server;
}
