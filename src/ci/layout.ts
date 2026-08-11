/**
 * ci/layout — the evidence bundle's shape, in one place (CI spec §5).
 *
 * A bundle is written once by `vdiff export` and then read by three different things that share no
 * code: a markdown comment on a pull request, a static HTML page, and a human clicking through a
 * downloaded zip. All three address the same images, so the layout is a pure function here rather
 * than a convention repeated in each of them.
 *
 * **Every path this module produces is relative to the bundle root, with `/` separators.** That is
 * what lets one bundle work under a raw-branch URL, a Pages deployment and `file://` without being
 * rewritten (D31): a comment prefixes them with an image base, the HTML page uses them as-is.
 */

import type { DiffResult, Finding, StepDiff, ViewportDiff } from '../types.js';
import { SEVERITY_ORDER } from '../types.js';

/** Files at the bundle root. Named here so the exporter, the HTML page and the tests agree. */
export const BUNDLE_FILES = {
  summary: 'summary.json',
  findings: 'findings.json',
  comment: 'comment.md',
  report: 'report.html',
} as const;

export const IMAGES_DIR = 'images';
export const CROPS_DIR = `${IMAGES_DIR}/crops`;

/** Which side of a pair an image shows. `pixel` is the annotated diff, not a capture. */
export type ShotSide = 'base' | 'head' | 'pixel';

/**
 * Which shots a bundle carries.
 *
 * - `changed` — steps with a finding or a non-zero pixel ratio. The default: a twelve-step flow at
 *   two viewports is 72 PNGs, and a reviewer wants the three that moved.
 * - `all`     — every compared shot, for when the interesting part is what did *not* change.
 * - `none`    — JSON and markdown only. For a job that gates and never shows anyone a picture.
 */
export type ImageSelection = 'changed' | 'all' | 'none';

export const IMAGE_SELECTIONS: readonly ImageSelection[] = ['changed', 'all', 'none'];

export function isImageSelection(value: string): value is ImageSelection {
  return (IMAGE_SELECTIONS as readonly string[]).includes(value);
}

/**
 * Path segments come from a flow spec, which the store already guarantees is free of separators and
 * control characters (`store/paths.ts#assertSafeSegment`) — a step id that could escape a directory
 * could never have been written in the first place. This is the second belt: a bundle is also
 * written to a directory the *user* named with `--out`, and by a command that may be handed a
 * `findings.json` from anywhere, so the value is re-checked rather than trusted twice.
 */
function segment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '_');
  // A separator can no longer appear, so the only remaining way out of the directory is a segment
  // that is *entirely* dots — `.` and `..` are traversal, `..etc` is a filename.
  if (safe.length === 0 || /^\.+$/.test(safe)) return '_';
  return safe;
}

/** `images/<step>/<viewport>/<side>.png`, relative to the bundle root. */
export function shotPath(step: string, viewport: string, side: ShotSide): string {
  return `${IMAGES_DIR}/${segment(step)}/${segment(viewport)}/${side}.png`;
}

/** `images/crops/<findingId>.png`, relative to the bundle root. */
export function cropPath(findingId: string): string {
  return `${CROPS_DIR}/${segment(findingId)}.png`;
}

/** One (step, viewport) cell of the pair, with everything the three readers need about it. */
export interface ShotCell {
  step: string;
  status: StepDiff['status'];
  viewport: string;
  pixelChangedRatio: number;
  /** Set when one or both captures are absent — an added step, a removed one, or a pruned run. */
  missing?: 'base' | 'head' | 'both';
  dimensionsChanged: boolean;
  /** Findings for this cell: the viewport's own plus the step-scoped ones, severity-sorted. */
  findings: Finding[];
  /** True when this cell is what `changed` selects: a finding, or any pixel movement at all. */
  changed: boolean;
  /** Bundle-relative paths, whether or not the exporter ended up copying them. */
  paths: Record<ShotSide, string>;
  /** Store-relative source of the pixel diff, when the engine produced one. */
  pixelStorePath?: string;
}

/** Findings sorted the way every surface displays them: severity first, then id. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.id.localeCompare(b.id, 'en');
  });
}

function cellFor(step: StepDiff, viewportDiff: ViewportDiff): ShotCell {
  // Step-scoped findings (console, network) have no viewport of their own, so they are attached to
  // every cell of the step. That is what `vdiff diff` prints too: its FINDINGS column adds
  // `step.findings.length` to each viewport row.
  const findings = sortFindings([...viewportDiff.findings, ...step.findings]);
  const cell: ShotCell = {
    step: step.id,
    status: step.status,
    viewport: viewportDiff.viewport,
    pixelChangedRatio: viewportDiff.pixelChangedRatio,
    dimensionsChanged: viewportDiff.dimensionsChanged,
    findings,
    changed: findings.length > 0 || viewportDiff.pixelChangedRatio > 0 || step.status !== 'matched',
    paths: {
      base: shotPath(step.id, viewportDiff.viewport, 'base'),
      head: shotPath(step.id, viewportDiff.viewport, 'head'),
      pixel: shotPath(step.id, viewportDiff.viewport, 'pixel'),
    },
  };
  if (viewportDiff.missing !== undefined) cell.missing = viewportDiff.missing;
  if (viewportDiff.pixelPath !== undefined) cell.pixelStorePath = viewportDiff.pixelPath;
  return cell;
}

/**
 * Every (step, viewport) cell of a diff, in flow order and then viewport order.
 *
 * Flow order is the order `result.steps` is already in — the diff engine aligns runs by step id
 * (spec §6) and emits them in the head run's order — so this preserves it rather than sorting, which
 * would put `cart` after `pay-form` and make the filmstrip read backwards.
 */
export function shotCells(result: DiffResult): ShotCell[] {
  const cells: ShotCell[] = [];
  for (const step of result.steps) {
    for (const viewport of Object.keys(step.viewports)) {
      const viewportDiff = step.viewports[viewport];
      if (viewportDiff === undefined) continue;
      cells.push(cellFor(step, viewportDiff));
    }
  }
  return cells;
}

/** The cells an {@link ImageSelection} covers. `changed` first, always — see the type's doc. */
export function selectCells(cells: readonly ShotCell[], images: ImageSelection): ShotCell[] {
  if (images === 'none') return [];
  if (images === 'all') return [...cells];
  return cells.filter((cell) => cell.changed);
}

/** Step-scoped findings (console, network) — the ones no image can show. */
export function stepScopedFindings(result: DiffResult): Finding[] {
  return sortFindings(result.steps.flatMap((step) => step.findings));
}

/** Every finding in the diff, severity-sorted, viewport-scoped and step-scoped together. */
export function allFindings(result: DiffResult): Finding[] {
  const findings: Finding[] = [];
  for (const step of result.steps) {
    findings.push(...step.findings);
    for (const viewport of Object.values(step.viewports)) findings.push(...viewport.findings);
  }
  return sortFindings(findings);
}
