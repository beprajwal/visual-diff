/**
 * The card the comment's picture is taken of (CI spec D51).
 *
 * Not the report page: a reviewer skimming a pull request wants the changes, not the tool. The card
 * is a numbered list of what moved — each entry the step and viewport, what kind of change it is,
 * how much moved, what the findings say — with the base and the head capture side by side under
 * it. Added steps have no base and say so; removed steps have no head. Nothing else: no filmstrip,
 * no key bindings, no pixel-diff pane. The picture links to the report, where all of that is.
 *
 * Self-contained on purpose: inline CSS, system fonts, images addressed relative to the bundle, no
 * script. It is opened from `file://` by a headless browser on a runner, and a card that needed a
 * network to render would sometimes render blank.
 */

import { SEVERITY_ORDER, type DiffResult, type Finding } from '../types.js';
import { PRODUCT_NAME } from './comment.js';
import type { ShotCell } from './layout.js';
import { shotCells } from './layout.js';
import { hasMinorChanges } from '../diff/significance.js';
import { commentFingerprint, reviewProjection } from './review-triage.js';
import type { Review } from '../types.js';

/** Bundle-relative path of the card. Beside `report.html`, so the same publish step ships it. */
export const PREVIEW_PAGE = 'preview.html';

/** Entries the card lists before it says "and N more". Six rows is one screen of picture. */
export const DEFAULT_MAX_CHANGES = 6;

/** The card's width. Two captures side by side at a readable size, and GitHub's comment column. */
export const PREVIEW_CARD_WIDTH = 1200;

export interface PreviewCardInput {
  result: DiffResult;
  review?: Review;
  /** The changed cells, every viewport, in the order the comment shows them. The card picks and ranks. */
  cells: readonly ShotCell[];
  /** Bundle-relative image paths that were actually written; a cell whose capture is absent says so. */
  available: ReadonlySet<string>;
  version: string;
  maxChanges?: number;
}

const escape = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const percent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

/** What the entry is: the vocabulary the comment's "What changed" table uses. */
export function changeKind(cell: ShotCell): 'added' | 'removed' | 'changed' {
  if (cell.status === 'added' || cell.missing === 'base') return 'added';
  if (cell.status === 'removed' || cell.missing === 'head') return 'removed';
  return 'changed';
}

function topSeverity(findings: readonly Finding[]): number {
  return findings.reduce(
    (best, finding) => Math.min(best, SEVERITY_ORDER[finding.severity]),
    Number.POSITIVE_INFINITY,
  );
}

/** Width of a viewport id like `1280x800`; 0 for anything else, so an unparseable id sorts last. */
function viewportWidth(viewport: string): number {
  const match = /^(\d+)x\d+$/.exec(viewport);
  return match === null ? 0 : Number(match[1]);
}

/**
 * One entry per step: the widest viewport's cell, which is the one a reviewer recognises. A step
 * that changed at two viewports is one change, not two, and a card of six entries that spends
 * three of them on the phone renderings of the first three steps has told the reader less.
 */
export function onePerStep(cells: readonly ShotCell[]): ShotCell[] {
  const chosen = new Map<string, ShotCell>();
  for (const cell of cells) {
    const current = chosen.get(cell.step);
    if (current === undefined || viewportWidth(cell.viewport) > viewportWidth(current.viewport)) {
      chosen.set(cell.step, cell);
    }
  }
  return [...chosen.values()];
}

/**
 * The order the card lists changes in. Additions and removals first — a step that appeared or
 * vanished is the change a reviewer least expects — then by the worst finding, then by how much of
 * the picture moved. Stable for ties, so two equal cells keep the flow's order.
 */
export function rankChanges(cells: readonly ShotCell[]): ShotCell[] {
  return [...cells].sort((a, b) => {
    const structural = Number(changeKind(a) === 'changed') - Number(changeKind(b) === 'changed');
    if (structural !== 0) return structural;
    const severity = topSeverity(a.findings) - topSeverity(b.findings);
    if (severity !== 0) return severity;
    return b.pixelChangedRatio - a.pixelChangedRatio;
  });
}

function findingPhrase(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'no findings';
  const first = findings[0] as Finding;
  const rest = findings.length - 1;
  return `${findings.length} finding${findings.length === 1 ? '' : 's'} — ${escape(first.label)}${rest > 0 ? ` (+${rest})` : ''}`;
}

function pane(
  label: 'base' | 'head',
  cell: ShotCell,
  available: ReadonlySet<string>,
  kind: ReturnType<typeof changeKind>,
): string {
  const absent = (label === 'base' && kind === 'added') || (label === 'head' && kind === 'removed');
  if (absent) {
    const why = kind === 'added' ? 'not in the base — this step is new' : 'not in the head — this step is gone';
    return `<figure class="pane"><figcaption>${label}</figcaption><div class="empty">${why}</div></figure>`;
  }
  const src = cell.paths[label];
  if (!available.has(src)) {
    return `<figure class="pane"><figcaption>${label}</figcaption><div class="empty">capture not in the bundle</div></figure>`;
  }
  return `<figure class="pane"><figcaption>${label}</figcaption><img src="${escape(src)}" alt="${escape(`${cell.step} ${label}`)}"></figure>`;
}

