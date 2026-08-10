/**
 * store/internal/e2e — the *source* axis of run identity (e2e spec §7, D27).
 *
 * Run identity was `(flow, revision, scenario, variant)`. E2E mode adds a fourth attribute, and it
 * is added exactly as the other two were (mocking §6, variants §5): a field of `meta.json`, never a
 * level of the path. Run ids stay monotonic per flow, filtering stays a query-time decision, and a
 * run ingested from a trace is `0007` of its flow like any other.
 *
 * Four things live here and nowhere else.
 *
 * - **A run written before this slice has no `source` key**, and must read as `replay` rather than
 *   as unknown. That is the `scenarioOf`/`variantOf` contract one axis over, for the same reason:
 *   every run the tool has ever written *was* a replay, which is a fact and not a fault.
 * - **The e2e metadata block.** §7 requires an ingested run to record the trace hash, the
 *   originating test title, and the suite metadata the trace provides. `traceHash` is load-bearing:
 *   it is the idempotency key (§6, "the same trace ingested twice produces one run"), so a run that
 *   claims `source: 'e2e'` without one is refused at commit rather than written and discovered
 *   later as a duplicate.
 * - **`UNKNOWN_REVISION`.** §7's "revision attribution comes from the trace's git metadata when
 *   present" is *false as written* — a Playwright trace archive carries no git metadata at any
 *   format version under any configuration (`captureGitInfo` writes to reporter output, not to the
 *   trace). So an ingested run's revision is unknown unless the caller supplies one, and unknown is
 *   recorded honestly. The spec's own reasoning stands unchanged: an e2e run silently attributed to
 *   whatever happens to be checked out locally is worse than one marked unknown.
 * - **The two warning kinds e2e ingestion raises.** `RunWarningKind` in `types.ts` is a closed
 *   union that does not yet carry them, so they are declared here as a structural widening —
 *   exactly as `variant.ts` widens `RunMeta` — and the message text is built in one place so no two
 *   call sites word the same warning differently.
 *
 * ### Why these types are declared here
 *
 * Same reason as `internal/variant.ts`: every type below is a structural extension of one that
 * lives in `src/types.ts` (`RunMeta & { source }`, `RunSummary & { source }`,
 * `RetentionConfig & { keepE2eRuns }`). The day `types.ts` grows the field this module becomes a
 * re-export and no call site changes.
 *
 * This module deliberately imports nothing from `./variant.js` at run time: `variant.ts` is where
 * the retention boundary is decided and it imports `isE2eRun` from here, so the value dependency
 * runs one way only.
 */

import { StoreError } from '../errors.js';
import type {
  RetentionConfig,
  Revision,
  RunMeta,
  RunWarning,
  RunWarningKind,
  ScenarioName,
  Sha256,
} from '../../types.js';
import type { DuplicateStepTitle } from './e2e-title.js';
import type {
  VariantConfig,
  VariantName,
  VariantRetentionConfig,
  VariantRunSummary,
} from './variant.js';

/* ------------------------------------------------------------------ the axis */

/** Where a run's artefacts came from (e2e spec §7). */
export type RunSource = 'replay' | 'e2e';

/** The tool captured this run itself, by replaying a flow. Every pre-e2e run is one of these. */
export const SOURCE_REPLAY = 'replay';

/** The run was ingested from an archive some other suite produced (D25). */
export const SOURCE_E2E = 'e2e';

export const RUN_SOURCES: readonly RunSource[] = [SOURCE_REPLAY, SOURCE_E2E];

/**
 * Runs kept per identity in the e2e bucket (§7, "retention is a separate bucket, as with
 * variants").
 *
 * Deliberately the same size as the timeline bucket rather than the smaller variant one. A variant
 * run is exploratory — five proposals, keep zero or one — and 10 is generous for that. An e2e run
 * is a regression point like any other; it is bucketed separately so a CI run's worth of traces
 * cannot evict replay history, not because it is worth less.
 */
export const DEFAULT_KEEP_E2E_RUNS = 20;

/* ------------------------------------------------------------------ metadata shape */

/**
 * The suite metadata an ingested run records (§7), and *only* what is really obtainable.
 *
 * Measured against real archives from Playwright 1.62.1, library-only and `@playwright/test`:
 * `browserName`, `channel`, `playwrightVersion`, `platform` and the trace format `version` are all
 * carried by the archive's `context-options` event. **`project` and `retry` are not.** Neither
 * appears anywhere in a trace zip; they exist only in the output directory name
 * (`…-chromium-desktop-retry2`). They are optional here so a caller that parsed the path can record
 * them and say so, and absent otherwise — never guessed.
 */
