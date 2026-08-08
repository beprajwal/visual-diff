/**
 * The live channel's producer (spec §9).
 *
 * A watcher on `runs/` fires when a run completes. Because the runner publishes a run by atomically
 * renaming a temp directory into place (spec §10), the appearance of `runs/<flow>/<id>/meta.json`
 * is the completion signal — there is no half-written run to observe.
 *
 * **Diff recomputation completes before the event fires**, so the page never renders a
 * half-computed pair. That ordering is the whole point of this file: compute, then announce.
 */

import path from 'node:path';
import { watch } from 'chokidar';

import type { DiffReadyEvent, RunCompletedEvent, RunId, ServerEvent } from '../../types.js';
import type { ReportStore } from './deps.js';
import type { DiffService } from './diff-service.js';
import { isBackfillRequired } from './diff-service.js';
import { isValidFlowName, isValidRunId } from './store-reader.js';

export const META_FILE = 'meta.json';

export interface RunLocation {
  flow: string;
  runId: RunId;
}

/**
 * Recognize `runs/<flow>/<runId>/meta.json` relative to the `.visual-diff` directory. Anything
 * else — a step artefact, a diff, a feedback file — is not a completion signal.
 */
export function parseRunMetaPath(storeDir: string, absolutePath: string): RunLocation | null {
  const relative = path.relative(storeDir, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const segments = relative.split(path.sep);
  if (segments.length !== 4) return null;
  const [runs, flow, runId, file] = segments as [string, string, string, string];
  if (runs !== 'runs' || file !== META_FILE) return null;
  if (!isValidFlowName(flow) || !isValidRunId(runId)) return null;
  return { flow, runId };
}

export interface RunWatcherOptions {
  /** The `.visual-diff` directory. Watched instead of `runs/` so a missing runs/ still works. */
  storeDir: string;
  store: ReportStore;
  diffs: DiffService;
  emit: (event: ServerEvent) => void;
  now?: () => Date;
  onError?: (err: unknown) => void;
  /** chokidar write-settling window; lowered in tests. */
  stabilityThresholdMs?: number;
}

export interface RunWatcher {
  /** Resolves once the initial scan is done and new runs will be seen. */
  ready: Promise<void>;
  /** Resolves when every queued run has been processed. */
  idle(): Promise<void>;
  close(): Promise<void>;
  /** The handler the file event calls. Exposed so the ordering can be tested without chokidar. */
  onRunComplete(flow: string, runId: RunId): Promise<void>;
}

/**
 * Compute the pair, *then* announce. Emits `run` followed by `diff`; on a computation failure it
 * emits `run` followed by `error`, so a broken pair never masquerades as a fresh one.
 */
export async function announceRun(
  options: Pick<RunWatcherOptions, 'store' | 'diffs' | 'emit' | 'now' | 'onError'>,
  flow: string,
  runId: RunId,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const summary = await options.store.readRunSummary(flow, runId);
  if (!summary) return;

  const ids = await options.store.listRunIds(flow);
  const index = ids.indexOf(runId);
  const base = index > 0 ? (ids[index - 1] as RunId) : null;

  let diffEvent: DiffReadyEvent | null = null;
  let failure: unknown = null;

  if (base !== null) {
    try {
      const response = await options.diffs.get(flow, base, runId);
      if (!isBackfillRequired(response)) {
        diffEvent = {
          type: 'diff',
          ts: now().toISOString(),
          flow,
          pair: `${base}..${runId}`,
          summary: response.summary,
        };
      }
    } catch (err) {
      failure = err;
    }
  }

  const runEvent: RunCompletedEvent = {
    type: 'run',
    ts: now().toISOString(),
    flow,
    run: summary,
  };
  options.emit(runEvent);

  if (diffEvent) {
    options.emit(diffEvent);
    return;
  }
  if (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    options.emit({
      type: 'error',
      ts: now().toISOString(),
      message: `Could not diff ${base}..${runId} in flow ${flow}: ${message}`,
    });
    options.onError?.(failure);
  }
}

/** Watch the store for completed runs. */
export function createRunWatcher(options: RunWatcherOptions): RunWatcher {
  const storeDir = path.resolve(options.storeDir);
  const seen = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const onRunComplete = async (flow: string, runId: RunId): Promise<void> => {
    const key = `${flow}/${runId}`;
    if (seen.has(key)) return;
    seen.add(key);
    await announceRun(options, flow, runId);
  };

  const enqueue = (flow: string, runId: RunId): void => {
    queue = queue.then(() =>
      onRunComplete(flow, runId).catch((err: unknown) => {
        options.onError?.(err);
      }),
    );
  };

  const watcher = watch(storeDir, {
    ignoreInitial: true,
    persistent: true,
    // `.visual-diff` is depth 0, so runs/<flow>/<run>/meta.json sits at depth 4.
    depth: 4,
    followSymlinks: false,
    awaitWriteFinish: {
      stabilityThreshold: options.stabilityThresholdMs ?? 150,
      pollInterval: 50,
    },
    // Everything outside runs/ is irrelevant here, and cache/ can be enormous.
    ignored: (candidate: string) => {
      const relative = path.relative(storeDir, candidate);
      if (relative === '') return false;
      if (relative.startsWith('..')) return true;
      const top = relative.split(path.sep)[0];
      return top !== 'runs';
    },
  });

  watcher.on('add', (file: string) => {
    if (closed) return;
    const location = parseRunMetaPath(storeDir, file);
    if (!location) return;
    enqueue(location.flow, location.runId);
  });
  watcher.on('error', (err: unknown) => options.onError?.(err));

  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', () => resolve());
  });

  return {
    ready,
    onRunComplete,
    async idle() {
      await queue;
    },
    async close() {
      closed = true;
      await watcher.close();
      await queue;
    },
  };
}
