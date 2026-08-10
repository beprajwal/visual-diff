/**
 * cli — the source axis, as the CLI reads and prints it (e2e spec §6, §7, §8).
 *
 * E2E mode ingests artifacts a test suite already produced and turns each test into a run the store,
 * the diff engine and the report can handle (D25). Nothing about `vdiff run` changes: `vdiff e2e` is
 * a separate command over files that already exist, and the runs it writes are marked
 * `source: 'e2e'` so every later command can tell them apart from replays.
 *
 * The *run identity* half — `sourceOf` / `isE2eRun`, the tolerant reads of the field a run carries;
 * `classifySourcePair`, which decides what a selected pair is once ingested runs are in play; the
 * degraded-diff explanation; and the sentences printed for all of it — is re-exported from
 * `report/e2e.ts` rather than restated, exactly as the variant axis is re-exported from
 * `report/variant.ts`. Both front-ends print those sentences, and the rule that decides whether a
 * mixed pair is a regression or an artefact is precisely the kind of thing that drifts when it is
 * written down twice. The direction of the import is the one that already exists — the CLI loads the
 * report module to serve it — and what it reaches for is a leaf: pure functions over `meta.json`.
 *
 * What lives *here* rather than there is the vocabulary of the command itself: which artifact
 * formats `--from` accepts, and how the ingestion's answers are named in `--json`.
 */

export {
  classifySourcePair,
  describeDegradedDiff,
  describeE2eOrigin,
  describeE2eRevision,
  describeSourcePair,
  e2eOriginOf,
  isE2eRun,
  isE2eWarningKind,
  isHighSeverityE2eWarningKind,
  isRunSource,
  showSource,
  sourceOf,
  E2E_DEGRADED_SENTENCES,
  E2E_MISSING_LAYERS,
  E2E_WARNING_KINDS,
  RUN_SOURCES,
  SOURCE_E2E,
  SOURCE_REPLAY,
  type E2eOrigin,
  type E2eWarningKind,
  type RunSource,
  type SourcePair,
  type SourcePairLabel,
  type SourcePairSide,
} from '../report/e2e.js';

/* ------------------------------------------------------------------ `--from` (§2, §6) */

/**
 * Artifact formats `vdiff e2e --from <format>` accepts.
 *
 * One entry, and the flag exists anyway. The spec's non-goals are explicit that Cypress and
 * WebdriverIO are out of scope *for this slice* while the ingestion layer stays format-agnostic
 * internally, so a second reader can be added without reshaping the pipeline (§2). A flag with one
 * legal value today is what makes that true of the command line as well: adding a reader is a new
 * entry in this array, not a new command whose flags have to be kept parallel by hand.
 *
 * It is also why the error for an unknown format lists what *is* supported rather than saying
 * "trace" — the list is generated from here, so it cannot go stale.
 */
export const E2E_SOURCE_FORMATS = ['trace'] as const;

export type E2eSourceFormat = (typeof E2E_SOURCE_FORMATS)[number];

/** True for a string naming a reader this build ships. */
export function isE2eSourceFormat(value: string): value is E2eSourceFormat {
  return (E2E_SOURCE_FORMATS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ output (§6) */

/**
 * How many archives a plan holds, said in words rather than as a bare integer.
 *
 * Used by both `vdiff e2e` and `vdiff e2e list`, so the two commands cannot describe the same
 * pattern differently — which they would, eventually, if each formatted its own count.
 */
export function countArchives(count: number): string {
  return count === 1 ? '1 trace archive' : `${count} trace archives`;
}
