/**
 * store/internal/variant — the variant axis of run identity (variants spec §5, D24).
 *
 * Run identity is `(flow, revision, scenario, variant)`. `variant` is recorded in `meta.json`
 * rather than in the run path, for exactly the four reasons `scenario` is (mocking spec §6): it is
 * an attribute of a run and not a level of hierarchy, run ids stay monotonic per flow, filtering at
 * query time is trivial where grouping at path time is rigid, and a variant name never inherits the
 * case-folding and reserved-name rules of a path component.
 *
 * Three things live here and nowhere else.
 *
 * - **A run written before this slice has no `variant` key at all** and must stay readable, so
 *   every read of a run's variant goes through `variantOf`, which answers `VARIANT_NONE` for it.
 *   That is the same contract `scenarioOf` provides one axis over, and for the same reason: a run
 *   captured without a variant genuinely had none, which is a fact rather than a fault.
 * - **The two retention buckets.** A variant run is exploratory — you try five arrangements and
 *   keep zero or one — so letting variant runs share the regression bucket would evict the capture
 *   history regressions depend on, which is a quiet data loss at exactly the wrong moment (D24).
 *   `retentionBucketOf` is the only place that boundary is decided.
 * - **`sameRevision`**, because the default comparison for a variant run is *same revision, variant
 *   versus none* (D24). "Same revision" has to mean the same code, so a dirty working tree is part
 *   of it: two dirty runs at one sha are the same revision only if their `dirtyHash` agrees.
 *
 * ### Why these types are declared here
 *
 * `src/types.ts` is the shared contract file and does not yet carry the variant axis. Every type
 * below is a *structural* extension of one that lives there — `RunMeta & { variant }`,
 * `RunSummary & { variant, kept }`, `RetentionConfig & { keepVariantRuns }` — so the day the field
 * is promoted into `types.ts`, this module becomes a re-export and no call site changes. Nothing
 * here invents a parallel shape for something `types.ts` already describes.
 */

import { SCENARIO_NONE } from '../../types.js';
import { isE2eRun, isUnknownRevision, sourceOf } from './e2e.js';
import type { MaybeE2e } from './e2e.js';
import { scenarioOf } from './scenario.js';
import type {
  Config,
  RetentionConfig,
  Revision,
  RunMeta,
  RunSummary,
  ScenarioName,
} from '../../types.js';

/** Variant name, matching the filename stem of `.visual-diff/variants/<name>.yaml`. */
export type VariantName = string;

/**
 * The variant recorded for a run that had none (variants spec §5). Reserved exactly as
 * `SCENARIO_NONE` is (§7: "`none` is reserved"), so `meta.variant === VARIANT_NONE` unambiguously
 * means "captured against the unmodified page" and never "we do not know".
 */
export const VARIANT_NONE = 'none';

/** Runs kept in the variant bucket per `(flow, scenario, variant)` (variants spec §5). */
export const DEFAULT_KEEP_VARIANT_RUNS = 10;

/**
 * Anything carrying a possibly-absent variant: a `RunMeta`, or a raw parse of one off disk.
 *
 * Built on `Partial<RunMeta>` rather than declared as two optional keys on their own. A type whose
 * every property is optional is a *weak type*, and TypeScript rejects an argument that shares no
 * property with it — which is exactly what a `RunMeta` is until `types.ts` grows the field. Widening
 * it this way keeps `variantOf(meta)` callable on a real run while still rejecting `{ varaint: … }`.
 */
export type MaybeVariant = Partial<RunMeta> & {
  variant?: VariantName;
  /**
   * `--keep`: this variant run was promoted into the permanent timeline (variants spec §5). Absent
   * and false are the same thing — an unpromoted, ephemeral proposal.
   */
  kept?: boolean;
};

/** `RunMeta` with the variant axis materialised, which is what the store writes and reads back. */
export type VariantRunMeta = RunMeta & { variant: VariantName; kept?: boolean };

