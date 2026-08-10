/**
 * The **source** axis of run identity — how a run came to exist (e2e spec §7).
 *
 * Slice 1 had one answer: the tool replayed a flow spec. E2E mode adds a second: the run was
 * *ingested* from a Playwright trace that somebody else's test suite produced (D25). `meta.json`
 * records which, as `source: 'replay' | 'e2e'`, defaulting to `replay`.
 *
 * This file is the third of the same shape as `attribution.ts` (scenarios) and `variant.ts`
 * (proposals), and it is here rather than in `cli/` for the same reason those are: both front-ends
 * print these sentences, and the rule for *what a mixed pair means* decides whether findings read as
 * a regression or as an artefact of two incomparable capture methods. Written down twice, the two
 * copies would eventually disagree about which. `cli/e2e.ts` re-exports it.
 *
 * Everything here is a tolerant read of `meta.json` rather than a required field, exactly as
 * `variantOf` is: a store written before this slice has no `source` key at all, and those runs were
 * genuinely replays. Reading them as such is a fact, not a default.
 *
 * What is deliberately **not** here: anything that opens a trace archive. This module is a leaf —
 * pure functions over objects already read off disk, no zip reader, no Playwright, no store.
 */

import type { Revision } from '../types.js';

/* ------------------------------------------------------------------ the axis (§7) */

/** A run the tool produced itself, by replaying a flow spec. The slice-1 world, and the default. */
export const SOURCE_REPLAY = 'replay';

/** A run ingested from an artifact a test suite already produced (D25). */
export const SOURCE_E2E = 'e2e';

export type RunSource = typeof SOURCE_REPLAY | typeof SOURCE_E2E;

/** Both values, in the order output lists them. */
export const RUN_SOURCES: readonly RunSource[] = [SOURCE_REPLAY, SOURCE_E2E];

/** True for a string that names a source this build understands. */
export function isRunSource(value: unknown): value is RunSource {
  return value === SOURCE_REPLAY || value === SOURCE_E2E;
}

/**
 * The source a run was recorded with.
 *
 * Takes `object` rather than `{ source?: … }` so a `RunMeta`, a timeline row or a raw parsed
 * `meta.json` are all acceptable arguments today and stay acceptable when the field is promoted
 * into `src/types.ts`. An unrecognised value reads as `replay` rather than throwing: a run written
 * by a newer build than this one is still a run, and refusing to list it would be a worse answer
 * than describing it conservatively.
 */
export function sourceOf(run: object | null | undefined): RunSource {
  const raw = (run as { source?: unknown } | null | undefined)?.source;
  return isRunSource(raw) ? raw : SOURCE_REPLAY;
}

/** True when this run was ingested from a test suite's artifact rather than replayed. */
export function isE2eRun(run: object | null | undefined): boolean {
  return sourceOf(run) === SOURCE_E2E;
}

/** How a source reads in output. `replay` is the unmarked case and says so plainly. */
export function showSource(source: RunSource): string {
  return source === SOURCE_E2E ? 'e2e' : 'replay';
}

/* ------------------------------------------------------------------ origin (§7) */

/**
 * What an ingested run records about where it came from (§7).
 *
 * Every field is optional, and that is the point: a Playwright trace is not a manifest, and the
 * things the spec assumed it would carry are mostly not in it.
 *
 *  - `browser`, `playwrightVersion` and `platform` **are** in the archive, on the `context-options`
 *    event that opens every `*.trace` stream.
 *  - `title` is in the archive only when the runner wrote it, or when whoever started tracing passed
 *    one. A library-only trace has no test concept at all.
 *  - `project` and `retry` are **not** in the archive at any version under any configuration. They
 *    exist only in the output directory's name (`…-chromium-desktop-retry2`), so they are present
 *    here when ingestion parsed that path and absent when it could not — never guessed.
 *  - There is no git metadata in a trace archive, at any version, under any configuration. That is
 *    why there is no `revision` field here: revision attribution comes from the run's own
 *    `meta.json`, where it is `unknown` unless it was supplied (see {@link describeE2eRevision}).
 */
