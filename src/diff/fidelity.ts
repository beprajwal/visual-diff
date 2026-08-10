/**
 * diff/fidelity — what a *pair* of runs could actually see, on the source axis (e2e spec §4, §7).
 *
 * The axis itself is not here. `store/internal/e2e.ts` owns it, exactly as `internal/scenario.ts`
 * owns the scenario axis and `internal/variant.ts` the variant one, and this module imports
 * `sourceOf` from there rather than re-deriving it. That is the whole point of the pattern: if the
 * diff engine decided for itself what `source` meant, the store and the engine could disagree about
 * what a run *is*, and the disagreement would surface as findings rather than as an error.
 *
 * What is genuinely a diff concern, and therefore lives here, is the consequence: **a trace is not
 * a vdiff capture.** It has screenshots and DOM snapshots but no computed-style subset, no
 * accessibility tree and no box metrics (§4, verified against real archives — a snapshot serialises
 * attributes only, so an element styled `padding: 13px 17px` appears as `["H1",{"id":"t"},"Styled"]`
 * with neither a resolved style nor a rectangle anywhere in the archive).
 *
 * The third absence is the one an earlier version of this file got wrong, and it is the largest.
 * Without box metrics every ingested node arrives with the rect `{0,0,0,0}` (`e2e/to-shots.ts`,
 * `UNAVAILABLE_RECT`), a zero rect intersects no pixel region, and a region that intersects nothing
 * attributes to no element. So on a pair whose **both** sides were ingested the layered diff (spec
 * §5, D5) does not merely lose its property layer — it loses element attribution entirely, and what
 * remains is a pixel comparison: *these regions of the screenshot changed*, with no element named
 * and no change listed. A heading genuinely renamed from "Saved locations" to "Your places" is
 * reported as anonymous changed pixels and nothing more.
 *
 * That is the user's decision of 2026-08-11, taken with the measurement in front of them: rather
 * than invent region-less DOM findings that no reader could locate, an e2e pair reports pixels and
 * says so. Everything in this module exists to make sure the saying happens — on the result, on
 * every finding, and in every sentence the CLI and report print. A report that cannot tell "we
 * found nothing" from "we could not look" is worse than one that admits the second, and one that
 * claims to have looked at elements it never had geometry for is worse than both.
 */

import { RUN_SOURCES, SOURCE_E2E, parseRunSource } from '../store/internal/e2e.js';
import type { MaybeE2e, RunSource } from '../store/internal/e2e.js';
import type { NodeChange } from '../types.js';

/**
 * What a trace archive does not contain, in the vocabulary of slice 1's capture list (spec §5).
 *
 * All three are absent at every trace version under every configuration, not merely often absent:
 * there is no computed-style payload, no accessibility payload and no geometry of any kind in the
 * archive. The names match `E2E_MISSING_CAPABILITIES` in `e2e/types.ts` so the ingest side and the
 * diff side cannot drift into two vocabularies for one fact.
 *
 * Author CSS *is* present (inline `<style>` text, adopted stylesheets as text, external sheets as
 * resources), so styles and geometry are both recoverable by rehydrating a snapshot in a browser —
 * which this slice does not do. Hence "not available here", rather than "gone".
 *
 * `element-geometry` is listed last and matters most: it is what turns a degraded diff into a
 * pixel-only one. See {@link attributionOf}.
 */
export const DEGRADED_CAPTURES = [
  'computed-styles',
  'accessibility-tree',
  'element-geometry',
] as const;
export type DegradedCapture = (typeof DEGRADED_CAPTURES)[number];

/**
 * Machine code stamped on every finding of a pair with an ingested side (§4, §9.4).
 *
 * A code rather than prose, and on the finding rather than only on the result, because `reasons` is
 * what survives filtering, sorting and export: a reader who pulls one finding out of the report
 * must not lose the sentence that qualifies it.
 */
export const DEGRADED_REASON = 'e2e-degraded';

/**
 * The code `viewportDiff.ts` stamps on a changed region it could not attribute to any element.
 *
 * Not new here, and not only an e2e code — a canvas repaint on a replay pair earns it too. It is
 * named in this module because on an e2e pair it is no longer the exception: `pixels-only` together
 * with {@link DEGRADED_REASON} on a finding with no `element` *is* what an e2e finding looks like,
 * and both front-ends read exactly that pair of codes to say so out loud.
 */
export const PIXELS_ONLY_REASON = 'pixels-only';

