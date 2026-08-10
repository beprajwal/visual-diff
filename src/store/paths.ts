/**
 * store/paths — every path in the spec §6 tree, constructed in exactly one place.
 *
 * ```
 * .visual-diff/
 *   config.yaml
 *   flows/<flow>.yaml, <flow>.har
 *   runs/<flow>/<runId>/meta.json
 *                      /flow.snapshot.yaml
 *                      /steps/<stepId>/step.json
 *                                     /<viewport>/{screenshot.png, dom.json, a11y.json}
 *                                     /console.json
 *                                     /network.json
 *   diffs/<flow>/<base>..<head>/findings.json
 *                              /crops/<findingId>.png
 *                              /steps/<stepId>/<viewport>/{pixel.png, regions.json}
 *   feedback/pending.jsonl
 *            archive/<YYYY-MM-DD>.jsonl
 *   cache/deps/<lockfile-sha>/
 *         worktrees/<sha>/
 *   .locks/<flow>.lock
 * ```
 *
 * **Step directories are keyed by step id, never by ordinal** (spec §6): inserting a step must not
 * rename every directory after it, which would make every historical run appear changed. Ordering
 * lives only in `flow.snapshot.yaml`.
 *
 * Two flavours of path appear in the contracts and both are produced here:
 * - paths inside `StepResult`/`ShotResult` are **relative to the run directory**;
 * - paths inside `ViewportDiff`/`Finding`/`FeedbackEntry` are **relative to `.visual-diff/`**.
 */

import * as path from 'node:path';

import { StoreError } from './errors.js';
import { pairId } from './internal/id.js';
import type { PairId, RunId, StepId, ViewportId } from '../types.js';

export const VISUAL_DIFF_DIRNAME = '.visual-diff';
export const CONFIG_FILENAME = 'config.yaml';
/** Title pins and ignore list for ingested runs (e2e spec D26, §5). Optional; absent is normal. */
export const E2E_MAP_FILENAME = 'e2e-map.yaml';
export const META_FILENAME = 'meta.json';
export const FLOW_SNAPSHOT_FILENAME = 'flow.snapshot.yaml';
export const STEP_RESULT_FILENAME = 'step.json';
export const CONSOLE_FILENAME = 'console.json';
export const NETWORK_FILENAME = 'network.json';
export const SCREENSHOT_FILENAME = 'screenshot.png';
export const DOM_FILENAME = 'dom.json';
export const A11Y_FILENAME = 'a11y.json';
export const FINDINGS_FILENAME = 'findings.json';
export const PIXEL_FILENAME = 'pixel.png';
export const REGIONS_FILENAME = 'regions.json';
export const PENDING_FEEDBACK_FILENAME = 'pending.jsonl';
export const SERVE_INFO_FILENAME = 'serve.json';
export const INSTALL_LOG_FILENAME = 'install.log';
export const SERVER_LOG_FILENAME = 'server.log';

/** Prefix of an in-flight run directory. Never matched by `isRunId`, so listings skip it. */
export const TEMP_PREFIX = '.tmp-';

/* ------------------------------------------------------------------ segment safety */

// Path separators, control characters, and the characters Windows reserves in a filename.
// Hyphens, underscores and dots *inside* a name are fine: `pay-form` is the spec's own example.
const RESERVED_CHARS = '/\\:*?"<>|';

function hasUnsafeChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
    if (RESERVED_CHARS.includes(ch)) return true;
  }
  return false;
}

/**
 * Guard every user-supplied name that becomes a path segment. Flow names, step ids and viewport
 * ids come from YAML the tool did not write, so `../` must never reach `path.join`.
 */
export function assertSafeSegment(kind: string, value: string): string {
  if (value === '' || value === '.' || value === '..') {
    throw new StoreError('unsafe-name', `${kind} "${value}" is not a usable directory name`);
  }
  if (hasUnsafeChar(value)) {
    throw new StoreError(
      'unsafe-name',
      `${kind} "${value}" contains a path separator or control character`,
    );
  }
  if (value.startsWith('.')) {
    throw new StoreError('unsafe-name', `${kind} "${value}" may not start with a dot`);
  }
  return value;
}

