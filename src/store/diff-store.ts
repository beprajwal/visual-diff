/**
 * store/diff-store — the `findings.json` cache and its blobs (spec §6, §8).
 *
 * The diff engine is a pure function cached by `(baseRunId, headRunId, engineVersion)`, so
 * reopening the report never recomputes. The pair is the directory name (`0003..0007`); the engine
 * version lives inside `findings.json`, and a mismatch reads as a cache miss rather than as stale
 * output.
 *
 * The blob writers return paths **relative to `.visual-diff/`**, which is the form
 * `ViewportDiff.pixelPath`, `ViewportDiff.regionsPath`, `Finding.crop` and `FeedbackEntry.crop`
 * all carry.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomic, writeJsonAtomic } from './internal/atomic.js';
import { ensureDir, listDirEntries, pathExists, readJsonOrNull, rmrf } from './internal/fs.js';
import { parsePairId } from './internal/id.js';
import * as paths from './paths.js';
import type { DiffResult, PairRef, Region, RegionSet, RunId, StepId, ViewportId } from '../types.js';

export async function hasDiff(
  root: string,
  flow: string,
  base: RunId,
  head: RunId,
): Promise<boolean> {
  return pathExists(paths.diffFindingsFile(root, flow, base, head));
}

/**
 * Cache read. Returns null on a miss: no stored diff, or one produced by a different engine
 * version. `engineVersion` may be omitted to read whatever is stored.
 */
export async function readDiff(
  root: string,
  flow: string,
  base: RunId,
  head: RunId,
  engineVersion?: string,
): Promise<DiffResult | null> {
  const stored = await readJsonOrNull<DiffResult>(paths.diffFindingsFile(root, flow, base, head));
  if (stored === null) return null;
  if (engineVersion !== undefined && stored.engineVersion !== engineVersion) return null;
  return stored;
}

/** Total findings for a pair, or null when no diff is stored. Feeds the `vdiff runs` timeline. */
export async function readFindingsCount(
  root: string,
  flow: string,
  base: RunId,
  head: RunId,
): Promise<number | null> {
  const stored = await readDiff(root, flow, base, head);
  return stored === null ? null : stored.summary.totalFindings;
}

/** Write `findings.json` for the pair named inside `result`. Returns that file's absolute path. */
export async function writeDiff(root: string, result: DiffResult): Promise<string> {
  const dir = paths.diffDir(root, result.flow, result.pair.base, result.pair.head);
  await ensureDir(dir);
  const file = path.join(dir, paths.FINDINGS_FILENAME);
  await writeJsonAtomic(file, result);
  // The findings file, not its directory: every caller either prints this path or reads it back,
  // and `vdiff diff` says "findings.json: <path>".
  return file;
}

export async function invalidateDiff(
  root: string,
  flow: string,
  base: RunId,
  head: RunId,
): Promise<void> {
  await rmrf(paths.diffDir(root, flow, base, head));
}

/** Every pair with a diff directory for one flow. */
export async function listStoredPairs(root: string, flow: string): Promise<PairRef[]> {
  const out: PairRef[] = [];
  for (const entry of await listDirEntries(paths.flowDiffsDir(root, flow))) {
    if (!entry.isDirectory) continue;
    const parsed = parsePairId(entry.name);
    if (parsed === null) continue;
    out.push({ flow, base: parsed.base, head: parsed.head });
  }
  return out.sort((a, b) => (a.base + a.head < b.base + b.head ? -1 : 1));
}

/** Every pair with a diff directory, across all flows. */
export async function listAllStoredPairs(root: string): Promise<PairRef[]> {
  const out: PairRef[] = [];
  for (const entry of await listDirEntries(paths.diffsDir(root))) {
    if (!entry.isDirectory || !paths.isSafeSegment(entry.name)) continue;
    out.push(...(await listStoredPairs(root, entry.name)));
  }
  return out;
}

/** Run ids referenced by any stored diff of one flow. Retention never prunes these (spec §6). */
export async function runsReferencedByDiffs(root: string, flow: string): Promise<Set<RunId>> {
  const referenced = new Set<RunId>();
  for (const pair of await listStoredPairs(root, flow)) {
    referenced.add(pair.base);
    referenced.add(pair.head);
  }
  return referenced;
}

/* ------------------------------------------------------------------ blobs */

/** Crop of the head screenshot for one finding. Returns the path relative to `.visual-diff/`. */
export async function writeCrop(
  root: string,
  flow: string,
  base: RunId,
  head: RunId,
  findingId: string,
  png: Uint8Array,
): Promise<string> {
  const target = paths.diffCropFile(root, flow, base, head, findingId);
  await ensureDir(path.dirname(target));
  await writeFileAtomic(target, png);
  return paths.relDiffCrop(flow, base, head, findingId);
}

/** Rendered pixel-diff image for one (step, viewport). Returns the `.visual-diff/`-relative path. */
export async function writePixelDiff(
  root: string,
  flow: string,
  base: RunId,
  head: RunId,
  step: StepId,
  viewport: ViewportId,
  png: Uint8Array,
): Promise<string> {
  const dir = paths.diffStepViewportDir(root, flow, base, head, step, viewport);
  await ensureDir(dir);
  await writeFileAtomic(path.join(dir, paths.PIXEL_FILENAME), png);
  return paths.relDiffPixel(flow, base, head, step, viewport);
}

export async function writeRegions(
  root: string,
  flow: string,
  base: RunId,
  head: RunId,
  step: StepId,
  viewport: ViewportId,
  regions: RegionSet | Region[],
): Promise<string> {
  const dir = paths.diffStepViewportDir(root, flow, base, head, step, viewport);
  await ensureDir(dir);
  await writeJsonAtomic(path.join(dir, paths.REGIONS_FILENAME), regions);
  return paths.relDiffRegions(flow, base, head, step, viewport);
}

export async function readRegions(
  root: string,
  flow: string,
  base: RunId,
  head: RunId,
  step: StepId,
  viewport: ViewportId,
): Promise<RegionSet | Region[] | null> {
  return readJsonOrNull<RegionSet | Region[]>(
    path.join(
      paths.diffStepViewportDir(root, flow, base, head, step, viewport),
      paths.REGIONS_FILENAME,
    ),
  );
}

/** Absolute path of a stored blob, refusing anything that escapes `.visual-diff/`. */
export async function statBlob(root: string, relativePath: string): Promise<number | null> {
  const absolute = paths.resolveInsideVdiff(root, relativePath);
  try {
    const stat = await fsp.stat(absolute);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}
