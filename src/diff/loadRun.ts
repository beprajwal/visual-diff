/**
 * Reads a run directory off disk into the in-memory `LoadedRun` the engine consumes (spec §6 layout).
 *
 * Deliberately forgiving: a pruned run keeps `meta.json` and `flow.snapshot.yaml` but loses its
 * blobs, and a partial run can be missing whole steps. Anything absent becomes a warning plus a
 * `missing` marker downstream, never a throw — the report has to render a full rectangular grid
 * with explicit blocked cells rather than erroring out.
 *
 * NOTE: run loading belongs to `src/store` long-term. This local reader keeps the diff engine
 * self-contained and testable from bare directories; `diffRuns` takes `LoadedRun` values, so the
 * store can feed it directly once it lands.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { normalizeRunMeta } from '../store/internal/scenario.js';
import { normalizeVariantMeta } from '../store/internal/variant.js';
import { normalizeE2eMeta } from '../store/internal/e2e.js';
import { unrecognisedSourceWarning } from './fidelity.js';
import type {
  A11ySnapshot,
  ConsoleEntry,
  DomSnapshot,
  FlowSnapshot,
  LoadedRun,
  LoadedShot,
  LoadedStep,
  NetworkEntry,
  RunMeta,
  Step,
  StepId,
  StepResult,
  ViewportId,
} from '../types.js';

export interface LoadedRunResult {
  run: LoadedRun;
  warnings: string[];
}

const VIEWPORT_DIR = /^\d+x\d+$/;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function readDirs(p: string): Promise<string[]> {
  try {
    const entries = await readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function emptyDom(step: StepId, viewport: ViewportId): DomSnapshot {
  return {
    step,
    viewport,
    url: '',
    capturedAt: new Date(0).toISOString(),
    deviceScaleFactor: 1,
    document: { w: 0, h: 0 },
    nodeCount: 0,
    truncated: false,
    masks: [],
    nodes: [],
  };
}

function synthesizeStepResult(id: StepId, index: number, at: string): StepResult {
  return {
    id,
    index,
    status: 'skipped',
    shoot: false,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    viewports: {},
    truncated: false,
    consoleErrors: 0,
    networkRequests: 0,
    harMisses: 0,
  };
}

export async function loadRunDir(runDir: string): Promise<LoadedRunResult> {
  const warnings: string[] = [];
  const stored = await readJson<RunMeta>(path.join(runDir, 'meta.json'));
  if (stored === null) throw new Error(`run directory has no readable meta.json: ${runDir}`);
  // A slice-1 meta.json has no `scenario` key, a pre-variants one has no `variant` key and a
  // pre-e2e one has no `source` key; all three must stay readable, and in memory they read as
  // `none`, `none` and `replay` — which is what makes the pair labelling decidable for every run
  // on all three axes (mocking spec §6, variants spec §5, e2e spec §7).
  // Read off `stored`, before normalisation, because that is the only point at which the value the
  // file actually holds still exists: `normalizeE2eMeta` replaces an unreadable one with `replay`
  // so downstream code never handles a source it cannot name. Emitting it here — rather than from
  // `labelPair`, which sees the normalised meta — keeps one emitter for one fact.
  const unreadableSource = unrecognisedSourceWarning(stored);
  if (unreadableSource !== null) warnings.push(unreadableSource);

  const meta = normalizeE2eMeta(normalizeVariantMeta(normalizeRunMeta(stored)));

  let flow: FlowSnapshot | null = null;
  const snapshotPath = path.join(runDir, 'flow.snapshot.yaml');
  try {
    flow = parseYaml(await readFile(snapshotPath, 'utf8')) as FlowSnapshot;
  } catch {
    flow = null;
  }

  const stepsDir = path.join(runDir, 'steps');
  const stepDirs = await readDirs(stepsDir);

  if (flow === null || !Array.isArray(flow.steps)) {
    warnings.push(`run ${meta.runId}: flow.snapshot.yaml missing or unreadable; step order inferred`);
    const inferred: Step[] = [...stepDirs].sort().map((id) => ({ id }));
    flow = {
      version: 1,
      flow: meta.flow,
      viewports: meta.viewports,
      network: { mode: meta.network },
      steps: inferred,
    };
  }

  const ordered: StepId[] = [];
  for (const s of flow.steps) if (!ordered.includes(s.id)) ordered.push(s.id);
  for (const id of [...stepDirs].sort()) if (!ordered.includes(id)) ordered.push(id);

  const steps: LoadedStep[] = [];
  const stepsById: Record<StepId, LoadedStep> = {};

  for (const [index, id] of ordered.entries()) {
    const stepDir = path.join(stepsDir, id);
    if (!(await exists(stepDir))) continue;

    const result =
      (await readJson<StepResult>(path.join(stepDir, 'step.json'))) ??
      synthesizeStepResult(id, index, meta.startedAt);

    const consoleEntries = (await readJson<ConsoleEntry[]>(path.join(stepDir, 'console.json'))) ?? [];
    const networkEntries = (await readJson<NetworkEntry[]>(path.join(stepDir, 'network.json'))) ?? [];

    const shots: Record<ViewportId, LoadedShot> = {};
    for (const viewport of (await readDirs(stepDir)).filter((d) => VIEWPORT_DIR.test(d)).sort()) {
      const vpDir = path.join(stepDir, viewport);
      const screenshotPath = path.join(vpDir, 'screenshot.png');
      if (!(await exists(screenshotPath))) {
        warnings.push(`run ${meta.runId}: step ${id} viewport ${viewport} has no screenshot.png`);
        continue;
      }
      let dom = await readJson<DomSnapshot>(path.join(vpDir, 'dom.json'));
      if (dom === null) {
        warnings.push(
          `run ${meta.runId}: step ${id} viewport ${viewport} has no dom.json; attribution disabled`,
        );
        dom = emptyDom(id, viewport);
      }
      if (dom.truncated) {
        warnings.push(
          `run ${meta.runId}: step ${id} viewport ${viewport} dom.json was truncated at the node cap`,
        );
      }
      const a11y = await readJson<A11ySnapshot>(path.join(vpDir, 'a11y.json'));
      const shot = result.viewports[viewport];
      shots[viewport] = {
        viewport,
        screenshotPath,
        dom,
        a11y,
        size: {
          w: shot?.width ?? dom.document.w,
          h: shot?.height ?? dom.document.h,
        },
      };
    }

    const loaded: LoadedStep = {
      result,
      shots,
      console: Array.isArray(consoleEntries) ? consoleEntries : [],
      network: Array.isArray(networkEntries) ? networkEntries : [],
    };
    steps.push(loaded);
    stepsById[id] = loaded;
  }

  if (meta.pruned) {
    warnings.push(`run ${meta.runId} is pruned; its blobs are unavailable`);
  }

  return { run: { runDir, meta, flow, steps, stepsById }, warnings };
}
