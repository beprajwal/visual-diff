/**
 * Diff cache (spec §8): "Cached by (baseRunId, headRunId, engineVersion), so reopening the report
 * never recomputes."
 *
 * The cache *is* the stored `findings.json` — there is no second index to fall out of sync. A
 * stored result is reused only when all three key components match; anything else recomputes.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiffResult, PairId, RunId } from '../types.js';

export function pairId(base: RunId, head: RunId): PairId {
  return `${base}..${head}`;
}

/** `<vdiffDir>/diffs/<flow>/<base>..<head>` — the spec §6 layout. */
export function diffDirFor(vdiffDir: string, flow: string, base: RunId, head: RunId): string {
  return path.join(vdiffDir, 'diffs', flow, pairId(base, head));
}

export function diffCacheKey(base: RunId, head: RunId, engineVersion: string): string {
  return `${base}..${head}@${engineVersion}`;
}

export function isCacheHit(
  cached: DiffResult,
  base: RunId,
  head: RunId,
  engineVersion: string,
): boolean {
  return (
    diffCacheKey(cached.pair.base, cached.pair.head, cached.engineVersion) ===
    diffCacheKey(base, head, engineVersion)
  );
}

export async function readCachedDiff(
  outDir: string,
  base: RunId,
  head: RunId,
  engineVersion: string,
): Promise<DiffResult | null> {
  try {
    const raw = await readFile(path.join(outDir, 'findings.json'), 'utf8');
    const parsed = JSON.parse(raw) as DiffResult;
    return isCacheHit(parsed, base, head, engineVersion) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic: a reader never sees a half-written findings.json. */
export async function writeDiff(outDir: string, result: DiffResult): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, 'findings.json');
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  return target;
}