export interface E2eSuiteMeta {
  /** `context-options.browserName`, e.g. "chromium". */
  browser?: string;
  /** `context-options.channel` when the suite pinned one, e.g. "chrome". */
  channel?: string;
  /** The Playwright that wrote the archive, e.g. "1.62.1". */
  playwrightVersion?: string;
  /** `context-options.platform`, e.g. "darwin". */
  platform?: string;
  /** The trace format version integer on the archive's first event. */
  traceVersion?: number;
  /** Not in the archive at any version; only ever parsed from the output directory name. */
  project?: string;
  /** Likewise: retries appear only as a `-retryN` directory suffix. */
  retry?: number;
}

/** What an ingested run records about the archive it came from (§7). */
export interface E2eRunInfo {
  /**
   * Content hash of the archive, and the identity of the ingest (§6). Two ingests of one archive
   * find this hash already present and produce one run rather than two.
   */
  traceHash: Sha256;
  /**
   * The originating test title, verbatim and unnormalised — including the `path:line ›` prefix the
   * runner puts there. Kept as-is because it is the only thing that can be shown back to a user
   * looking for the test in their own repo; everything the tool *keys* on is `titleKey`.
   */
  testTitle: string;
  /**
   * The normalised title this run's flow and step ids were derived from (D26). Two ingests agree on
   * a flow because they agree on this string, so it is recorded rather than recomputed — a later
   * change to the normalisation rules must not silently re-key history.
   */
  titleKey: string;
  /**
   * The archive as the user named it, for the report and for `vdiff e2e list`. Display only: the
   * identity of an ingest is `traceHash`, never this path, so moving the archive changes nothing.
   */
  archive?: string;
  suite?: E2eSuiteMeta;
}

/**
 * Anything carrying a possibly-absent source: a `RunMeta`, or a raw parse of one off disk.
 *
 * Built on `Partial<RunMeta>` for the reason `MaybeVariant` is — a type whose every property is
 * optional is a weak type, and TypeScript would reject a real `RunMeta` argument against it.
 */
export type MaybeE2e = Partial<RunMeta> & {
  source?: RunSource;
  e2e?: E2eRunInfo;
  variant?: VariantName;
};

/** `RunMeta` with the source axis materialised, which is what the store writes and reads back. */
export type E2eRunMeta = RunMeta & { source: RunSource; e2e?: E2eRunInfo };

/** One timeline row with the source column (§7), on top of the variant one. */
export type E2eRunSummary = VariantRunSummary & { source: RunSource };

/** `retention:` with the third bucket (§7). */
export type E2eRetentionConfig = RetentionConfig & { keepE2eRuns: number };

/** `retention:` with all three buckets — what `buildConfig` produces. */
export type FullRetentionConfig = VariantRetentionConfig & { keepE2eRuns: number };

/** A fully-defaulted `Config` carrying every retention bucket. */
export type E2eConfig = Omit<VariantConfig, 'retention'> & { retention: FullRetentionConfig };

/**
 * Which e2e runs a listing shows.
 *
 * `exclude` is the default, and is what D27's "separate timeline" means: `vdiff runs <flow>` and
 * `vdiff diff <flow>` keep meaning the replay timeline, because §2 promises nothing about
 * `vdiff run` changes. `vdiff runs <flow> --e2e` is `only`.
 */
export type E2eFilter = 'exclude' | 'include' | 'only';

/* ------------------------------------------------------------------ reading the axis */

/**
 * The source a run was captured from. Absent, blank or unrecognised reads as `replay`: every run
 * written before this slice was one, and there is no third possibility to be ambiguous about.
 */
export function sourceOf(meta: MaybeE2e | null | undefined): RunSource {
  return parseRunSource(meta?.source) ?? SOURCE_REPLAY;
}

/** Parse a user-supplied source name (a `--source` argument). Null when it names neither. */
export function parseRunSource(value: unknown): RunSource | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === SOURCE_REPLAY) return SOURCE_REPLAY;
  if (trimmed === SOURCE_E2E) return SOURCE_E2E;
  return null;
}

/** Whether this run was ingested from someone else's suite rather than captured by the tool. */
export function isE2eRun(meta: MaybeE2e | null | undefined): boolean {
  return sourceOf(meta) === SOURCE_E2E;
}