/**
 * How far a pair can go towards *locating* a change — the question box metrics decide.
 *
 *  - `element` — both sides were captured by vdiff, every node carries a real rect, and a changed
 *    region resolves to the element beneath it. The slice-1 world.
 *  - `replay-side-only` — one side was ingested. The replayed side still has rects, so a region can
 *    still be attributed, but only ever through that side; nothing the ingested run contains
 *    contributed to the naming, and a property comparison is impossible in either direction.
 *  - `none` — both sides were ingested. Every rect on both sides is `{0,0,0,0}`, no region
 *    intersects any node, and the diff can report *where on the screenshot* pixels changed and
 *    nothing else.
 */
export const PAIR_ATTRIBUTIONS = ['element', 'replay-side-only', 'none'] as const;
export type PairAttribution = (typeof PAIR_ATTRIBUTIONS)[number];

/**
 * How much of the layered diff this pair could actually run.
 *
 * Recorded once, on the result, so the CLI and the report cannot disagree about whether a diff was
 * complete — and carried as structured data *plus* one sentence, because the report has to explain
 * the reduction to a human who would otherwise read a short findings list as "nothing changed".
 */
export interface PairFidelity {
  level: 'full' | 'degraded';
  /** Empty at `full`; the captures this pair could not compare at `degraded`. */
  missing: DegradedCapture[];
  /**
   * Whether a finding from this pair can name the element it is about (see {@link attributionOf}).
   *
   * Optional because it is a fact this build records and older `findings.json` files do not: a diff
   * computed before this field existed genuinely says nothing about attribution, and reading its
   * silence as `element` would be inventing the very claim this field exists to stop.
   */
  attribution?: PairAttribution;
  /** One sentence, rendered verbatim wherever there is room for only one. */
  note: string;
}

const FULL_NOTE =
  'both runs were captured by vdiff, so the full layered diff applies: pixel regions, DOM ' +
  'attribution and property-level findings';

/**
 * Both sides ingested — the ordinary e2e pair, and the one the user's decision is about.
 *
 * It says "pixels only" and then says what that costs, in that order, because a reader who stops
 * after the first clause must still be left with a true belief.
 */
const PIXELS_ONLY_NOTE =
  'both runs were ingested from Playwright traces, which carry no computed styles, no ' +
  'accessibility tree and no box metrics — so this is a pixel comparison only: it reports which ' +
  'regions of the screenshot changed and cannot say which element or which property changed, so a ' +
  'heading renamed from "Saved locations" to "Your places" appears here as changed pixels and ' +
  'nothing more';

/**
 * Exactly one side ingested. A different sentence from {@link PIXELS_ONLY_NOTE} because a different
 * thing is true: the replayed side still has geometry, so a region can still be attributed — but
 * only through that side, which is worth saying before a reader treats the element name as a fact
 * about both runs.
 */
const MIXED_NOTE =
  'one run was ingested from a Playwright trace, which carries no computed styles, no ' +
  'accessibility tree and no box metrics — so no property-level finding is possible, and any ' +
  'element named below was located in the replayed run alone; the ingested run contributed pixels ' +
  'only';

/** The fidelity of a pair neither side of which was ingested — every pre-e2e pair. */
export const FULL_FIDELITY: PairFidelity = {
  level: 'full',
  missing: [],
  attribution: 'element',
  note: FULL_NOTE,
};

/**
 * How far this pair can locate a change, from the two sources alone.
 *
 * **This is where the pixels-only decision is written down.** A pair at `none` computes DOM node
 * changes exactly as any other pair does — `viewportDiff.ts` diffs the matched nodes — and then
 * discards every one of them, because a node change only ever reaches a finding through a *region*
 * that attributed to that node, and with `{0,0,0,0}` rects on both sides no region attributes to
 * anything. The changes are real; they are simply unplaceable, so they are dropped rather than
 * emitted as findings with no element, no rectangle and no way for a reviewer to check them.
 *
 * That discard is intended, not a bug (user decision, 2026-08-11): on an e2e pair the diff is
 * pixels only, and every sentence this tool prints about such a pair says so. Anyone wanting
 * element-level findings back has to restore the *input* — box metrics at ingest, which today are
 * `UNAVAILABLE_RECT` in `e2e/to-shots.ts` — not loosen the filtering below, which would only put
 * unlocatable findings in front of a reviewer.
 */
export function attributionOf(base: RunSource, head: RunSource): PairAttribution {
  if (base !== SOURCE_E2E && head !== SOURCE_E2E) return 'element';
  return base === SOURCE_E2E && head === SOURCE_E2E ? 'none' : 'replay-side-only';
}

