import { sameTolerance } from '../../diff/tolerance.js';
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
  FINDING_KINDS,
  type Config,
  type DiffEmitChannels,
  type DiffEngineOptions,
  type DiffResult,
  type FindingKind,
  type PairRef,
  type Review,
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
  /** `--no-findings`: compute the pixel diff and emit no findings (D54). */
  noFindings?: boolean;
  /** `--no-warnings`: store an empty warnings list (D54). */
  noWarnings?: boolean;
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
  /**
   * The stored `review.json` for this pair (CI spec D39), or null. Read here so `comment` and
   * `export` render the same review — or the same absence of one — for the same pair; a review of
   * a diff since recomputed under another engine version reads as null, as the store promises.
   */
  review: Review | null;
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

/**
 * The engine options, taken from config exactly as `vdiff diff` takes them.
 *
 * The flag wins over the file, in one direction only: `--no-findings` turns a channel off that
 * config left on, and there is no flag that turns one back on. A project that wrote
 * `diff.findings: false` decided that for every invocation, and a switch that could be undone per
 * command is a switch whose effect nobody can predict from the config.
 */
export function diffOptions(config: Config, selection?: PairSelection): DiffEngineOptions {
  const emitFindings = config.diff.findings !== false && selection?.noFindings !== true;
  const emitWarnings = config.diff.warnings !== false && selection?.noWarnings !== true;
  return {
    minRegionArea: config.diff.minRegionArea,
    maxRegions: config.diff.maxRegions,
    antialiasTolerance: config.diff.antialiasTolerance,
    ...(config.diff.maxChangedPixelRatio === undefined ? {} : { maxChangedPixelRatio: config.diff.maxChangedPixelRatio }),
    ...(config.diff.layout === undefined ? {} : { layout: config.diff.layout }),
    ignore: config.diff.ignore,
    engineVersion: DIFF_ENGINE_VERSION,
    deviceScaleFactor: DEFAULTS.deviceScaleFactor,
    emitFindings,
    emitWarnings,
    // Only when the project narrowed it: absent means every kind, which is what the engine and the
    // cache key both already mean by "no list" (D57).
    ...(sameKinds(config.diff.kinds, FINDING_KINDS) ? {} : { kinds: [...config.diff.kinds] }),
  };
}

/**
 * The kinds this diff was not allowed to emit, in the vocabulary's order, or empty.
 *
 * Named here so the CLI, the comment and the report rail say the same thing about the same diff: an
 * absent `console` finding means "none happened" or "nobody looked", and those must not read alike
 * (D57).
 */
export function omittedKindsOf(result: DiffResult): FindingKind[] {
  const allowed = emitChannelsOf(result).kinds;
  if (allowed === undefined) return [];
  return FINDING_KINDS.filter((kind) => !allowed.includes(kind));
}

/** Whether two kind lists say the same thing. Order and duplicates are not the choice. */
function sameKinds(a: readonly FindingKind[], b: readonly FindingKind[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((kind) => right.has(kind));
}

/** What a stored diff was computed with (D54). No `emit` block means both channels were on. */
export function emitChannelsOf(result: DiffResult): DiffEmitChannels {
  return result.emit ?? { findings: true, warnings: true };
}

/**
 * Whether a stored diff answers the question this invocation is asking.
 *
 * The engine version is not enough on its own. A diff computed under `--no-findings` carries an
 * empty findings list, and reusing it for a caller that wants findings would report "no findings"
 * for a pair nobody has looked at — the one wrong answer this cache must never give. The reverse
 * costs one recompute.
 */
function answersThisRequest(stored: DiffResult, options: DiffEngineOptions): boolean {
  const emitted = emitChannelsOf(stored);
  return (
    sameTolerance(stored.tolerance, options) &&
    emitted.findings === (options.emitFindings !== false) &&
    emitted.warnings === (options.emitWarnings !== false) &&
    sameKinds(emitted.kinds ?? FINDING_KINDS, options.kinds ?? FINDING_KINDS)
  );
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

  const options = diffOptions(config, selection);
  const stored = await store.readDiff(pair);
  const reusable =
    stored !== null &&
    stored.engineVersion === options.engineVersion &&
    answersThisRequest(stored, options);

  if (reusable && stored !== null) {
    return {
      config,
      pair,
      result: stored,
      path: store.diffFile(pair),
      cached: true,
      exportDir: store.exportDir(pair),
      review: await store.readReview(pair, stored.engineVersion),
    };
  }

  const result = await ctx.ports.computeDiff(
    store.runDir(pair.flow, pair.base),
    store.runDir(pair.flow, pair.head),
    options,
  );
  const path = await store.writeDiff(pair, result);
  // A freshly computed diff has no review yet by definition: whatever `review.json` may be on disk
  // described the previous engine's findings, and the engine-version check says so.
  return {
    config,
    pair,
    result,
    path,
    cached: false,
    exportDir: store.exportDir(pair),
    review: await store.readReview(pair, result.engineVersion),
  };
}

/** The commands that reproduce a pair locally. Rendered into a comment's footer (CI spec §6). */
export function reproCommands(pair: PairRef): string[] {
  return [`vdiff diff ${pair.flow} ${pair.base} ${pair.head}`, 'vdiff serve --open'];
}