export interface E2eOrigin {
  /** Content hash of the archive. Ingestion is idempotent on it (§6). */
  traceHash?: string;
  /** Absolute or project-relative path of the archive that was read. */
  tracePath?: string;
  /** The test title the flow name was derived from (D26); absent when the trace carries none. */
  title?: string;
  /** Playwright trace format version — the integer on the first line of each `*.trace` stream. */
  traceVersion?: number;
  browser?: string;
  /** Browser channel, when the suite pinned one (`chrome`, `msedge`, …). */
  channel?: string;
  playwrightVersion?: string;
  platform?: string;
  /** Project name, parsed from the output directory. Absent when there was no path to parse. */
  project?: string;
  /** Retry index, parsed from the output directory's `-retryN` suffix. Absent when there was none. */
  retry?: number;
}

const ORIGIN_STRINGS = [
  'traceHash',
  'tracePath',
  'title',
  'browser',
  'channel',
  'playwrightVersion',
  'platform',
  'project',
] as const;

const ORIGIN_NUMBERS = ['traceVersion', 'retry'] as const;

/**
 * The origin block off a run, read tolerantly.
 *
 * Returns null for a run that carries none — which is every replay run, and also an e2e run written
 * by a build that recorded less than this one reads. A caller gets "nothing to say" rather than an
 * object of undefineds it has to test field by field.
 */
export function e2eOriginOf(run: object | null | undefined): E2eOrigin | null {
  const raw = (run as { e2e?: unknown } | null | undefined)?.e2e;
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  // What ingestion actually writes is `E2eRunInfo`: the test title under `testTitle`, the archive
  // path under `archive`, and the capture conditions nested under `suite` (e2e §7). Those names are
  // the ones the store validates at commit, so they are what a real `meta.json` carries — the flat
  // spellings below are read first only because they are what a caller constructing an origin by
  // hand writes, and because reading both is what makes this a tolerant reader rather than a schema.
  const suite = record['suite'];
  const nested = suite !== null && typeof suite === 'object' ? (suite as Record<string, unknown>) : {};
  const aliases: Record<string, unknown> = {
    title: record['testTitle'],
    tracePath: record['archive'],
    ...nested,
  };
  const pick = (key: string): unknown => (record[key] === undefined ? aliases[key] : record[key]);

  const origin: E2eOrigin = {};
  for (const key of ORIGIN_STRINGS) {
    const value = pick(key);
    if (typeof value === 'string' && value.trim() !== '') origin[key] = value;
  }
  for (const key of ORIGIN_NUMBERS) {
    const value = pick(key);
    if (typeof value === 'number' && Number.isFinite(value)) origin[key] = value;
  }
  return Object.keys(origin).length === 0 ? null : origin;
}

/**
 * One line describing where an ingested run came from, or null when it says nothing.
 *
 * Only fields that are genuinely present are named. A trace that carried no test title produces a
 * sentence about the browser and nothing else, rather than "test: undefined" — an ingested run
 * whose origin is thinly recorded is the ordinary case for library-only tracing, not a fault.
 */
