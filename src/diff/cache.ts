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
 *
 * The same argument extends to the scenario axis (mocking spec §6). The two run ids do not by
 * themselves say what the pair *is*: whether the two runs ran the same scenario, and whether one of
 * them is mock-only, decide the `scenarios` block, the `cross-scenario` and `mock-vs-recorded`
 * labels and the warnings that carry them. A key blind to that would serve a pair diffed before as
 * an unlabelled ordinary regression — precisely the stale-forever failure this file exists to
 * prevent, one axis over. So the pair's scenario identity is folded into the same digest: the run
 * *ids* are in the key verbatim, and everything else that can move the output is fingerprinted.
 */

import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCENARIO_NONE } from '../types.js';
import type {
  DiffEngineOptions,
  DiffResult,
  PairId,
  PairScenarios,
  RunId,
} from '../types.js';

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

/**
 * The scenario identity of a pair neither side of which ran a scenario — the slice-1 pair, and the
 * default every entry point here falls back to when a caller has nothing to say about scenarios.
 */
export const SCENARIOLESS_PAIR: PairScenarios = {
  base: SCENARIO_NONE,
  head: SCENARIO_NONE,
  crossScenario: false,
  mockVsRecorded: false,
};

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
 * A short, stable digest of everything outside the two run ids that can move the engine's output:
 * the diff configuration, and the scenario identity of the pair (mocking spec §6).
 *
 * Built from an explicitly ordered object rather than from the caller's options: `JSON.stringify`
 * follows insertion order, so hashing the options directly would make the digest depend on how the
 * caller happened to construct them, and every caller would key the same configuration differently.
 * Extra fields on the passed object (`force`, anything added later) are ignored by construction —
 * a new field that changes output has to be added here, which is the point of the explicit list.
 *
 * Both scenario names *and* the two derived labels are digested. The labels are computable from the
 * names, so digesting them is redundant today; it is deliberate, because the day the derivation
 * changes is the day every stored diff computed under the old derivation must stop being reused.
 */
export function diffConfigFingerprint(
  options: DiffCacheOptions,
  scenarios: PairScenarios = SCENARIOLESS_PAIR,
): string {
  const canonical = JSON.stringify({
    antialiasTolerance: options.antialiasTolerance,
    deviceScaleFactor: options.deviceScaleFactor,
    ignore: [...options.ignore],
    maxRegions: options.maxRegions,
    minRegionArea: options.minRegionArea,
    scenarios: {
      base: scenarios.base,
      crossScenario: scenarios.crossScenario,
      head: scenarios.head,
      mockVsRecorded: scenarios.mockVsRecorded,
    },
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** `<base>..<head>@<engineVersion>#<fingerprint>`. */
export function diffCacheKey(
  base: RunId,
  head: RunId,
  options: DiffCacheOptions,
  scenarios: PairScenarios = SCENARIOLESS_PAIR,
): string {
  return `${pairId(base, head)}@${options.engineVersion}#${diffConfigFingerprint(options, scenarios)}`;
}

/**
 * Whether a stored result may be reused for this pair, under this configuration, for this scenario
 * pairing.
 *
 * An unstamped result is a miss: it was written before the key covered configuration, so its
 * findings cannot be attributed to any particular one.
 */
export function isCacheHit(
  cached: CachedDiffResult,
  base: RunId,
  head: RunId,
  options: DiffCacheOptions,
  scenarios: PairScenarios = SCENARIOLESS_PAIR,
): boolean {
  if (typeof cached.cacheKey !== 'string' || cached.cacheKey === '') return false;
  return cached.cacheKey === diffCacheKey(base, head, options, scenarios);
}

export async function readCachedDiff(
  outDir: string,
  base: RunId,
  head: RunId,
  options: DiffCacheOptions,
  scenarios: PairScenarios = SCENARIOLESS_PAIR,
): Promise<DiffResult | null> {
  try {
    const raw = await readFile(path.join(outDir, 'findings.json'), 'utf8');
    const parsed = JSON.parse(raw) as CachedDiffResult;
    return isCacheHit(parsed, base, head, options, scenarios) ? parsed : null;
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
 *
 * The scenario identity comes off the result, which is the one place it cannot disagree with the
 * findings being stored: `diffRuns` puts the very block it labelled the pair with there.
 */
export async function writeDiff(
  outDir: string,
  result: DiffResult,
  options: DiffCacheOptions,
): Promise<string> {
  const stamped = result as CachedDiffResult;
  stamped.cacheKey = diffCacheKey(
    result.pair.base,
    result.pair.head,
    options,
    result.scenarios ?? SCENARIOLESS_PAIR,
  );

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
