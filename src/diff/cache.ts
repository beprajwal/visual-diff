/**
 * Diff cache (spec §8): "Cached by (baseRunId, headRunId, engineVersion), so reopening the report
 * never recomputes."
 *
 * The cache *is* the stored `findings.json` — there is no second index to fall out of sync, and the
 * key it was computed under is stamped inside that same file so a reader can never disagree with a
 * writer about which key a stored result belongs to.
 *
 * The spec's three components are not sufficient on their own. `engineVersion` versions the *code*;
 * it says nothing about the *configuration* the code ran with. `ignore`, `minRegionArea`,
 * `maxRegions`, `antialiasTolerance` and `deviceScaleFactor` all change which regions survive, which
 * are attributed and which findings are emitted — so a pair diffed before an `ignore` list changed
 * would otherwise return the pre-change findings forever, under an unchanged engine version. The key
 * therefore covers everything the engine consumes that can move its output.
 *
 * The bias is deliberate and one-directional: a false miss costs one recompute, a false hit ships
 * wrong findings. So the configuration is fingerprinted *verbatim* — `ignore` is not sorted or
 * de-duplicated, because its order and multiplicity are visible in the emitted warnings — and a
 * stored result with no stamped key (anything written before this file learned to stamp one) reads
 * as a miss.
 */

import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiffEngineOptions, DiffResult, PairId, RunId } from '../types.js';

/**
 * Everything the engine consumes that can change its output.
 *
 * Structurally a subset of `DiffEngineOptions`, so callers pass their options object straight in.
 * `force` is absent on purpose: it selects whether the cache is *consulted*, not what the engine
 * computes, so folding it into the key would make `--force` write an entry nothing can ever read.
 */
export interface DiffCacheOptions {
  engineVersion: string;
  ignore: readonly string[];
  minRegionArea: number;
  maxRegions: number;
  antialiasTolerance: number;
  deviceScaleFactor: number;
}

/** A stored `findings.json`: the result, plus the key it was computed under. */
export type CachedDiffResult = DiffResult & { cacheKey?: string };

export function pairId(base: RunId, head: RunId): PairId {
  return `${base}..${head}`;
}

/** `<vdiffDir>/diffs/<flow>/<base>..<head>` — the spec §6 layout. */
export function diffDirFor(vdiffDir: string, flow: string, base: RunId, head: RunId): string {
  return path.join(vdiffDir, 'diffs', flow, pairId(base, head));
}

/**
 * A short, stable digest of the diff configuration.
 *
 * Built from an explicitly ordered object rather than from the caller's options: `JSON.stringify`
 * follows insertion order, so hashing the options directly would make the digest depend on how the
 * caller happened to construct them, and every caller would key the same configuration differently.
 * Extra fields on the passed object (`force`, anything added later) are ignored by construction —
 * a new field that changes output has to be added here, which is the point of the explicit list.
 */
export function diffConfigFingerprint(options: DiffCacheOptions): string {
  const canonical = JSON.stringify({
    antialiasTolerance: options.antialiasTolerance,
    deviceScaleFactor: options.deviceScaleFactor,
    ignore: [...options.ignore],
    maxRegions: options.maxRegions,
    minRegionArea: options.minRegionArea,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** `<base>..<head>@<engineVersion>#<configFingerprint>`. */
export function diffCacheKey(base: RunId, head: RunId, options: DiffCacheOptions): string {
  return `${pairId(base, head)}@${options.engineVersion}#${diffConfigFingerprint(options)}`;
}

/**
 * Whether a stored result may be reused for this pair under this configuration.
 *
 * An unstamped result is a miss: it was written before the key covered configuration, so its
 * findings cannot be attributed to any particular one.
 */
export function isCacheHit(
  cached: CachedDiffResult,
  base: RunId,
  head: RunId,
  options: DiffCacheOptions,
): boolean {
  if (typeof cached.cacheKey !== 'string' || cached.cacheKey === '') return false;
  return cached.cacheKey === diffCacheKey(base, head, options);
}

export async function readCachedDiff(
  outDir: string,
  base: RunId,
  head: RunId,
  options: DiffCacheOptions,
): Promise<DiffResult | null> {
  try {
    const raw = await readFile(path.join(outDir, 'findings.json'), 'utf8');
    const parsed = JSON.parse(raw) as CachedDiffResult;
    return isCacheHit(parsed, base, head, options) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Atomic: a reader never sees a half-written findings.json.
 *
 * The key is stamped onto `result` itself, not onto a copy that is thrown away after serialization.
 * `findings.json` has a second writer — `cli/commands/diff.ts` hands the returned result to
 * `store.writeDiff`, which re-serializes the same object over the same file — and a key that lived
 * only in the bytes written here would be erased by that round trip, turning every subsequent read
 * into a miss.
 */
export async function writeDiff(
  outDir: string,
  result: DiffResult,
  options: DiffCacheOptions,
): Promise<string> {
  const stamped = result as CachedDiffResult;
  stamped.cacheKey = diffCacheKey(result.pair.base, result.pair.head, options);

  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, 'findings.json');
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(stamped, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  return target;
}

/**
 * Compile-time proof that the engine's own options are always a valid cache key input: adding a
 * field to `DiffEngineOptions` is free, but *narrowing* one out from under the key is not.
 */
type Assert<T extends true> = T;
export type EngineOptionsAreCacheOptions = Assert<
  DiffEngineOptions extends DiffCacheOptions ? true : false
>;