export function isSafeSegment(value: string): boolean {
  try {
    assertSafeSegment('name', value);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ roots */

export function vdiffDir(root: string): string {
  return path.join(root, VISUAL_DIFF_DIRNAME);
}

export function configFile(root: string): string {
  return path.join(vdiffDir(root), CONFIG_FILENAME);
}

export function e2eMapFile(root: string): string {
  return path.join(vdiffDir(root), E2E_MAP_FILENAME);
}

export function serveInfoFile(root: string): string {
  return path.join(vdiffDir(root), SERVE_INFO_FILENAME);
}

/* ------------------------------------------------------------------ flows */

export function flowsDir(root: string): string {
  return path.join(vdiffDir(root), 'flows');
}

export function flowFile(root: string, flow: string): string {
  return path.join(flowsDir(root), `${assertSafeSegment('flow', flow)}.yaml`);
}

/** Path of the flow spec inside the repository, as `git show <sha>:<path>` wants it (spec §7). */
export function flowFileRepoPath(flow: string): string {
  return `${VISUAL_DIFF_DIRNAME}/flows/${assertSafeSegment('flow', flow)}.yaml`;
}

export function harFile(root: string, harName: string): string {
  return path.join(flowsDir(root), assertSafeSegment('har', harName));
}

/* ------------------------------------------------------------------ runs */

export function runsDir(root: string): string {
  return path.join(vdiffDir(root), 'runs');
}

export function flowRunsDir(root: string, flow: string): string {
  return path.join(runsDir(root), assertSafeSegment('flow', flow));
}

export function runDir(root: string, flow: string, runId: RunId): string {
  return path.join(flowRunsDir(root, flow), assertSafeSegment('run id', runId));
}

export function runMetaFile(root: string, flow: string, runId: RunId): string {
  return path.join(runDir(root, flow, runId), META_FILENAME);
}

export function runFlowSnapshotFile(root: string, flow: string, runId: RunId): string {
  return path.join(runDir(root, flow, runId), FLOW_SNAPSHOT_FILENAME);
}

export function runStepsDir(root: string, flow: string, runId: RunId): string {
  return path.join(runDir(root, flow, runId), 'steps');
}

export function stepDir(root: string, flow: string, runId: RunId, step: StepId): string {
  return path.join(runStepsDir(root, flow, runId), assertSafeSegment('step id', step));
}

export function stepResultFile(root: string, flow: string, runId: RunId, step: StepId): string {
  return path.join(stepDir(root, flow, runId, step), STEP_RESULT_FILENAME);
}

export function stepViewportDir(
  root: string,
  flow: string,
  runId: RunId,
  step: StepId,
  viewport: ViewportId,
): string {
  return path.join(stepDir(root, flow, runId, step), assertSafeSegment('viewport', viewport));
}

/* -- paths inside a run directory, relative to it (what StepResult/ShotResult carry) -- */

export function relStepDir(step: StepId): string {
  return `steps/${assertSafeSegment('step id', step)}`;
}

export function relStepResult(step: StepId): string {
  return `${relStepDir(step)}/${STEP_RESULT_FILENAME}`;
}

export function relStepConsole(step: StepId): string {
  return `${relStepDir(step)}/${CONSOLE_FILENAME}`;
}

export function relStepNetwork(step: StepId): string {
  return `${relStepDir(step)}/${NETWORK_FILENAME}`;
}

export function relShotDir(step: StepId, viewport: ViewportId): string {
  return `${relStepDir(step)}/${assertSafeSegment('viewport', viewport)}`;
}

export interface RelShotPaths {
  screenshot: string;
  dom: string;
  a11y: string;
}

export function relShotPaths(step: StepId, viewport: ViewportId): RelShotPaths {
  const dir = relShotDir(step, viewport);
  return {
    screenshot: `${dir}/${SCREENSHOT_FILENAME}`,
    dom: `${dir}/${DOM_FILENAME}`,
    a11y: `${dir}/${A11Y_FILENAME}`,
  };
}

/** Failure artefacts for a step that threw (spec §7): kept beside the step's shots. */
export function relFailureScreenshot(step: StepId): string {
  return `${relStepDir(step)}/failure.png`;
}

export function relFailureDom(step: StepId): string {
  return `${relStepDir(step)}/failure.dom.json`;
}

export function relRunLog(name: string): string {
  return assertSafeSegment('log name', name);
}

export function runLogFile(root: string, flow: string, runId: RunId, name: string): string {
  return path.join(runDir(root, flow, runId), relRunLog(name));
}

/* ------------------------------------------------------------------ diffs */

export function diffsDir(root: string): string {
  return path.join(vdiffDir(root), 'diffs');
}

export function flowDiffsDir(root: string, flow: string): string {
  return path.join(diffsDir(root), assertSafeSegment('flow', flow));
}

export function pairDirname(base: RunId, head: RunId): string {
  return pairId(assertSafeSegment('run id', base), assertSafeSegment('run id', head));
}

export function diffDir(root: string, flow: string, base: RunId, head: RunId): string {
  return path.join(flowDiffsDir(root, flow), pairDirname(base, head));
}

export function diffFindingsFile(root: string, flow: string, base: RunId, head: RunId): string {
  return path.join(diffDir(root, flow, base, head), FINDINGS_FILENAME);
}

export function diffCropsDir(root: string, flow: string, base: RunId, head: RunId): string {
  return path.join(diffDir(root, flow, base, head), 'crops');
}

export function diffCropFile(
  root: string,
  flow: string,
  base: RunId,
  head: RunId,
  findingId: string,
): string {
  return path.join(
    diffCropsDir(root, flow, base, head),
    `${assertSafeSegment('finding id', findingId)}.png`,
  );
}

export function diffStepViewportDir(
  root: string,
  flow: string,
  base: RunId,
  head: RunId,
  step: StepId,
  viewport: ViewportId,
): string {
  return path.join(
    diffDir(root, flow, base, head),
    'steps',
    assertSafeSegment('step id', step),
    assertSafeSegment('viewport', viewport),
  );
}

/* -- diff paths relative to `.visual-diff/`, which is what ViewportDiff and Finding carry -- */

export function relDiffDir(flow: string, base: RunId, head: RunId): string {
  return `diffs/${assertSafeSegment('flow', flow)}/${pairDirname(base, head)}`;
}

export function relDiffCrop(flow: string, base: RunId, head: RunId, findingId: string): string {
  return `${relDiffDir(flow, base, head)}/crops/${assertSafeSegment('finding id', findingId)}.png`;
}

export function relDiffStepViewportDir(
  flow: string,
  base: RunId,
  head: RunId,
  step: StepId,
  viewport: ViewportId,
): string {
  return `${relDiffDir(flow, base, head)}/steps/${assertSafeSegment(
    'step id',
    step,
  )}/${assertSafeSegment('viewport', viewport)}`;
}

export function relDiffPixel(
  flow: string,
  base: RunId,
  head: RunId,
  step: StepId,
  viewport: ViewportId,
): string {
  return `${relDiffStepViewportDir(flow, base, head, step, viewport)}/${PIXEL_FILENAME}`;
}

export function relDiffRegions(
  flow: string,
  base: RunId,
  head: RunId,
  step: StepId,
  viewport: ViewportId,
): string {
  return `${relDiffStepViewportDir(flow, base, head, step, viewport)}/${REGIONS_FILENAME}`;
}

/* ------------------------------------------------------------------ feedback */

export function feedbackDir(root: string): string {
  return path.join(vdiffDir(root), 'feedback');
}

export function feedbackPendingFile(root: string): string {
  return path.join(feedbackDir(root), PENDING_FEEDBACK_FILENAME);
}

export function feedbackArchiveDir(root: string): string {
  return path.join(feedbackDir(root), 'archive');
}

/** `date` is a `YYYY-MM-DD` day stamp, matching the spec §6 example. */
export function feedbackArchiveFile(root: string, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new StoreError('unsafe-name', `feedback archive date "${date}" is not YYYY-MM-DD`);
  }
  return path.join(feedbackArchiveDir(root), `${date}.jsonl`);
}

/* ------------------------------------------------------------------ cache and locks */

export function cacheDir(root: string): string {
  return path.join(vdiffDir(root), 'cache');
}

export function depsCacheRoot(root: string): string {
  return path.join(cacheDir(root), 'deps');
}

export function depsCacheDir(root: string, lockfileSha: string): string {
  return path.join(depsCacheRoot(root), assertSafeSegment('lockfile hash', lockfileSha));
}

export function worktreesRoot(root: string): string {
  return path.join(cacheDir(root), 'worktrees');
}

export function worktreeDir(root: string, sha: string): string {
  return path.join(worktreesRoot(root), assertSafeSegment('sha', sha));
}

export function locksDir(root: string): string {
  return path.join(vdiffDir(root), '.locks');
}

export function lockFile(root: string, flow: string): string {
  return path.join(locksDir(root), `${assertSafeSegment('flow', flow)}.lock`);
}

/* ------------------------------------------------------------------ resolution */

/**
 * Resolve a store-relative path (the form carried by `ViewportDiff.pixelPath`, `Finding.crop`,
 * `FeedbackEntry.crop`) to an absolute path, refusing anything that escapes `.visual-diff/`.
 * The report's blob route depends on this.
 */
export function resolveInsideVdiff(root: string, relative: string): string {
  if (path.isAbsolute(relative)) {
    throw new StoreError('unsafe-path', `"${relative}" must be relative to ${VISUAL_DIFF_DIRNAME}`);
  }
  const base = vdiffDir(root);
  const resolved = path.resolve(base, relative);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (resolved !== base && !resolved.startsWith(withSep)) {
    throw new StoreError('unsafe-path', `"${relative}" escapes ${VISUAL_DIFF_DIRNAME}`);
  }
  return resolved;
}

/** Inverse of `resolveInsideVdiff`, with POSIX separators so stored paths are portable. */
export function toVdiffRelative(root: string, absolute: string): string {
  const rel = path.relative(vdiffDir(root), absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new StoreError('unsafe-path', `"${absolute}" is outside ${VISUAL_DIFF_DIRNAME}`);
  }
  return rel.split(path.sep).join('/');
}

/** Inverse for run-relative paths (`ShotResult.screenshot` and friends). */
export function resolveInsideRun(runDirectory: string, relative: string): string {
  if (path.isAbsolute(relative)) {
    throw new StoreError('unsafe-path', `"${relative}" must be relative to the run directory`);
  }
  const resolved = path.resolve(runDirectory, relative);
  const withSep = runDirectory.endsWith(path.sep) ? runDirectory : runDirectory + path.sep;
  if (resolved !== runDirectory && !resolved.startsWith(withSep)) {
    throw new StoreError('unsafe-path', `"${relative}" escapes the run directory`);
  }
  return resolved;
}

export type { PairId, RunId, StepId, ViewportId };
