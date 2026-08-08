/**
 * store/run-store — the append-only run store (spec §6, D3).
 *
 * Writing a run is a two-phase operation:
 *
 * 1. `beginRun` creates `runs/<flow>/.tmp-<suffix>/` — a sibling of the final directory, so the
 *    publish step is a same-filesystem rename. Everything the runner captures lands there.
 * 2. `commit` allocates the run id, writes `meta.json`, fsyncs the whole tree and renames the temp
 *    directory into place. **The rename is the only step that makes a run visible**, so a crash at
 *    any earlier point leaves nothing for the store or the report to see (spec §10).
 *
 * Run ids are allocated at commit time from the ids already on disk, which keeps them monotonic
 * per flow even when a run crashes, is pruned, or is deleted by hand.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { StoreError } from './errors.js';
import { publishDirAtomic, tempSuffix, writeJsonAtomic } from './internal/atomic.js';
import {
  ensureDir,
  listDirEntries,
  pathExists,
  readJson,
  readJsonOrNull,
  readTextOrNull,
} from './internal/fs.js';
import { isRunId, nextRunId, normalizeRunId, sortRunIds } from './internal/id.js';
import { stableStringify } from './internal/json.js';
import * as paths from './paths.js';
import { serializeFlowSnapshot } from './snapshot.js';
import type {
  A11ySnapshot,
  ConsoleEntry,
  DomSnapshot,
  FlowSnapshot,
  NetworkEntry,
  PairRef,
  RunId,
  RunMeta,
  RunSummary,
  ShotResult,
  StepId,
  StepResult,
  ViewportId,
} from '../types.js';

/* ------------------------------------------------------------------ writing */

/** `RunMeta` minus the field the store owns. `runId` may be supplied to force a backfill id. */
export type RunMetaInput = Omit<RunMeta, 'runId'> & { runId?: RunId };

export interface ShotInput {
  viewport: ViewportId;
  /** Encoded PNG bytes. */
  screenshot: Uint8Array;
  dom: DomSnapshot;
  a11y?: A11ySnapshot | null;
  /** Screenshot dimensions in image pixels. */
  width: number;
  height: number;
}

export interface CommittedRun {
  runId: RunId;
  runDir: string;
  meta: RunMeta;
}

export interface RunDraft {
  readonly flow: string;
  /** The temp directory being built. Never visible under a run id. */
  readonly dir: string;
  readonly committed: boolean;
  writeFlowSnapshot(snapshot: FlowSnapshot | string): Promise<void>;
  writeStepResult(result: StepResult): Promise<void>;
  writeShot(step: StepId, shot: ShotInput): Promise<ShotResult>;
  writeStepConsole(step: StepId, entries: readonly ConsoleEntry[]): Promise<void>;
  writeStepNetwork(step: StepId, entries: readonly NetworkEntry[]): Promise<void>;
  /** Retained diagnostics (`install.log`, `server.log`); returns the run-relative path. */
  writeLog(name: string, contents: string): Promise<string>;
  /** Escape hatch for run-relative artefacts such as a failure screenshot. */
  writeArtifact(relativePath: string, data: string | Uint8Array): Promise<string>;
  commit(meta: RunMetaInput): Promise<CommittedRun>;
  /** Throw away an unfinished run. Idempotent. */
  discard(): Promise<void>;
}

export async function beginRun(root: string, flow: string): Promise<RunDraft> {
  const flowRuns = paths.flowRunsDir(root, flow);
  await ensureDir(flowRuns);
  const dir = path.join(flowRuns, `${paths.TEMP_PREFIX}${tempSuffix()}`);
  await fsp.mkdir(dir);
  return makeDraft(root, flow, dir);
}

