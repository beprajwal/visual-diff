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
 *
 * The mocking spec narrows the first clause: the last 20 runs **per `(flow, scenario)`**, not per
 * flow (§6). Counting per flow would let a scenario run every hour evict the whole history of one
 * run monthly, which is backwards — the rarely-run scenario is precisely the one whose history
 * cannot be reconstructed from memory.
 *
 * The variants spec narrows it once more, and this time it splits the count in two (§5, D24).
 * Proposals are exploratory: you try five arrangements and keep zero or one. Sharing the 20-run
 * bucket would let an afternoon of variant runs evict the capture history regressions depend on —
 * a quiet data loss at exactly the wrong moment. So there are **two buckets**:
 *
 * | bucket | holds | default |
 * |---|---|---|
 * | `timeline` | unvaried runs, and variant runs promoted by `--keep` | `retention.keepRuns` (20) |
 * | `variant` | ephemeral variant runs | `retention.keepVariantRuns` (10) |
 *
 * **Eviction never crosses that boundary in either direction.** A run only ever competes with runs
 * in its own bucket, so no number of proposals can shorten the regression history, and no amount of
 * regression capture can throw away a proposal the user is still looking at. `--keep` is the only
 * way a run moves between buckets, and moving it is the whole point of promotion.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { StoreError } from './errors.js';
import { runsReferencedByDiffs } from './diff-store.js';
import { dirSize, listDirEntries } from './internal/fs.js';
import { sortRunIds } from './internal/id.js';
import { DEFAULT_KEEP_VARIANT_RUNS, VARIANT_NONE, isVariantRun } from './internal/variant.js';
import type { RetentionBucket } from './internal/variant.js';
import * as paths from './paths.js';
import { listRunIds, readRunIdentityIndex, readRunMeta, updateRunMeta } from './run-store.js';
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

/**
 * `vdiff run <flow> --variant <name> --keep`, and `vdiff keep <run>` after the fact: promote a
 * variant run into the permanent timeline (variants spec §5).
 *
 * Promotion is a *bucket* change, not an identity change. The run keeps its variant — it is still
 * the capture of that proposal, and rewriting it to `none` would claim the unmodified page had been
 * captured when it had not — and gains `kept: true`, which moves it out of the ephemeral bucket and
 * into the regression timeline.
 *
 * Promoting a run that ran no variant is refused rather than silently accepted: such a run is
 * already permanent, so a caller asking for this has misunderstood which run it is holding, and
 * quietly writing a flag that can never mean anything would hide that.
 */
export async function keepRun(
  root: string,
  flow: string,
  runId: RunId,
  kept = true,
): Promise<RunMeta> {
  const meta = await readRunMeta(root, flow, runId);
  if (!isVariantRun(meta)) {
    throw new StoreError(
      'not-a-variant-run',
      `run ${runId} of flow "${flow}" ran no variant; only a variant run can be promoted with --keep`,
      { hint: `Variant runs are listed by: vdiff runs ${flow} --variants` },
    );
  }
  return updateRunMeta(root, flow, runId, { kept });
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
  /**
   * Runs kept intact per `(flow, scenario, variant)` in the timeline bucket, newest first. Defaults
   * to the config value (20 in the spec); the per-scenario reading is the mocking spec's (§6).
   */
  keepRuns: number;
  /**
   * Runs kept intact per `(flow, scenario, variant)` in the variant bucket (variants spec §5).
   * Optional so every existing caller keeps working; absent means `DEFAULT_KEEP_VARIANT_RUNS`.
   */
  keepVariantRuns?: number;
}

/** Which bucket a group belongs to, and the runs in it, oldest first. */
interface RetentionGroup {
  bucket: RetentionBucket;
  ids: RunId[];
}

/**
 * The runs of one flow that fall outside the retention window, in run-id order.
 *
 * Grouped twice over. First by bucket — ephemeral variant runs on one side, the permanent timeline
 * on the other — so eviction can never cross that line (D24). Then, inside each bucket, by
 * `(scenario, variant)`, so the pressure of a busy identity never reaches a quiet one's history
 * (mocking spec §6, extended to the variant axis by run identity being `(flow, revision, scenario,
 * variant)`).
 */
export async function retentionCandidates(
  root: string,
  flow: string,
  keepRuns: number,
  keepVariantRuns: number = DEFAULT_KEEP_VARIANT_RUNS,
): Promise<RunId[]> {
  const ids = await listRunIds(root, flow);
  const index = await readRunIdentityIndex(root, flow, ids);
  const groups = new Map<string, RetentionGroup>();
  for (const runId of ids) {
    const identity = index.get(runId);
    const bucket: RetentionBucket = identity?.bucket ?? 'timeline';
    // JSON rather than a hand-rolled delimiter: a scenario or variant name may legally contain
    // any character a filename may, so a separator could make two distinct identities collide.
    const key = JSON.stringify([bucket, identity?.scenario ?? '', identity?.variant ?? VARIANT_NONE]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { bucket, ids: [runId] });
    else group.ids.push(runId);
  }
  const candidates: RunId[] = [];
  for (const group of groups.values()) {
    const keep = group.bucket === 'variant' ? keepVariantRuns : keepRuns;
    candidates.push(...group.ids.slice(0, Math.max(0, group.ids.length - keep)));
  }
  return sortRunIds(candidates);
}

/** Apply the retention policy to one flow. */
export async function pruneFlow(
  root: string,
  flow: string,
  options: PruneFlowOptions,
): Promise<PruneResult> {
  const { keepRuns } = options;
  const keepVariantRuns = options.keepVariantRuns ?? DEFAULT_KEEP_VARIANT_RUNS;
  if (!Number.isInteger(keepRuns) || keepRuns < 1) {
    throw new StoreError('invalid-retention', `retention.keepRuns must be >= 1, got ${keepRuns}`);
  }
  if (!Number.isInteger(keepVariantRuns) || keepVariantRuns < 1) {
    throw new StoreError(
      'invalid-retention',
      `retention.keepVariantRuns must be >= 1, got ${keepVariantRuns}`,
    );
  }
  const candidates = await retentionCandidates(root, flow, keepRuns, keepVariantRuns);
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