export function describeE2eOrigin(origin: E2eOrigin | null): string | null {
  if (origin === null) return null;
  const parts: string[] = [];
  if (origin.title !== undefined) parts.push(`test ${origin.title}`);
  if (origin.browser !== undefined) {
    parts.push(origin.channel === undefined ? origin.browser : `${origin.browser} (${origin.channel})`);
  }
  if (origin.project !== undefined) parts.push(`project ${origin.project}`);
  if (origin.retry !== undefined) parts.push(`retry ${origin.retry}`);
  if (origin.playwrightVersion !== undefined) parts.push(`Playwright ${origin.playwrightVersion}`);
  if (origin.traceVersion !== undefined) parts.push(`trace v${origin.traceVersion}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The sentence an e2e run's revision needs (§7, §8).
 *
 * A Playwright trace archive carries no git metadata — not at any format version, and not under any
 * configuration. `captureGitInfo` writes the commit into the *reporter's* metadata, which never
 * enters the trace zip. So an ingested run records `revision: unknown` unless somebody supplied one,
 * and the report says so rather than letting the reader assume the run belongs to whatever happens
 * to be checked out locally.
 *
 * Returns null when the revision *is* known, because then there is nothing to explain.
 */
export function describeE2eRevision(revision: Revision | null | undefined): string | null {
  const sha = revision?.sha;
  if (typeof sha === 'string' && sha.trim() !== '') return null;
  return (
    'revision unknown: a Playwright trace records no git metadata, so this run is not attributed' +
    ' to a commit rather than being attributed to the wrong one'
  );
}

/* ------------------------------------------------------------------ the degraded diff (§4) */

/**
 * Capture layers slice 1 records and a trace archive does not, in the order §4's table lists them.
 *
 * `element box metrics` is the one that changes what a finding can *be*: a snapshot serialises
 * attributes, never rectangles, so every ingested node arrives with a zero rect, no pixel region
 * intersects any node, and on a pair of ingested runs no finding can name an element at all. The
 * computed-style subset is what removes property-level findings; the accessibility tree is simply
 * absent. All three are stated rather than silently missing, because a report that shows fewer,
 * vaguer findings without explaining why reads as a report that missed things.
 */
export const E2E_MISSING_LAYERS = [
  'computed-style subset',
  'accessibility tree',
  'element box metrics',
] as const;

/**
 * The reason codes a finding carries when it is a changed region nobody could attribute.
 *
 * Declared here as plain strings rather than imported from the diff engine, for the same reason
 * {@link E2E_WARNING_KINDS} is: the report reads `findings.json` off disk and has to recognise what
 * a *stored* finding carries, which is a fact about a file rather than about the union this build
 * compiles against.
 */
export const PIXELS_ONLY_REASON = 'pixels-only';
export const E2E_DEGRADED_REASON = 'e2e-degraded';

/** Just enough of a stored finding to ask whether it explains anything beyond its pixels. */
export interface AttributableFinding {
  element?: unknown;
  reasons?: readonly string[];
}

/**
 * True for a finding that reports changed pixels and names nothing — every finding of an e2e pair.
 *
 * The three conditions are one fact seen from three sides: no element was attributed, the region
 * was reported on pixels alone, and the pair had an ingested side. Requiring all three keeps the
 * sentence off the *replay* pair's occasional unattributed canvas repaint, which has a different
 * cause and a different remedy.
 */
export function isPixelsOnlyFinding(finding: AttributableFinding | null | undefined): boolean {
  const reasons = finding?.reasons ?? [];
  if (finding?.element !== undefined && finding?.element !== null) return false;
  return reasons.includes(PIXELS_ONLY_REASON) && reasons.includes(E2E_DEGRADED_REASON);
}

/**
 * The sentence such a finding earns, rendered under it.
 *
 * On the finding rather than only in the banner because a finding is what gets linked, filtered,
 * exported and pasted into a review: the qualification has to travel with it.
 */
export const PIXELS_ONLY_FINDING_NOTE =
  'no element: this pair is a pixel comparison — a trace snapshot carries no box metrics, so this' +
  ' region could not be attributed to an element and there is no property-level explanation for it';

/**
 * What an e2e diff can and cannot report (§4).
 *
 * Three sentences, because there are three separate things a reader would otherwise mis-read as a
 * defect. The first exists in two versions, because two genuinely different things are true:
 *
 *  1. **Pixels only, on a pair of ingested runs.** A trace's DOM snapshot is attributes only — no
 *     resolved styles, and no box metrics for anything. Regions are detected; nothing can be
 *     attributed to an element, and no property can be compared. The diff reports *where* the
 *     screenshot changed and stops there.
 *     On a **mixed** pair the replayed side still has geometry, so a region can still be named —
 *     through that side alone — which is a different claim and gets its own sentence.
 *  2. **Shared screenshots.** A trace's images come from a throttled screencast, not from one
 *     capture per action, so several steps legitimately resolve to the same frame. Identical images
 *     under different step ids are expected. Presenting that as a fault would be the report
 *     inventing a problem.
 *  3. **Viewport-only, lossy images.** Frames are JPEG, downscaled to fit an 800×800 box, and show
 *     the viewport at whatever scroll offset the page was at — never the full page. Small
 *     differences against a replay run's full-page PNG are the codec and the crop, not the UI.
 */
export const E2E_PIXELS_ONLY_SENTENCE =
  'pixel comparison only: a Playwright trace records DOM structure but no computed styles and no' +
  ' box metrics, so no finding from this pair can name the element or the property behind a' +
  ' change — a renamed heading appears as a changed region and nothing more';

export const E2E_MIXED_ATTRIBUTION_SENTENCE =
  'element detail comes from the replayed run alone: the ingested run records DOM structure but no' +
  ' computed styles and no box metrics, so no property-level finding is possible and any element' +
  ' named below was located in the replayed run only';

export const E2E_SHARED_FRAME_SENTENCE =
  'steps may share one screenshot: a trace records a throttled screencast, not one frame per' +
  ' action, so identical images under different step ids are expected rather than a fault';

export const E2E_LOSSY_FRAME_SENTENCE =
  'screenshots are viewport-only and lossy: JPEG, downscaled to fit 800×800, captured at whatever' +
  ' scroll offset the page was at — never the full page';

/**
 * The e2e-pair wording, which is the wording for the pair e2e mode exists to produce.
 *
 * Kept as an array under the original name because both front-ends print `slice(1)` of it as the
 * lines *below* the headline sentence, and those two lines are true of a mixed pair as well.
 * {@link e2eDegradedSentences} is what a caller should use when it knows which pair it has.
 */
export const E2E_DEGRADED_SENTENCES: readonly string[] = [
  E2E_PIXELS_ONLY_SENTENCE,
  E2E_SHARED_FRAME_SENTENCE,
  E2E_LOSSY_FRAME_SENTENCE,
];

/** The same three sentences, with the first one chosen for the pair actually in hand. */
export function e2eDegradedSentences(pair: SourcePair): readonly string[] {
  if (!pair.degraded) return [];
  const headline =
    pair.base === SOURCE_E2E && pair.head === SOURCE_E2E
      ? E2E_PIXELS_ONLY_SENTENCE
      : E2E_MIXED_ATTRIBUTION_SENTENCE;
  return [headline, E2E_SHARED_FRAME_SENTENCE, E2E_LOSSY_FRAME_SENTENCE];
}

/**
 * The e2e-pair explanation as one line, for output that has room for only one.
 *
 * "pixel comparison only" and not "reduced detail": the second implies some element-level
 * explanation survived, and none does. A reader who takes only the first three words away from this
 * sentence still believes something true.
 */
export function describeDegradedDiff(): string {
  return `e2e diff — ${E2E_PIXELS_ONLY_SENTENCE}`;
}

/* ------------------------------------------------------------------ pairing (D27) */

/**
 * What a pair is, on the source axis.
 *
 * - `e2e-vs-replay` — one side was ingested and the other replayed. Permitted, and flagged at
 *   **high** severity, exactly as `mock-vs-recorded` is (D13, D27): the two sides were produced by
 *   different machinery under different conditions — different browser, no frozen clock, no settle
 *   gate, a lossy downscaled viewport frame against a full-page PNG — so nearly every finding below
 *   describes the capture method rather than the application.
 * - `e2e-pair` — both sides ingested. Not a warning: this is what e2e mode exists to produce. It is
 *   carried anyway, at `note`, because such a pair is a **pixel comparison** (§4) — no finding
 *   names an element or a property — and a reader who is not told will read a list of anonymous
 *   changed regions as the tool having looked at the DOM and found nothing in it.
 *
 * `null` is the pair that needs no comment: both sides replayed, which is every pair slice 1 could
 * produce and therefore what an unchanged project keeps seeing.
 */
export type SourcePairLabel = 'e2e-vs-replay' | 'e2e-pair';

export interface SourcePair {
  base: RunSource;
  head: RunSource;
  label: SourcePairLabel | null;
  /**
   * True when *either* side is an e2e run, and therefore when §4 applies to the whole comparison.
   * Deliberately not the same question as `label !== null`: a mixed pair is both degraded and
   * confounded, and the report says both things.
   *
   * Note that `degraded` alone does not say whether findings can name elements — `e2e-pair` cannot
   * and `e2e-vs-replay` can, through its replayed side. {@link e2eDegradedSentences} makes that
   * distinction; anything that only knows `degraded` must not promise element-level detail.
   */
  degraded: boolean;
}

/** Just enough of a run to classify the pair it is half of. */
export interface SourcePairSide {
  source?: RunSource;
}

/** Classifies a pair from the two runs' meta. Pure; the wording is {@link describeSourcePair}. */
export function classifySourcePair(
  base: SourcePairSide | object | null | undefined,
  head: SourcePairSide | object | null | undefined,
): SourcePair {
  const baseSource = sourceOf(base);
  const headSource = sourceOf(head);
  const degraded = baseSource === SOURCE_E2E || headSource === SOURCE_E2E;
  if (baseSource !== headSource) {
    return { base: baseSource, head: headSource, label: 'e2e-vs-replay', degraded };
  }
  return {
    base: baseSource,
    head: headSource,
    label: degraded ? 'e2e-pair' : null,
    degraded,
  };
}

/** The sentence each classification prints, in the CLI and in the report alike. */
export function describeSourcePair(pair: SourcePair): string | null {
  switch (pair.label) {
    case 'e2e-vs-replay':
      return (
        `e2e-vs-replay: ${pair.base === SOURCE_E2E ? 'base' : 'head'} was ingested from a test` +
        ` suite's trace and ${pair.base === SOURCE_E2E ? 'head' : 'base'} was replayed by this` +
        ' tool — the two were captured by different machinery, so most findings below describe the' +
        ' capture, not the application'
      );
    case 'e2e-pair':
      return `e2e pair: ${describeDegradedDiff()}`;
    case null:
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ run warnings (§8) */

/**
 * The run-warning kinds an ingested run can carry (§8).
 *
 * Declared here as strings rather than imported from the ingestion module's warning union, for the
 * same reason `VARIANT_WARNING_KINDS` is: the report reads `meta.json` off disk and has to recognise
 * the kind a *stored* run carries, which is a fact about a file rather than about the union this
 * build happens to compile against.
 *
 * They are **not** all high severity, and the split is the decision:
 *
 *  - `e2e-map-unmatched` is high. A stale `e2e-map.yaml` entry silently doing nothing is the same
 *    failure as a never-matched scenario rule: the pin the user wrote to keep a step id stable is
 *    not being applied, so the diff is aligning on something else without saying so.
 *  - `e2e-step-title-duplicate` is a notice. Two steps sharing a title is ordinary in a real suite —
 *    `test.step('run the search')` twice in one test is trivially reachable — and the ids were
 *    disambiguated deterministically, so nothing is wrong. It is reported once so the suffix in the
 *    step id is explicable rather than mysterious.
 *  - `e2e-revision-unknown` is a notice: honest, recorded, never inferred (§7, §8).
 */
export const E2E_WARNING_KINDS = [
  'e2e-map-unmatched',
  'e2e-step-title-duplicate',
  'e2e-revision-unknown',
] as const;

export type E2eWarningKind = (typeof E2E_WARNING_KINDS)[number];

/** True for any run-warning kind this slice introduces. */
export function isE2eWarningKind(kind: string): kind is E2eWarningKind {
  return (E2E_WARNING_KINDS as readonly string[]).includes(kind);
}

/** The subset of {@link E2E_WARNING_KINDS} that says the diff is aligning on the wrong thing. */
export function isHighSeverityE2eWarningKind(kind: string): boolean {
  return kind === 'e2e-map-unmatched';
}