function entry(index: number, cell: ShotCell, available: ReadonlySet<string>): string {
  const kind = changeKind(cell);
  const amount =
    kind === 'changed' ? `${percent(cell.pixelChangedRatio)} of pixels changed` : `step ${kind}`;
  return [
    `<li class="change ${kind}">`,
    `<div class="title"><span class="n">${index}</span><code>${escape(cell.step)}</code> <span class="vp">@ ${escape(cell.viewport)}</span> <span class="kind">${kind}</span></div>`,
    `<div class="meta">${amount} · ${findingPhrase(cell.findings)}</div>`,
    `<div class="panes">${pane('base', cell, available, kind)}${pane('head', cell, available, kind)}</div>`,
    `</li>`,
  ].join('');
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --bg: #ffffff; --card: #f6f8fa; --accent: #0969da; --added: #1a7f37; --removed: #cf222e; --changed: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #8d96a0; --line: #30363d; --bg: #0d1117; --card: #161b22; --accent: #58a6ff; --added: #3fb950; --removed: #f85149; --changed: #d29922; } }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { width: ${PREVIEW_CARD_WIDTH}px; font: 15px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 28px 32px 24px; }
header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 6px; }
header h1 { font-size: 22px; margin: 0; letter-spacing: 0.01em; }
header .pair { color: var(--muted); }
.verdict { margin: 0 0 20px; font-size: 16px; }
ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 18px; }
.change { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 14px 16px 16px; }
.title { display: flex; align-items: center; gap: 10px; font-size: 16px; }
.n { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: #fff; font-weight: 700; font-size: 14px; }
.title code { font-weight: 700; }
.vp { color: var(--muted); }
.kind { margin-left: auto; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
.added .kind { color: var(--added); } .removed .kind { color: var(--removed); } .changed .kind { color: var(--changed); }
.meta { color: var(--muted); margin: 4px 0 12px 36px; }
.panes { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.pane { margin: 0; }
.pane figcaption { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
.pane img { display: block; width: 100%; max-height: 340px; object-fit: cover; object-position: top; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
.empty { display: grid; place-items: center; height: 160px; border: 1px dashed var(--line); border-radius: 6px; color: var(--muted); }
.more { margin: 16px 0 0; color: var(--muted); }
footer { margin-top: 18px; color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; }
`;

/** The card as a page. Deterministic for a given input: no dates, no random ids. */
export function renderPreviewCard(input: PreviewCardInput): string {
  const minor = hasMinorChanges(input.result);
  const projection = reviewProjection(input.result, input.review);
  const result = projection.result;
  const aiFiltered = projection.omittedFindings > 0 || projection.omittedViewports > 0;
  const summary = result.summary;
  const selected = new Set(input.cells.map(cell => `${cell.step}\0${cell.viewport}`));
  const cells = minor || aiFiltered ? shotCells(result).filter(cell => cell.changed && selected.has(`${cell.step}\0${cell.viewport}`)) : input.cells;
  const ranked = rankChanges(onePerStep(cells));
  const max = Math.max(0, input.maxChanges ?? DEFAULT_MAX_CHANGES);
  const shown = ranked.slice(0, max);
  const hidden = ranked.length - shown.length;

  const verdict =
    summary.totalFindings === 0
      ? 'No findings.'
      : `${summary.totalFindings} finding${summary.totalFindings === 1 ? '' : 's'} — ${summary.bySeverity.high} high, ${summary.bySeverity.med} med, ${summary.bySeverity.low} low`;
  const steps =
    `${summary.stepsChanged}/${summary.stepsCompared} steps changed` +
    (summary.stepsAdded > 0 ? `, ${summary.stepsAdded} added` : '') +
    (summary.stepsRemoved > 0 ? `, ${summary.stepsRemoved} removed` : '');

  const minorOnly = minor && summary.totalFindings === 0 && summary.stepsChanged === 0 && result.steps.every(step => step.status === 'matched');
  const body =
    shown.length === 0
      ? `<p class="verdict">${aiFiltered ? 'AI classified the reviewed visual changes as capture noise. Full evidence remains in the report.' : minorOnly ? 'No changes above the configured thresholds.' : 'Nothing moved between the two revisions.'}</p>`
      : `<ol class="preview-card-list">${shown.map((cell, i) => entry(i + 1, cell, input.available)).join('')}</ol>` +
        (hidden > 0
          ? `<p class="more">and ${hidden} more change${hidden === 1 ? '' : 's'} in the report</p>`
          : '');

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta name="vdiff-fingerprint" content="${commentFingerprint(input.result, input.review)}">`,
    `<title>${escape(PRODUCT_NAME)} — ${escape(result.flow)} ${escape(result.pair.base)}..${escape(result.pair.head)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body class="preview-card">',
    `<header><h1>${escape(PRODUCT_NAME)}</h1><span class="pair"><code>${escape(result.flow)}</code> · <code>${escape(result.pair.base)}..${escape(result.pair.head)}</code></span></header>`,
    `<p class="verdict"><strong>${verdict}</strong> · ${steps}</p>`,
    ...projection.captureConcerns.map(concern => `<p class="verdict">Capture readiness: ${escape(concern.step)} @ ${escape(concern.viewport)} — ${escape(concern.reason)}</p>`),
    body,
    `<footer><span>base and head, side by side · ${shown.length} of ${ranked.length} change${ranked.length === 1 ? '' : 's'}</span><span>vdiff ${escape(input.version)}</span></footer>`,
    '</body></html>',
    '',
  ].join('\n');
}
