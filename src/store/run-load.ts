/**
 * store/run-load — a run directory loaded into memory (`LoadedRun`).
 *
 * This is the **only** way the diff engine reads a run (plan §3): the engine never touches the
 * runner, and never joins a store path itself.
 *
 * Loading is deliberately forgiving about missing blobs. A pruned run keeps only `meta.json` and
 * `flow.snapshot.yaml` (spec §6 retention), and a blocked or non-shooting step never produced a
 * shot at all, so an absent screenshot is normal data, not an error. Steps are returned in
 * `flow.snapshot.yaml` order — ordering lives only there, never in directory names.
 */

import * as path from 'node:path';

import { StoreError } from './errors.js';
import { pathExists, readJsonOrNull, readTextOrNull } from './internal/fs.js';
import { normalizeRunMeta } from './internal/scenario.js';
import { normalizeVariantMeta } from './internal/variant.js';
import * as paths from './paths.js';
import { parseFlowSnapshot } from './snapshot.js';
import type {
  A11ySnapshot,
  ConsoleEntry,
  DomSnapshot,
  LoadedRun,
  LoadedShot,
  LoadedStep,
  NetworkEntry,
  RunId,
  RunMeta,
  ShotResult,
  StepId,
  StepResult,
  ViewportId,
} from '../types.js';

export interface LoadRunOptions {
  /** Skip `dom.json` / `a11y.json` decoding when only metadata is wanted (the report timeline). */
  shots?: boolean;
}

export async function loadRun(
  root: string,
  flow: string,
  runId: RunId,
  options: LoadRunOptions = {},
): Promise<LoadedRun> {
  return loadRunDir(paths.runDir(root, flow, runId), options);
}

export async function loadRunDir(
  runDirectory: string,
  options: LoadRunOptions = {},
): Promise<LoadedRun> {
  const withShots = options.shots ?? true;

  const stored = await readJsonOrNull<RunMeta>(path.join(runDirectory, paths.META_FILENAME));
  if (stored === null) {
    throw new StoreError('unknown-run', `${runDirectory} has no ${paths.META_FILENAME}`);
  }
  // A slice-1 run has no `scenario` key and a pre-variants run has no `variant` key; in memory both
  // are the reserved `none` (mocking spec §6, variants spec §5).
  const meta = normalizeVariantMeta(normalizeRunMeta(stored));
  const snapshotText = await readTextOrNull(
    path.join(runDirectory, paths.FLOW_SNAPSHOT_FILENAME),
  );
  if (snapshotText === null) {
    throw new StoreError(
      'missing-snapshot',
      `${runDirectory} has no ${paths.FLOW_SNAPSHOT_FILENAME}`,
    );
  }
  const flowSnapshot = parseFlowSnapshot(snapshotText);

  const steps: LoadedStep[] = [];
  const stepsById: Record<StepId, LoadedStep> = {};

  for (const [index, specStep] of flowSnapshot.steps.entries()) {
    const loaded = await loadStep(runDirectory, meta, specStep.id, index, specStep.shoot, withShots);
    steps.push(loaded);
    stepsById[specStep.id] = loaded;
  }

  return { runDir: runDirectory, meta, flow: flowSnapshot, steps, stepsById };
}

async function loadStep(
  runDirectory: string,
  meta: RunMeta,
  id: StepId,
  index: number,
  shootFromSpec: boolean | undefined,
  withShots: boolean,
): Promise<LoadedStep> {
  const resultPath = paths.resolveInsideRun(runDirectory, paths.relStepResult(id));
  const stored = await readJsonOrNull<StepResult>(resultPath);
  const result: StepResult = stored ?? syntheticStepResult(meta, id, index, shootFromSpec ?? true);

  const shots: Record<ViewportId, LoadedShot> = {};
  if (withShots) {
    const shotEntries = Object.entries(result.viewports ?? {}) as Array<
      [ViewportId, ShotResult | undefined]
    >;
    for (const [viewport, shot] of shotEntries) {
      if (shot === undefined) continue;
      const screenshotPath = paths.resolveInsideRun(runDirectory, shot.screenshot);
      const dom = await readJsonOrNull<DomSnapshot>(
        paths.resolveInsideRun(runDirectory, shot.dom),
      );
      // A shot without its DOM snapshot cannot be attributed, and a shot without its screenshot
      // cannot be pixel-diffed; either way the pair is "missing" rather than broken.
      if (dom === null || !(await pathExists(screenshotPath))) continue;
      const a11y = await readJsonOrNull<A11ySnapshot>(
        paths.resolveInsideRun(runDirectory, shot.a11y),
      );
      shots[viewport] = {
        viewport,
        screenshotPath,
        dom,
        a11y,
        size: { w: shot.width, h: shot.height },
      };
    }
  }

  const consoleEntries =
    (await readJsonOrNull<ConsoleEntry[]>(
      paths.resolveInsideRun(runDirectory, paths.relStepConsole(id)),
    )) ?? [];
  const networkEntries =
    (await readJsonOrNull<NetworkEntry[]>(
      paths.resolveInsideRun(runDirectory, paths.relStepNetwork(id)),
    )) ?? [];

  return { result, shots, console: consoleEntries, network: networkEntries };
}

/**
 * A step named by the snapshot with no `step.json` on disk: pruned, or never reached. Returning a
 * placeholder keeps `LoadedRun` rectangular, which is what lets the report render explicit blocked
 * cells instead of a truncated flow (spec §7).
 */
function syntheticStepResult(
  meta: RunMeta,
  id: StepId,
  index: number,
  shoot: boolean,
): StepResult {
  return {
    id,
    index,
    status: 'skipped',
    shoot,
    startedAt: meta.startedAt,
    finishedAt: meta.startedAt,
    durationMs: 0,
    viewports: {},
    truncated: false,
    consoleErrors: 0,
    networkRequests: 0,
    harMisses: 0,
  };
}
