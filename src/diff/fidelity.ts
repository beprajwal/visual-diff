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
 * a vdiff capture.** It has screenshots and DOM snapshots but no computed-style subset and no
 * accessibility tree (§4, verified against real archives — a snapshot serialises attributes only,
 * so an element styled `padding: 13px 17px` appears as `["H1",{"id":"t"},"Styled"]` with no
 * resolved value anywhere in the archive). The layered diff (spec §5, D5) therefore degrades:
 * pixel regions and DOM attribution still work, property-level findings do not.
 *
 * That is stated on the result and on every finding rather than left to be discovered as a
 * disappointment. A report that cannot tell "we found nothing" from "we could not look" is worse
 * than one that admits the second.
 */

import { RUN_SOURCES, SOURCE_E2E, parseRunSource } from '../store/internal/e2e.js';
import type { MaybeE2e, RunSource } from '../store/internal/e2e.js';
import type { NodeChange } from '../types.js';

/**
 * What a trace archive does not contain, in the vocabulary of slice 1's capture list (spec §5).
 *
 * Both are absent at every trace version under every configuration, not merely often absent: there
 * is no computed-style payload and no accessibility payload of any kind in the archive. Author CSS
 * *is* present (inline `<style>` text, adopted stylesheets as text, external sheets as resources),
 * so the information is recoverable by rehydrating a snapshot in a browser — which this slice does
 * not do. Hence "not available here", rather than "gone".
 */
export const DEGRADED_CAPTURES = ['computed-styles', 'accessibility-tree'] as const;
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
  /** One sentence, rendered verbatim wherever there is room for only one. */
  note: string;
}

const FULL_NOTE =
  'both runs were captured by vdiff, so the full layered diff applies: pixel regions, DOM ' +
  'attribution and property-level findings';

const DEGRADED_NOTE =
  'one or both runs were ingested from a Playwright trace, which carries no computed styles and ' +
  'no accessibility tree — pixel regions and DOM attribution still apply, property-level findings ' +
  'do not, so this diff cannot report a change like "padding 8px → 12px"';

/** The fidelity of a pair neither side of which was ingested — every pre-e2e pair. */
export const FULL_FIDELITY: PairFidelity = { level: 'full', missing: [], note: FULL_NOTE };

/**
 * Fidelity from the two sources. Degraded when *either* side is ingested: a comparison is only as
 * detailed as its poorer side, and a property change cannot be reported against a run that never
 * recorded the property. So the mixed pair is degraded *and* flagged, which are two different
 * statements about it and are made separately (see `pairing.ts`).
 */
export function fidelityOf(base: RunSource, head: RunSource): PairFidelity {
  if (base !== SOURCE_E2E && head !== SOURCE_E2E) return { ...FULL_FIDELITY, missing: [] };
  return { level: 'degraded', missing: [...DEGRADED_CAPTURES], note: DEGRADED_NOTE };
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
 * What survives is exactly what §4 promises still works: added, removed, text, moved, resized, and
 * the attribute changes a snapshot genuinely records. A region whose every change was dropped does
 * not disappear — it falls through to "this region changed, this element is responsible", which is
 * the degraded diff working as designed rather than a silence.
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