/** Whether two runs sit on the same point of the source axis — the default pairing (D27). */
export function sameSource(a: MaybeE2e | null | undefined, b: MaybeE2e | null | undefined): boolean {
  return sourceOf(a) === sourceOf(b);
}

/** The e2e block of a run, or null — including for a run that carries one but is not e2e. */
export function e2eInfoOf(meta: MaybeE2e | null | undefined): E2eRunInfo | null {
  if (!isE2eRun(meta)) return null;
  const info = meta?.e2e;
  return info === undefined || info === null ? null : info;
}

/** The archive hash a run was ingested from, or null for a replay run. */
export function traceHashOf(meta: MaybeE2e | null | undefined): Sha256 | null {
  return e2eInfoOf(meta)?.traceHash ?? null;
}

/** `meta` with `source` guaranteed present, so in-memory code never sees the pre-e2e shape. */
export function normalizeE2eMeta(meta: RunMeta): RunMeta {
  const source = sourceOf(meta);
  return (meta as MaybeE2e).source === source ? meta : ({ ...meta, source } as RunMeta);
}

/* ------------------------------------------------------------------ the unknown revision */

/**
 * The sha of a run whose revision could not be established. A git sha is hex, so this can never be
 * mistaken for one, and `readRevision` refuses to produce a run without a real sha — so this value
 * only ever reaches disk through ingestion.
 */
export const REVISION_UNKNOWN_SHA = 'unknown';

/**
 * What §7 calls `revision: unknown`, as a `Revision` so nothing downstream has to special-case a
 * nullable field. There is no git metadata in a Playwright trace archive at any format version
 * under any configuration, so unless the caller supplies a revision from a flag, an environment
 * variable or a sibling reporter JSON, this is what an ingested run records.
 */
export const UNKNOWN_REVISION: Revision = { sha: REVISION_UNKNOWN_SHA, ref: null, dirty: false };

export function isUnknownRevision(revision: Revision | null | undefined): boolean {
  return revision === null || revision === undefined || revision.sha === REVISION_UNKNOWN_SHA;
}

/* ------------------------------------------------------------------ prose */

/** "a replay capture" / "an ingested e2e trace" — one phrasing, so no two messages disagree. */
export function describeSource(source: RunSource): string {
  return source === SOURCE_E2E ? 'an ingested e2e trace' : 'a replay capture';
}

/* ------------------------------------------------------------------ warnings */

/**
 * A pin in `e2e-map.yaml` that matched no ingested title (§8).
 *
 * The spec is explicit about why this is a warning and not silence: "a stale map entry silently
 * doing nothing is the same failure as a never-matched scenario rule". That warning
 * (`scenario-rule-unmatched`) is the mocking spec's single most important one, and this is the same
 * failure — a user believing a pin is in force while the tool derived a name from the title.
 */
export const E2E_MAP_UNMATCHED = 'e2e-map-unmatched';

/** Repeated step titles inside one test, disambiguated and reported once (§8). */
export const E2E_DUPLICATE_STEP_TITLES = 'e2e-duplicate-step-titles';

export type E2eRunWarningKind =
  | RunWarningKind
  | typeof E2E_MAP_UNMATCHED
  | typeof E2E_DUPLICATE_STEP_TITLES;

/** `RunWarning` widened by the two kinds above, plus the titles they are about. */
export type E2eRunWarning = Omit<RunWarning, 'kind'> & {
  kind: E2eRunWarningKind;
  /** Normalised titles this warning names — map pins, or repeated step titles. */
  titles?: string[];
};

/** `1 title` / `3 titles` — plural agreement in one place, since both warnings need it. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

/**
 * The §8 warning for map pins nothing matched. Returns null when every pin was used, so a caller
 * can append the result unconditionally.
 */
export function unmatchedMapWarning(titles: readonly string[]): E2eRunWarning | null {
  if (titles.length === 0) return null;
  const listed = [...titles];
  return {
    kind: E2E_MAP_UNMATCHED,
    message:
      `e2e-map.yaml pins ${count(listed.length, 'title')} no ingested trace contains: ` +
      `${quoteList(listed)} — each pin is doing nothing`,
    titles: listed,
  };
}

/**
 * The §8 notice for duplicate step titles within one test: "disambiguated with a stable suffix;
 * reported once as a notice". One warning for the whole test, never one per repeat.
 */
export type { DuplicateStepTitle };

