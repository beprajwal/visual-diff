/**
 * store/retention — spec §6, "Retention".
 *
 * > Keep the last 20 runs per flow. Pruning deletes blobs but preserves `meta.json` and
 * > `flow.snapshot.yaml` permanently, so the timeline stays intact and a pruned point remains
 * > backfillable by replay. `vdiff pin <run>` exempts a run; runs referenced by a stored diff are
 * > never pruned.
 *
 * Every clause of that paragraph is enforced here and nowhere else:
 *
 * - the two surviving files are named by `PRESERVED_FILES` and are the only exceptions to the
 *   delete walk;
 * - a pruned run keeps its timeline row and is flagged `pruned: true`, which is what lets the
 *   report offer the exact backfill command instead of erroring (spec §10);
 * - `pinned` and diff-referenced runs are skipped with a reason, including when a prune is asked
 *   for explicitly — "never pruned" means never, not "unless you insist".
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { StoreError } from './errors.js';
import { runsReferencedByDiffs } from './diff-store.js';
import { dirSize, listDirEntries } from './internal/fs.js';
import * as paths from './paths.js';
import { listRunIds, readRunMeta, updateRunMeta } from './run-store.js';
import type { RunId, RunMeta } from '../types.js';

/** Survives pruning forever (spec §6). */
export const PRESERVED_FILES: readonly string[] = [
  paths.META_FILENAME,
  paths.FLOW_SNAPSHOT_FILENAME,
];

export type PruneSkipReason = 'pinned' | 'diff-referenced' | 'already-pruned';

export interface PruneSkip {
  runId: RunId;
  reason: PruneSkipReason;
}

export interface PruneResult {
  flow: string;
  pruned: RunId[];
  skipped: PruneSkip[];
  freedBytes: number;
}

/** `vdiff pin <run>` / unpin. Returns the updated metadata. */
export async function pinRun(
  root: string,
  flow: string,
  runId: RunId,
  pinned = true,
): Promise<RunMeta> {
  await readRunMeta(root, flow, runId); // 404s here rather than writing a phantom meta.json
  return updateRunMeta(root, flow, runId, { pinned });
}

export async function isPruneExempt(
  root: string,
  flow: string,
  runId: RunId,
  referenced?: Set<RunId>,
): Promise<PruneSkipReason | null> {
  const meta = await readRunMeta(root, flow, runId);
  if (meta.pruned) return 'already-pruned';
  if (meta.pinned) return 'pinned';
  const refs = referenced ?? (await runsReferencedByDiffs(root, flow));
  if (refs.has(runId)) return 'diff-referenced';
  return null;
}

/** Delete every blob of one run, keeping `meta.json` and `flow.snapshot.yaml`. */
async function stripRunBlobs(root: string, flow: string, runId: RunId): Promise<number> {
  const dir = paths.runDir(root, flow, runId);
  let freed = 0;
  for (const entry of await listDirEntries(dir)) {
    if (PRESERVED_FILES.includes(entry.name)) continue;
    const target = path.join(dir, entry.name);
    freed += await dirSize(target);
    await fsp.rm(target, { recursive: true, force: true });
  }
  return freed;
}

/**
 * Prune one run by id (`vdiff prune <run>`). Exempt runs are reported, not pruned and not thrown
 * over, so the CLI can print why nothing happened.
 */
export async function pruneRun(root: string, flow: string, runId: RunId): Promise<PruneResult> {
  const exempt = await isPruneExempt(root, flow, runId);
  if (exempt !== null) {
    return { flow, pruned: [], skipped: [{ runId, reason: exempt }], freedBytes: 0 };
  }
  const freedBytes = await stripRunBlobs(root, flow, runId);
  await updateRunMeta(root, flow, runId, { pruned: true });
  return { flow, pruned: [runId], skipped: [], freedBytes };
}

export interface PruneFlowOptions {
  /** Runs kept intact, newest first. Defaults to the config value (20 in the spec). */
  keepRuns: number;
}

/** Apply the retention policy to one flow. */
export async function pruneFlow(
  root: string,
  flow: string,
  options: PruneFlowOptions,
): Promise<PruneResult> {
  const { keepRuns } = options;
  if (!Number.isInteger(keepRuns) || keepRuns < 1) {
    throw new StoreError('invalid-retention', `retention.keepRuns must be >= 1, got ${keepRuns}`);
  }
  const ids = await listRunIds(root, flow);
  const candidates = ids.slice(0, Math.max(0, ids.length - keepRuns));
  if (candidates.length === 0) return { flow, pruned: [], skipped: [], freedBytes: 0 };

  const referenced = await runsReferencedByDiffs(root, flow);
  const pruned: RunId[] = [];
  const skipped: PruneSkip[] = [];
  let freedBytes = 0;

  for (const runId of candidates) {
    const exempt = await isPruneExempt(root, flow, runId, referenced);
    if (exempt !== null) {
      skipped.push({ runId, reason: exempt });
      continue;
    }
    freedBytes += await stripRunBlobs(root, flow, runId);
    await updateRunMeta(root, flow, runId, { pruned: true });
    pruned.push(runId);
  }
  return { flow, pruned, skipped, freedBytes };
}

/** Apply the retention policy to every flow that has runs. */
export async function pruneAllFlows(
  root: string,
  options: PruneFlowOptions,
  flows: readonly string[],
): Promise<PruneResult[]> {
  const out: PruneResult[] = [];
  for (const flow of flows) out.push(await pruneFlow(root, flow, options));
  return out;
}