/** One timeline row, with the variant column and the promotion flag (variants spec §5, §6). */
export type VariantRunSummary = RunSummary & { variant: VariantName; kept: boolean };

/** `retention:` with the second bucket (variants spec §5). */
export type VariantRetentionConfig = RetentionConfig & { keepVariantRuns: number };

/** A fully-defaulted `Config` carrying the variant retention bucket. */
export type VariantConfig = Omit<Config, 'retention'> & { retention: VariantRetentionConfig };

/**
 * Which variant runs a listing shows.
 *
 * `exclude` is the default and is what D24 means by "excluded from the regression timeline": an
 * *ephemeral* variant run is invisible to `vdiff runs <flow>`. A promoted run is not — promotion is
 * precisely the act of moving it into that timeline — so `kept` runs survive every filter.
 * `vdiff runs <flow> --variants` is `only`.
 */
export type VariantFilter = 'exclude' | 'include' | 'only';

/**
 * Which retention bucket a run belongs to. The boundary eviction may never cross (D24, e2e §7).
 *
 * `e2e` was added by the e2e slice for the same reason `variant` exists one slice earlier: a batch
 * of runs that arrives in bulk and answers a different question must not be able to shorten the
 * regression history. Ingesting a CI run's worth of traces is the largest such batch the tool will
 * ever see.
 */
export type RetentionBucket = 'timeline' | 'variant' | 'e2e';

/* ------------------------------------------------------------------ reading the axis */

/**
 * The variant a run was captured under. Absent, blank or non-string reads as `VARIANT_NONE`: a run
 * captured before this slice genuinely had no variant.
 */
export function variantOf(meta: MaybeVariant | null | undefined): VariantName {
  const raw = meta?.variant;
  if (typeof raw !== 'string') return VARIANT_NONE;
  const trimmed = raw.trim();
  return trimmed === '' ? VARIANT_NONE : trimmed;
}

/** Normalise a user-supplied variant name (a `--variant` argument) the same way a run's is. */
export function normalizeVariantName(name: VariantName | undefined): VariantName {
  return variantOf(name === undefined ? {} : { variant: name });
}

/** Whether this run rendered a proposal rather than the application as it stands. */
export function isVariantRun(meta: MaybeVariant | null | undefined): boolean {
  return variantOf(meta) !== VARIANT_NONE;
}

/** Whether `--keep` promoted this run into the permanent timeline (variants spec §5). */
export function isKept(meta: MaybeVariant | null | undefined): boolean {
  return meta?.kept === true;
}

/**
 * A variant run that has *not* been promoted: the exploratory capture D24 keeps out of the
 * regression timeline and in its own retention bucket.
 */
export function isEphemeralVariantRun(meta: MaybeVariant | null | undefined): boolean {
  return isVariantRun(meta) && !isKept(meta);
}

/** Whether two runs sit on the same point of the variant axis. */
export function sameVariant(a: MaybeVariant, b: MaybeVariant): boolean {
  return variantOf(a) === variantOf(b);
}

/** `meta` with `variant` guaranteed present, so in-memory code never sees the pre-variant shape. */
export function normalizeVariantMeta(meta: RunMeta): RunMeta {
  const variant = variantOf(meta);
  return (meta as MaybeVariant).variant === variant ? meta : ({ ...meta, variant } as RunMeta);
}

/* ------------------------------------------------------------------ identity and buckets */

/**
 * The retention bucket of a run (D24, e2e §7).
 *
 * A promoted run is in `timeline` even though it ran a variant: `--keep` moves it into the
 * permanent timeline, and a promoted run that stayed under the ephemeral cap would be evicted by
 * the next five proposals — which is the opposite of what promoting it asked for.
 *
 * The e2e test comes first, and deliberately. `commit` refuses to write a run that is both e2e and
 * varied (§2: neither scenarios nor variants apply to a capture that already happened), but this
 * function is also asked about `meta.json` files it did not write. If such a file ever appeared,
 * answering `variant` would let ingested runs compete with proposals for the ephemeral bucket, and
 * the isolation §7 asks for would be gone in the one case it was most needed.
 *
 * **This is the only place the boundary is decided**, which is why it is the one function that has
 * to know about every axis that can move a run across it.
 */
