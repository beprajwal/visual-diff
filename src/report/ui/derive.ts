/**
 * Pure derivations from a `DiffResult`: step alignment, filmstrip cells, finding grouping.
 *
 * The diff engine aligns runs by step `id` (D4) and emits `flowDiff` entries carrying the index of
 * each step on either side. The report has to lay those out as one rectangular filmstrip in which a
 * step that only exists on the base side still occupies a slot — otherwise a removed step silently
 * disappears and the reader believes the flow is unchanged.
 */

import type {
  DiffResult,
  Finding,
  FlowDiffEntry,
  FlowDiffStatus,
  RunSummary,
  Severity,
  StepDiff,
  StepId,
  ViewportDiff,
  ViewportId,
} from '../../types.js';
import { SEVERITIES, SEVERITY_ORDER } from '../../types.js';

/** Visual treatment of one filmstrip cell (spec §9). */
export type CellVariant =
  | 'failed'
  | 'blocked'
  | 'added'
  | 'removed'
  | 'spec-changed'
  | 'changed'
  | 'identical';

export interface FilmstripCell {
  id: StepId;
  status: FlowDiffStatus;
  detail?: string;
  baseIndex: number | null;
  headIndex: number | null;
  /** Position in the aligned strip, 0-based. */
  order: number;
  variant: CellVariant;
  /** Findings attributable to this cell for the active viewport. */
  findingsCount: number;
  /** Highest severity present, or null when there are no findings. */
  topSeverity: Severity | null;
  pixelChangedRatio: number;
  /** Badge glyph: a count for changed steps, a symbol for the categorical states. */
  badge: string;
  /** Run whose screenshot is the natural thumbnail: the head, except for removed steps. */
  thumbSide: 'head' | 'base';
  /** True when the step has no findings and no changed pixels. */
  identical: boolean;
}

/**
 * Orders aligned steps for display.
 *
 * Head order is the spine, because the head is what the reader is looking at. Steps that exist only
 * on the base side (removed) are spliced in after the base-side step that preceded them, so a
 * removal shows up where it used to be rather than being dumped at the end.
 */
export function alignFlowDiff(entries: readonly FlowDiffEntry[]): FlowDiffEntry[] {
  const spine = entries
    .filter((e) => e.headIndex !== null)
    .slice()
    .sort((a, b) => (a.headIndex ?? 0) - (b.headIndex ?? 0));

  const orphans = entries
    .filter((e) => e.headIndex === null)
    .slice()
    .sort((a, b) => (a.baseIndex ?? 0) - (b.baseIndex ?? 0));

  if (orphans.length === 0) return spine;

  const out: FlowDiffEntry[] = spine.slice();
  for (const orphan of orphans) {
    const baseIndex = orphan.baseIndex ?? -1;
    // Insert after the last already-placed entry whose base index precedes this one.
    let insertAt = 0;
    for (let i = 0; i < out.length; i += 1) {
      const candidate = out[i];
      if (!candidate) continue;
      const candidateBase = candidate.baseIndex;
      if (candidateBase !== null && candidateBase < baseIndex) insertAt = i + 1;
    }
    out.splice(insertAt, 0, orphan);
  }
  return out;
}

/** The viewport diff for a step, or undefined when that viewport was not captured. */
export function viewportDiffOf(
  step: StepDiff | undefined,
  viewport: ViewportId | null,
): ViewportDiff | undefined {
  if (!step) return undefined;
  if (viewport !== null) return step.viewports[viewport];
  const first = Object.keys(step.viewports)[0];
  return first === undefined ? undefined : step.viewports[first];
}

/**
 * Every finding attributable to a step for the active viewport: the viewport-scoped findings plus
 * the step-scoped ones (console, network), which have no viewport of their own and must not vanish
 * when a viewport tab is selected.
 */
export function findingsForStep(step: StepDiff | undefined, viewport: ViewportId | null): Finding[] {
  if (!step) return [];
  const out: Finding[] = [];
  if (viewport === null) {
    for (const key of Object.keys(step.viewports)) {
      const vd = step.viewports[key];
      if (vd) out.push(...vd.findings);
    }
  } else {
    const vd = step.viewports[viewport];
    if (vd) out.push(...vd.findings);
  }
  out.push(...step.findings);
  return out;
}

