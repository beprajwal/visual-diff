/**
 * Pair resolution for the report (spec §8 cache, §9 API, §10 pruned-run row).
 *
 * Lookup order for a pair: in-memory cache → stored `findings.json` → the injected diff engine.
 * The engine is a pure function of two run directories, so recomputation is safe at any time; the
 * cache exists so reopening the report never recomputes (spec §8).
 *
 * A pair that references a pruned run returns {@link BackfillRequired} carrying the exact
 * `vdiff run --at <sha>` commands, rather than an error (spec §10).
 */

import type {
  BackfillRequired,
  Config,
  DiffEngineOptions,
  DiffResponse,
  DiffResult,
  RunId,
  RunMeta,
} from '../../types.js';
import { DEFAULTS, DIFF_ENGINE_VERSION } from '../../types.js';
import type { ComputeDiffFn, ReportStore } from './deps.js';
import { HttpError } from './http.js';

export interface DiffServiceOptions {
  store: ReportStore;
  config: Config;
  /** Absent means "serve stored diffs only" — nothing is computed and nothing is written. */
  computeDiff: ComputeDiffFn | null;
  engineVersion?: string;
}

export interface DiffService {
  /** Resolve a pair, computing it if necessary. */
  get(flow: string, base: RunId, head: RunId): Promise<DiffResponse>;
  /** True once the pair is available without computing (memory or disk). */
  has(flow: string, base: RunId, head: RunId): boolean;
  /** Drop memoized pairs for a flow; used when a new run lands. */
  invalidate(flow: string): void;
  readonly engineVersion: string;
}

export function isBackfillRequired(value: DiffResponse): value is BackfillRequired {
  return (value as BackfillRequired).error === 'pruned';
}

function backfillCommand(flow: string, meta: RunMeta): string {
  const ref = meta.revision.sha || meta.revision.ref || 'HEAD';
  return `vdiff run ${flow} --at ${ref}`;
}

export function createDiffService(options: DiffServiceOptions): DiffService {
  const { store, config, computeDiff } = options;
  const engineVersion = options.engineVersion ?? DIFF_ENGINE_VERSION;

  const cache = new Map<string, DiffResult>();
  const inFlight = new Map<string, Promise<DiffResponse>>();

  const key = (flow: string, base: RunId, head: RunId): string => `${flow}/${base}..${head}`;

  const engineOptionsFor = (baseMeta: RunMeta, headMeta: RunMeta): DiffEngineOptions => ({
    minRegionArea: config.diff.minRegionArea,
    maxRegions: config.diff.maxRegions,
    antialiasTolerance: config.diff.antialiasTolerance,
    ignore: config.diff.ignore,
    engineVersion,
    deviceScaleFactor:
      headMeta.env?.deviceScaleFactor ??
      baseMeta.env?.deviceScaleFactor ??
      DEFAULTS.deviceScaleFactor,
  });

  async function resolve(flow: string, base: RunId, head: RunId): Promise<DiffResponse> {
    const baseMeta = await store.readMeta(flow, base);
    const headMeta = await store.readMeta(flow, head);

    const unknown: RunId[] = [];
    if (!baseMeta) unknown.push(base);
    if (!headMeta) unknown.push(head);
    if (!baseMeta || !headMeta) {
      throw new HttpError(
        404,
        'unknown-run',
        `No such run in flow "${flow}": ${unknown.join(', ')}.`,
      );
    }

    const pruned = [baseMeta, headMeta].filter((m) => m.pruned);
    if (pruned.length > 0) {
      const response: BackfillRequired = {
        error: 'pruned',
        message: `${pruned
          .map((m) => `run ${m.runId}`)
          .join(' and ')} ${pruned.length === 1 ? 'was' : 'were'} pruned; replay to compare.`,
        backfill: pruned.map((m) => backfillCommand(flow, m)),
      };
      return response;
    }

    const stored = await store.readCachedDiff(flow, base, head);
    if (stored && stored.engineVersion === engineVersion) {
      cache.set(key(flow, base, head), stored);
      return stored;
    }

    if (!computeDiff) {
      throw new HttpError(
        503,
        'diff-unavailable',
        `No diff is stored for ${base}..${head} and this server was started without a diff engine.`,
        `Run: vdiff diff ${flow} ${base} ${head}`,
      );
    }

    const computed = await computeDiff(
      store.runDir(flow, base),
      store.runDir(flow, head),
      engineOptionsFor(baseMeta, headMeta),
    );
    cache.set(key(flow, base, head), computed);
    return computed;
  }

  return {
    engineVersion,

    has(flow, base, head) {
      return cache.has(key(flow, base, head));
    },

    invalidate(flow) {
      const prefix = `${flow}/`;
      for (const k of [...cache.keys()]) {
        if (k.startsWith(prefix)) cache.delete(k);
      }
    },

    async get(flow, base, head) {
      const k = key(flow, base, head);
      const memo = cache.get(k);
      if (memo) return memo;

      const pending = inFlight.get(k);
      if (pending) return pending;

      const work = resolve(flow, base, head).finally(() => {
        inFlight.delete(k);
      });
      inFlight.set(k, work);
      return work;
    },
  };
}