function makeDraft(root: string, flow: string, dir: string): RunDraft {
  let committed = false;
  let discarded = false;

  const assertOpen = (): void => {
    if (committed) throw new StoreError('run-committed', `run for flow "${flow}" is already committed`);
    if (discarded) throw new StoreError('run-discarded', `run for flow "${flow}" was discarded`);
  };

  const writeInside = async (relative: string, data: string | Uint8Array): Promise<string> => {
    assertOpen();
    const target = paths.resolveInsideRun(dir, relative);
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, data);
    return relative;
  };

  return {
    flow,
    dir,
    get committed() {
      return committed;
    },

    async writeFlowSnapshot(snapshot: FlowSnapshot | string): Promise<void> {
      const text = typeof snapshot === 'string' ? snapshot : serializeFlowSnapshot(snapshot);
      await writeInside(paths.FLOW_SNAPSHOT_FILENAME, text.endsWith('\n') ? text : `${text}\n`);
    },

    async writeStepResult(result: StepResult): Promise<void> {
      await writeInside(paths.relStepResult(result.id), `${stableStringify(result)}\n`);
    },

    async writeShot(step: StepId, shot: ShotInput): Promise<ShotResult> {
      const rel = paths.relShotPaths(step, shot.viewport);
      await writeInside(rel.screenshot, shot.screenshot);
      await writeInside(rel.dom, `${stableStringify(shot.dom)}\n`);
      const a11y: A11ySnapshot =
        shot.a11y ?? { step, viewport: shot.viewport, root: null };
      await writeInside(rel.a11y, `${stableStringify(a11y)}\n`);
      return {
        viewport: shot.viewport,
        screenshot: rel.screenshot,
        dom: rel.dom,
        a11y: rel.a11y,
        width: shot.width,
        height: shot.height,
        nodeCount: shot.dom.nodeCount,
        truncated: shot.dom.truncated,
      };
    },

    async writeStepConsole(step: StepId, entries: readonly ConsoleEntry[]): Promise<void> {
      await writeInside(paths.relStepConsole(step), `${stableStringify([...entries])}\n`);
    },

    async writeStepNetwork(step: StepId, entries: readonly NetworkEntry[]): Promise<void> {
      await writeInside(paths.relStepNetwork(step), `${stableStringify([...entries])}\n`);
    },

    async writeLog(name: string, contents: string): Promise<string> {
      return writeInside(paths.relRunLog(name), contents);
    },

    async writeArtifact(relativePath: string, data: string | Uint8Array): Promise<string> {
      return writeInside(relativePath, data);
    },

    async commit(meta: RunMetaInput): Promise<CommittedRun> {
      assertOpen();
      if (meta.runId !== undefined && !isRunId(meta.runId)) {
        throw new StoreError(
          'invalid-run-id',
          `"${meta.runId}" is not a run id; expected zero-padded digits such as 0007`,
        );
      }
      let runId = meta.runId ?? nextRunId(await listRunIds(root, flow));
      // Always through paths.runDir, so a forced id cannot escape the flow directory.
      let target = paths.runDir(root, flow, runId);
      if (meta.runId === undefined) {
        // Defensive: a directory can appear between the listing and the rename.
        while (await pathExists(target)) {
          runId = nextRunId([runId]);
          target = paths.runDir(root, flow, runId);
        }
      } else if (await pathExists(target)) {
        throw new StoreError('run-exists', `run ${runId} already exists for flow "${flow}"`);
      }
      const finalMeta: RunMeta = { ...meta, runId, flow };
      await fsp.writeFile(
        path.join(dir, paths.META_FILENAME),
        `${stableStringify(finalMeta)}\n`,
      );
      await publishDirAtomic(dir, target);
      committed = true;
      return { runId, runDir: target, meta: finalMeta };
    },

    async discard(): Promise<void> {
      if (committed || discarded) return;
      discarded = true;
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Reap temp directories left behind by a crashed run (spec §10). Returns what it removed. */
export async function reapAbandonedRuns(root: string, flow: string): Promise<string[]> {
  const flowRuns = paths.flowRunsDir(root, flow);
  const removed: string[] = [];
  for (const entry of await listDirEntries(flowRuns)) {
    if (!entry.isDirectory || !entry.name.startsWith(paths.TEMP_PREFIX)) continue;
    const target = path.join(flowRuns, entry.name);
    await fsp.rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

/* ------------------------------------------------------------------ reading */

/** Flows that have at least one run directory. */
export async function listFlows(root: string): Promise<string[]> {
  const entries = await listDirEntries(paths.runsDir(root));
  return entries
    .filter((entry) => entry.isDirectory && paths.isSafeSegment(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Committed run ids, ascending. In-flight `.tmp-*` directories are invisible here by construction. */
export async function listRunIds(root: string, flow: string): Promise<RunId[]> {
  const entries = await listDirEntries(paths.flowRunsDir(root, flow));
  const ids = entries.filter((entry) => entry.isDirectory && isRunId(entry.name)).map((e) => e.name);
  return sortRunIds(ids);
}

export async function latestRunId(root: string, flow: string): Promise<RunId | null> {
  const ids = await listRunIds(root, flow);
  return ids.length === 0 ? null : (ids[ids.length - 1] as RunId);
}

export async function runExists(root: string, flow: string, runId: RunId): Promise<boolean> {
  return pathExists(paths.runMetaFile(root, flow, runId));
}

export async function readRunMeta(root: string, flow: string, runId: RunId): Promise<RunMeta> {
  const file = paths.runMetaFile(root, flow, runId);
  const meta = await readJsonOrNull<RunMeta>(file);
  if (meta === null) {
    throw new StoreError('unknown-run', `run ${runId} does not exist for flow "${flow}"`);
  }
  return meta;
}

export async function readRunMetaOrNull(
  root: string,
  flow: string,
  runId: RunId,
): Promise<RunMeta | null> {
  return readJsonOrNull<RunMeta>(paths.runMetaFile(root, flow, runId));
}

/**
 * Patch `meta.json` in place. Used only for the fields the store owns after a run is published:
 * `pinned` and `pruned`. Written atomically, so a reader never sees a truncated file.
 */
export async function updateRunMeta(
  root: string,
  flow: string,
  runId: RunId,
  patch: Partial<RunMeta>,
): Promise<RunMeta> {
  const current = await readRunMeta(root, flow, runId);
  const next: RunMeta = { ...current, ...patch, runId: current.runId, flow: current.flow };
  await writeJsonAtomic(paths.runMetaFile(root, flow, runId), next);
  return next;
}

export async function readFlowSnapshotSource(
  root: string,
  flow: string,
  runId: RunId,
): Promise<string> {
  const file = paths.runFlowSnapshotFile(root, flow, runId);
  const text = await readTextOrNull(file);
  if (text === null) {
    throw new StoreError(
      'missing-snapshot',
      `run ${runId} of flow "${flow}" has no ${paths.FLOW_SNAPSHOT_FILENAME}`,
    );
  }
  return text;
}

export async function readStepResult(
  root: string,
  flow: string,
  runId: RunId,
  step: StepId,
): Promise<StepResult> {
  return readJson<StepResult>(paths.stepResultFile(root, flow, runId, step));
}

/* ------------------------------------------------------------------ timeline */

/**
 * One row per run, oldest first — the `vdiff runs <flow>` timeline (spec §9). `findingsCount` is
 * taken from the stored diff against the immediately preceding run, and is null when no diff has
 * been computed for that pair.
 */
export async function listRunSummaries(
  root: string,
  flow: string,
  findingsCountFor: (base: RunId, head: RunId) => Promise<number | null> = async () => null,
): Promise<RunSummary[]> {
  const ids = await listRunIds(root, flow);
  const out: RunSummary[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const runId = ids[i] as RunId;
    const meta = await readRunMetaOrNull(root, flow, runId);
    if (meta === null) continue;
    const previous = i > 0 ? (ids[i - 1] as RunId) : null;
    const findingsCount = previous === null ? null : await findingsCountFor(previous, runId);
    out.push({
      runId: meta.runId,
      flow: meta.flow,
      revision: meta.revision,
      mode: meta.mode,
      status: meta.status,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
      viewports: meta.viewports,
      failedSteps: meta.failedSteps,
      unstable: meta.unstable,
      pinned: meta.pinned,
      pruned: meta.pruned,
      findingsCount,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ pair resolution */

/**
 * Resolve a pair for `vdiff diff <flow> [base] [head]`. Defaults are **N-1 vs N** (spec §9):
 * head is the newest run, base is the one immediately before it. Ids may be given loosely (`7`)
 * and are normalised to the padded form.
 */
export async function resolvePair(
  root: string,
  flow: string,
  base?: string,
  head?: string,
): Promise<PairRef> {
  const ids = await listRunIds(root, flow);
  if (ids.length === 0) {
    throw new StoreError('no-runs', `flow "${flow}" has no runs yet`, {
      hint: `Run it first: vdiff run ${flow}`,
    });
  }

  const resolveOne = (input: string, label: string): RunId => {
    const normalized = normalizeRunId(input);
    if (normalized === null || !ids.includes(normalized)) {
      throw new StoreError('unknown-run', `${label} run "${input}" does not exist for flow "${flow}"`, {
        hint: `Known runs: ${ids.join(', ')}`,
      });
    }
    return normalized;
  };

  const headId = head === undefined ? (ids[ids.length - 1] as RunId) : resolveOne(head, 'head');
  if (base !== undefined) {
    const baseId = resolveOne(base, 'base');
    if (baseId === headId) {
      throw new StoreError('same-run', `base and head are both ${headId}; a pair needs two runs`);
    }
    return { flow, base: baseId, head: headId };
  }

  const headIndex = ids.indexOf(headId);
  if (headIndex <= 0) {
    throw new StoreError(
      'no-base',
      `flow "${flow}" has no run before ${headId} to compare against`,
      { hint: `Run it again to create a second point: vdiff run ${flow}` },
    );
  }
  return { flow, base: ids[headIndex - 1] as RunId, head: headId };
}