/** Sorts by severity, then by kind, then by id, so the list order is stable across renders. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings.slice().sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface SeverityGroup {
  severity: Severity;
  findings: Finding[];
}

/** Groups findings by severity in high → low order. Empty severities are omitted, never hidden. */
export function groupBySeverity(findings: readonly Finding[]): SeverityGroup[] {
  const groups: SeverityGroup[] = [];
  for (const severity of SEVERITIES) {
    const matching = findings.filter((f) => f.severity === severity);
    if (matching.length > 0) groups.push({ severity, findings: sortFindings(matching) });
  }
  return groups;
}

/** Highest severity present, or null for an empty list. */
export function topSeverity(findings: readonly Finding[]): Severity | null {
  let best: Severity | null = null;
  for (const f of findings) {
    if (best === null || SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[best]) best = f.severity;
  }
  return best;
}

function variantFor(status: FlowDiffStatus, findingsCount: number, ratio: number): CellVariant {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'spec-changed':
      return 'spec-changed';
    case 'matched':
      return findingsCount === 0 && ratio === 0 ? 'identical' : 'changed';
    default:
      return 'changed';
  }
}

function badgeFor(variant: CellVariant, findingsCount: number): string {
  switch (variant) {
    case 'failed':
      return '!';
    case 'blocked':
      return '···';
    case 'added':
      return '+';
    case 'removed':
      return '−';
    case 'identical':
      return '=';
    case 'spec-changed':
      return findingsCount > 0 ? String(findingsCount) : '≠';
    case 'changed':
    default:
      return String(findingsCount);
  }
}

/** Builds one cell per aligned step, in display order. */
export function buildFilmstrip(diff: DiffResult, viewport: ViewportId | null): FilmstripCell[] {
  const byId = new Map<StepId, StepDiff>();
  for (const step of diff.steps) byId.set(step.id, step);

  return alignFlowDiff(diff.flowDiff).map((entry, order) => {
    const step = byId.get(entry.id);
    const findings = findingsForStep(step, viewport);
    const vd = viewportDiffOf(step, viewport);
    const ratio = vd ? vd.pixelChangedRatio : 0;
    const status = step?.status ?? entry.status;
    const variant = variantFor(status, findings.length, ratio);
    return {
      id: entry.id,
      status,
      detail: entry.detail ?? step?.detail,
      baseIndex: entry.baseIndex,
      headIndex: entry.headIndex,
      order,
      variant,
      findingsCount: findings.length,
      topSeverity: topSeverity(findings),
      pixelChangedRatio: ratio,
      badge: badgeFor(variant, findings.length),
      thumbSide: entry.headIndex === null ? 'base' : 'head',
      identical: variant === 'identical',
    };
  });
}

/** Cells the reader should see, honouring the findings-only filter (`f`). */
export function visibleCells(
  cells: readonly FilmstripCell[],
  findingsOnly: boolean,
): FilmstripCell[] {
  if (!findingsOnly) return cells.slice();
  const filtered = cells.filter((c) => c.findingsCount > 0 || c.variant === 'failed');
  // Never filter down to nothing: an empty strip has no navigation affordance at all.
  return filtered.length > 0 ? filtered : cells.slice();
}

/** Every viewport present in the diff, in the head run's declared order. */
export function viewportsOf(diff: DiffResult): ViewportId[] {
  const seen = new Set<ViewportId>();
  const out: ViewportId[] = [];
  const push = (v: ViewportId): void => {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  for (const v of diff.headMeta.viewports) push(v);
  for (const v of diff.baseMeta.viewports) push(v);
  for (const step of diff.steps) for (const v of Object.keys(step.viewports)) push(v);
  return out;
}

/** Short display label for a run: id, short SHA, ref, dirty marker. */
export function runLabel(run: RunSummary): string {
  const sha = run.revision.sha.slice(0, 7);
  const ref = run.revision.ref ? ` ${run.revision.ref}` : '';
  const dirty = run.revision.dirty ? ' *' : '';
  return `${run.runId}  ${sha}${ref}${dirty}`;
}

/** Index of a run id within an ascending run list, or -1. */
export function runIndex(runs: readonly RunSummary[], runId: string | null): number {
  if (runId === null) return -1;
  return runs.findIndex((r) => r.runId === runId);
}