export function duplicateStepTitlesWarning(
  testTitle: string,
  duplicates: readonly DuplicateStepTitle[],
): E2eRunWarning | null {
  if (duplicates.length === 0) return null;
  const listed = duplicates.map((entry) => `"${entry.title}" → ${entry.ids.slice(1).join(', ')}`);
  // The verb agrees with the count, not just the noun: "1 step title repeat" reads as a typo, and
  // a warning that reads as a typo is a warning users learn to skim past.
  const verb = duplicates.length === 1 ? 'repeats' : 'repeat';
  return {
    kind: E2E_DUPLICATE_STEP_TITLES,
    message:
      `${count(duplicates.length, 'step title')} ${verb} within "${testTitle}"; ` +
      `the repeats were numbered rather than merged: ${listed.join('; ')}`,
    titles: duplicates.map((entry) => entry.title),
  };
}

/* ------------------------------------------------------------------ commit-time invariants */

/**
 * Refuse a run whose source and metadata disagree, before it reaches disk.
 *
 * Every branch here is a wiring bug that would otherwise be discovered much later and much worse:
 * an e2e run with no `traceHash` re-ingests on every CI run, an e2e run carrying a variant lands in
 * the variant retention bucket and competes with proposals, and a replay run carrying an e2e block
 * claims a provenance it does not have.
 */
export function assertRunSourceConsistent(flow: string, meta: MaybeE2e): void {
  const source = sourceOf(meta);
  const info = meta.e2e;

  if (source === SOURCE_REPLAY) {
    if (info !== undefined && info !== null) {
      throw new StoreError(
        'e2e-source-mismatch',
        `run of flow "${flow}" carries e2e metadata but source "${SOURCE_REPLAY}"; ` +
          `an ingested run must record source "${SOURCE_E2E}"`,
      );
    }
    return;
  }

  if (info === undefined || info === null) {
    throw new StoreError(
      'e2e-meta-missing',
      `run of flow "${flow}" is marked source "${SOURCE_E2E}" but carries no e2e block; ` +
        'the trace hash and test title are what make ingestion idempotent',
    );
  }
  if (typeof info.traceHash !== 'string' || info.traceHash.trim() === '') {
    throw new StoreError(
      'e2e-meta-invalid',
      `e2e run of flow "${flow}" records no traceHash; without it the same archive ingests twice`,
    );
  }
  if (typeof info.testTitle !== 'string' || info.testTitle.trim() === '') {
    throw new StoreError(
      'e2e-meta-invalid',
      `e2e run of flow "${flow}" records no testTitle; it is what the flow and its step ids were derived from`,
    );
  }
  if (typeof info.titleKey !== 'string' || info.titleKey.trim() === '') {
    throw new StoreError(
      'e2e-meta-invalid',
      `e2e run of flow "${flow}" records no titleKey; it is what a later ingest matches this run by`,
    );
  }

  // §2: "No scenarios or variants over e2e runs. Both operate during capture, and e2e capture
  // already happened." Accepting either silently would also put the run in the wrong retention
  // bucket, which is the one boundary D24 and §7 both exist to protect.
  const variant = typeof meta.variant === 'string' ? meta.variant.trim() : '';
  if (variant !== '' && variant !== 'none') {
    throw new StoreError(
      'e2e-axis-conflict',
      `e2e run of flow "${flow}" was given variant "${variant}"; ` +
        'variants operate during capture, and an e2e trace was captured elsewhere',
    );
  }
  const scenario = typeof meta.scenario === 'string' ? (meta.scenario as ScenarioName).trim() : '';
  if (scenario !== '' && scenario !== 'none') {
    throw new StoreError(
      'e2e-axis-conflict',
      `e2e run of flow "${flow}" was given scenario "${scenario}"; ` +
        'scenarios operate during capture, and an e2e trace was captured elsewhere',
    );
  }
}

/* ------------------------------------------------------------------ configuration */

/**
 * The e2e retention bucket size, from a `retention:` block that may predate the key — read
 * defensively for the same reason `keepVariantRunsOf` is, so a config written before the key
 * existed gets the documented default instead of reaching the pruner as a cap of `undefined`.
 */
export function keepE2eRunsOf(
  retention: RetentionConfig | (RetentionConfig & { keepE2eRuns?: number }),
): number {
  const value = (retention as { keepE2eRuns?: unknown }).keepE2eRuns;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return DEFAULT_KEEP_E2E_RUNS;
  }
  return value;
}