export function retentionBucketOf(
  meta: (MaybeVariant & MaybeE2e) | null | undefined,
): RetentionBucket {
  if (isE2eRun(meta)) return 'e2e';
  return isEphemeralVariantRun(meta) ? 'variant' : 'timeline';
}

/**
 * The key runs are grouped by for retention and for the timeline's findings column: the identity
 * axes that are attributes of a run rather than of a revision.
 *
 * The source axis joins it here (e2e §7, D27). Without it the timeline's findings column would
 * count an ingested run against the replay run before it — a number produced from a pair the diff
 * command would never choose by default, comparing a lossy 800px-wide JPEG from someone else's CI
 * against a replay screenshot, and reported as though it were a regression.
 *
 * NUL-separated because no scenario, variant or source name may contain a control character, so no
 * pair of distinct identities can collide on one key.
 */
export function runIdentityKey(meta: (MaybeVariant & MaybeE2e) | null): string {
  return `${sourceOf(meta)}\u0000${scenarioOf(meta)}\u0000${variantOf(meta)}`;
}

/**
 * Whether two runs were captured from the same code.
 *
 * `ref` is deliberately not compared — the same commit reached from two branch names is the same
 * code. `dirty` and `dirtyHash` are: the proposal question is "this variant against the unmodified
 * page *at this revision*", and a variant rendered over uncommitted work only answers it against a
 * baseline of that same uncommitted work.
 */
export function sameRevision(
  a: Revision | null | undefined,
  b: Revision | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  // Two runs that both recorded `revision: unknown` are not known to be the same code — they are
  // two runs nothing is known about (e2e §7). Ingested runs share that sha by construction, so
  // treating it as a match would silently make every pair of them "the same revision".
  if (isUnknownRevision(a) || isUnknownRevision(b)) return false;
  if (a.sha !== b.sha || a.dirty !== b.dirty) return false;
  return (a.dirtyHash ?? null) === (b.dirtyHash ?? null);
}

/* ------------------------------------------------------------------ prose */

/** "no variant" / "variant 'denser-forecast'" — one phrasing, so no two messages disagree. */
export function describeVariant(name: VariantName): string {
  return name === VARIANT_NONE ? 'no variant' : `variant '${name}'`;
}

/** "9f8e7d6" / "9f8e7d6 (dirty)" — enough to tell two revisions apart in a warning. */
export function describeRevision(revision: Revision | null | undefined): string {
  if (isUnknownRevision(revision)) return 'an unknown revision';
  const known = revision as Revision;
  return known.dirty ? `${known.sha} (dirty)` : known.sha;
}

/** The `vdiff run` invocation that would capture a run of this identity — used in error hints. */
export function captureHint(flow: string, scenario: ScenarioName, variant: VariantName): string {
  let hint = `vdiff run ${flow}`;
  if (scenario !== SCENARIO_NONE) hint += ` --scenario ${scenario}`;
  if (variant !== VARIANT_NONE) hint += ` --variant ${variant}`;
  return hint;
}

/* ------------------------------------------------------------------ configuration */

/**
 * The variant retention bucket size, from a `retention:` block that may predate the key.
 *
 * Reading defensively rather than requiring the widened type keeps every caller that holds a plain
 * `Config` working, and a config written before `keepVariantRuns` existed gets the documented
 * default instead of `undefined` reaching the pruner as a cap of zero.
 */
export function keepVariantRunsOf(
  retention: RetentionConfig | (RetentionConfig & { keepVariantRuns?: number }),
): number {
  const value = (retention as { keepVariantRuns?: unknown }).keepVariantRuns;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return DEFAULT_KEEP_VARIANT_RUNS;
  }
  return value;
}
