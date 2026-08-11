/**
 * cli — resolving a pair and getting its diff, once for the three commands that need it.
 *
 * `vdiff diff`, `vdiff comment` and `vdiff export` all answer questions about the same object: the
 * stored diff of a pair. If they resolved that pair differently — a different default, a different
 * timeline, a different cache rule — then `vdiff comment` would describe a comparison `vdiff diff`
 * never made, which is the one failure a pull-request comment must not have (CI spec §7).
 *
 * So the resolution and the cache rule live here:
 *
 *  - defaults are N-1 vs N, resolved by the *store*, because which runs exist is store knowledge;
 *  - `--scenario` / `--variant` narrow, and `--e2e` selects the ingested timeline (D27);
 *  - a stored diff produced by this engine version is reused, and only an engine-version change
 *    forces recomputation (spec §8).
 */

import {
  DEFAULTS,
  DIFF_ENGINE_VERSION,
  type Config,
  type DiffEngineOptions,
  type DiffResult,
  type PairRef,
  type RunId,
  type ScenarioName,
} from '../../types.js';
import type { CommandContext } from '../command.js';
import type { RunFilter } from '../ports.js';
import type { VariantName } from '../variant.js';

/** The pair-selecting arguments every one of the three commands accepts, in one shape. */
export interface PairSelection {
  flow: string;
  base?: RunId;
  head?: RunId;
  scenario?: ScenarioName;
  variant?: VariantName;
  e2e: boolean;
}

export interface ResolvedPair {
  config: Config;
  pair: PairRef;
  result: DiffResult;
  /** Absolute path of the stored `findings.json`. */
  path: string;
  /** True when the stored diff was reused rather than recomputed (spec §8). */
  cached: boolean;
  /** Default bundle directory for this pair, whether or not anything writes it (CI spec §5). */
  exportDir: string;
}

/**
 * Which runs a *default* pair may be resolved over.
 *
 * `--e2e` asks for the ingested timeline (`only`). No flag and no run named leaves the field unset,
 * which is the store's own default (`exclude`, the replay timeline) — restating it here would create
 * a second place that decides. A run named outright is an explicit request for that run whatever
 * captured it, so the bucket filter stands aside and a mixed pair is allowed to happen: the pairing
 * D27 permits and flags rather than forbidding.
 */
export function pairFilter(selection: PairSelection): RunFilter {
  const filter: RunFilter = {};
  if (selection.scenario !== undefined) filter.scenario = selection.scenario;
  if (selection.variant !== undefined) filter.variant = selection.variant;
  if (selection.e2e) filter.e2e = 'only';
  else if (selection.base !== undefined || selection.head !== undefined) filter.e2e = 'include';
  return filter;
}

/** The engine options, taken from config exactly as `vdiff diff` takes them. */
export function diffOptions(config: Config): DiffEngineOptions {
  return {
    minRegionArea: config.diff.minRegionArea,
    maxRegions: config.diff.maxRegions,
    antialiasTolerance: config.diff.antialiasTolerance,
    ignore: config.diff.ignore,
    engineVersion: DIFF_ENGINE_VERSION,
    deviceScaleFactor: DEFAULTS.deviceScaleFactor,
  };
}

/** Resolve the pair and produce its diff, reusing the stored one when the engine still matches. */
export async function resolveDiff(
  ctx: CommandContext,
  selection: PairSelection,
): Promise<ResolvedPair> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const store = await ctx.ports.openStore(config);
  const pair = await store.resolvePair(
    selection.flow,
    selection.base,
    selection.head,
    pairFilter(selection),
  );

  const options = diffOptions(config);
  const stored = await store.readDiff(pair);
  const reusable = stored !== null && stored.engineVersion === options.engineVersion;

  if (reusable && stored !== null) {
    return {
      config,
      pair,
      result: stored,
      path: store.diffFile(pair),
      cached: true,
      exportDir: store.exportDir(pair),
    };
  }

  const result = await ctx.ports.computeDiff(
    store.runDir(pair.flow, pair.base),
    store.runDir(pair.flow, pair.head),
    options,
  );
  const path = await store.writeDiff(pair, result);
  return { config, pair, result, path, cached: false, exportDir: store.exportDir(pair) };
}

/** The commands that reproduce a pair locally. Rendered into a comment's footer (CI spec §6). */
export function reproCommands(pair: PairRef): string[] {
  return [`vdiff diff ${pair.flow} ${pair.base} ${pair.head}`, 'vdiff serve --open'];
}