/**
 * Fidelity from the two sources. Degraded when *either* side is ingested: a comparison is only as
 * detailed as its poorer side, and a property change cannot be reported against a run that never
 * recorded the property. So the mixed pair is degraded *and* flagged, which are two different
 * statements about it and are made separately (see `pairing.ts`).
 *
 * The two degraded cases share a `level` and differ in their `note`, because they differ in what a
 * reader may believe: at `none` no finding names an element at all, at `replay-side-only` some do
 * and the name came from one side. One sentence covering both would have to be vague enough to be
 * useless for either.
 */
export function fidelityOf(base: RunSource, head: RunSource): PairFidelity {
  const attribution = attributionOf(base, head);
  if (attribution === 'element') return { ...FULL_FIDELITY, missing: [] };
  return {
    level: 'degraded',
    missing: [...DEGRADED_CAPTURES],
    attribution,
    note: attribution === 'none' ? PIXELS_ONLY_NOTE : MIXED_NOTE,
  };
}

/* ------------------------------------------- what a degraded pair may not claim (§4) */

/**
 * Node properties that come from a capture layer a trace does not have, and which a degraded pair
 * therefore has no basis to compare.
 *
 * `role` and `name` are the accessibility-derived pair. They matter more than they look: on a
 * *mixed* pair the replay side carries a name and the ingested side does not, so a naive node diff
 * reports "lost accessible name" — a **high** severity finding — for every named element on the
 * page. The name was not lost; it was never recorded on one side.
 */
export const UNBACKED_ATTRS = ['role', 'name'] as const;

/**
 * The node changes that survive on a degraded pair (§4).
 *
 * Dropped, not merely marked: a finding that says "colour rgb(15,23,42) → ''" beside a note saying
 * "this diff cannot report property-level changes" is the tool contradicting itself in two adjacent
 * lines, and the reader has no way to know which half to believe. The whole `style` kind goes,
 * because the computed-style subset is absent from every trace at every version; within an `attr`
 * change only the accessibility-derived properties go, because a snapshot really does carry the
 * element's attributes and `id`/`href`/`src` changes are as real here as anywhere.
 *
 * What survives *this filter* is added, removed, text, moved, resized, and the attribute changes a
 * snapshot genuinely records. On a **mixed** pair those go on to become findings, attributed
 * through the replayed side's geometry.
 *
 * On a pair whose both sides were ingested — {@link attributionOf} `=== 'none'` — none of them
 * become findings, and this is the one place a reader is likely to look for the reason, so it is
 * written here rather than left to be reconstructed from three files:
 *
 *   1. every ingested node has the rect `{0,0,0,0}` (`e2e/to-shots.ts`);
 *   2. `viewportDiff.ts` emits a node change only through a pixel region that attributed to that
 *      node, and a zero rect intersects nothing, so nothing attributes;
 *   3. the region is still reported — as `content` / "visual change", with `pixels-only` in its
 *      reasons, no `element` and no `changes`.
 *
 * So the survivors of this filter are discarded downstream, deliberately, and every finding of such
 * a pair is an anonymous changed region. That is the decision (2026-08-11), not an oversight: see
 * {@link attributionOf}. Widening what this function keeps cannot change it — the geometry is the
 * missing input, and `fidelity.test.ts` locks the behaviour so a future change here cannot quietly
 * appear to restore attribution.
 */
export function withoutUnbackedChanges(changes: readonly NodeChange[]): NodeChange[] {
  const out: NodeChange[] = [];
  for (const change of changes) {
    if (change.kind === 'style') continue;
    if (change.kind !== 'attr') {
      out.push(change);
      continue;
    }
    const kept = change.changes.filter(
      (prop) => !(UNBACKED_ATTRS as readonly string[]).includes(prop.prop),
    );
    if (kept.length === 0) continue;
    out.push(kept.length === change.changes.length ? change : { ...change, changes: kept });
  }
  return out;
}

/**
 * The stored `source` value when it is not one this version knows, else `null`.
 *
 * `sourceOf` reads such a run as `replay` — the right call, since refusing to diff a run because a
 * future version wrote a source name we do not know would make old tools reject new stores. This is
 * how that decision is stated out loud instead of being inferred from silence.
 */
export function unrecognisedSource(meta: MaybeE2e | null | undefined): string | null {
  const raw = meta?.source;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return parseRunSource(raw) === null ? raw : null;
}

/** The note a run with an unreadable source value earns, or `null` when it has none. */
export function unrecognisedSourceWarning(meta: MaybeE2e | null | undefined): string | null {
  const raw = unrecognisedSource(meta);
  if (raw === null) return null;
  const runId = typeof meta?.runId === 'string' ? meta.runId : 'unknown';
  return (
    `run ${runId} records source '${raw}', which this version does not recognise — ` +
    `treated as 'replay'; known sources: ${RUN_SOURCES.join(', ')}`
  );
}
