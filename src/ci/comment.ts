/**
 * ci/comment — a stored diff rendered as pull-request markdown (CI spec §6, D29, D33).
 *
 * Pure: a `DiffResult` and some URLs in, one string out. It opens no socket, holds no token and does
 * not know what a pull request is — whatever transports the result supplies the URLs, and posting is
 * the transport's job (D29). That is what makes the most security-sensitive part of CI mode ten
 * lines of `github-script` in a workflow instead of an HTTP client inside this package.
 *
 * Two properties are load-bearing and both are tested:
 *
 *  1. **The document opens with the answer.** A reviewer who reads one line learns how many findings
 *     there are, how severe, how much moved, and whether the pairing is an ordinary
 *     revision-to-revision comparison. Everything else is elaboration.
 *  2. **It never lies about its own size.** GitHub rejects a body over 65536 characters, so rows and
 *     images are capped — and every cap states the number it dropped and where the whole set lives.
 *     A silent truncation misreports the size of the change, which is the one thing this feature
 *     exists to prevent (D33).
 */

import type { DiffResult, Finding } from '../types.js';
import { evaluateGate, GATE_NONE, type GateLevel, type GateVerdict } from './gate.js';
import {
  allFindings,
  BUNDLE_FILES,
  selectCells,
  shotCells,
  type ShotCell,
} from './layout.js';

/** GitHub's hard limit is 65536 characters; the margin absorbs whatever a transport prepends. */
export const MAX_COMMENT_BYTES = 65000;
export const DEFAULT_MAX_FINDINGS = 25;
export const DEFAULT_MAX_IMAGES = 4;

export interface CommentInput {
  result: DiffResult;
  /**
   * Sentences about the pairing, in severity order: scenario labels, the variant pairing, the source
   * axis, the degraded-detail explanation for an ingested side. Composed by the caller from the same
   * helpers `vdiff diff` prints, because the rule that decides whether a mixed pair is a regression
   * or an artefact must not be written down twice.
   */
  notices?: readonly string[];
  /**
   * URL or path prefix the bundle's images are reachable under. **Absent means no images**: GitHub
   * cannot render a picture out of a workflow artifact, so a comment with no publish target carries
   * numbers and links only (D31), and inventing a URL that 404s would be worse than saying nothing.
   */
  imageBase?: string;
  /** Link to the uploaded evidence bundle. Every truncation notice points at it. */
  artifactUrl?: string;
  /** Shown when there is no `artifactUrl` — an artifact a reader has to find by name is still a lead. */
  artifactName?: string;
  /** The gate this job was configured with. Omitted renders no gate line at all. */
  gate?: GateVerdict;
  /** Running CLI version, for the footer. Provenance of a number nobody can reproduce is a rumour. */
  version: string;
  /** Overrides the marker that makes this comment updatable in place (D33). */
  marker?: string;
  maxFindings?: number;
  maxImages?: number;
  maxBytes?: number;
  /** Commands that reproduce this exact pair locally. Rendered verbatim in the footer. */
  repro?: readonly string[];
}

export interface CommentDocument {
  markdown: string;
  /** The HTML comment an upserting transport searches for. Always the first line of `markdown`. */
  marker: string;
  bytes: number;
  /** Image groups actually rendered. Zero whenever no `imageBase` was given. */
  images: number;
  /** What did not fit, so the caller can log it and the reader can be told (D33). */
  truncated: { findings: number; images: number; steps: boolean };
}

/**
 * The marker for one flow's comment.
 *
 * Keyed by flow, so a repository diffing three flows gets three comments that each update in place,
 * rather than three comments per push or one comment three flows fight over.
 */
export function markerFor(flow: string, kind = 'pr'): string {
  return `<!-- vdiff:${flow}:${kind} -->`;
}

/* ------------------------------------------------------------------ small renderers */

const percent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

/** Table-cell safe: no newline can break the row, no pipe can invent a column. */
function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Fixed-width text (a selector, a run id) inside a table cell. */
function code(value: string): string {
  const text = cell(value);
  if (text.length === 0) return '';
  // A selector can contain a backtick; fence with enough of them that it cannot close early.
  const fence = '`'.repeat(Math.max(1, longestBacktickRun(text) + 1));
  return `${fence}${text}${fence}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const ch of value) {
    if (ch === '`') {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function table(headers: readonly string[], rows: readonly string[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

const SEVERITY_MARK: Record<Finding['severity'], string> = {
  high: '🔴 high',
  med: '🟠 med',
  low: '⚪ low',
};

function joinUrl(base: string, relative: string): string {
  return `${base.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
}

/* ------------------------------------------------------------------ sections */

function verdictLines(input: CommentInput): string[] {
  const { result } = input;
  const summary = result.summary;
  const pair = `${result.pair.base}..${result.pair.head}`;
  const lines: string[] = [];

  lines.push(`### visual-diff — \`${result.flow}\` \`${pair}\``);
  lines.push('');

  const headline =
    summary.totalFindings === 0
      ? '**No findings.**'
      : `**${summary.totalFindings} finding${summary.totalFindings === 1 ? '' : 's'}** — ` +
        `${summary.bySeverity.high} high, ${summary.bySeverity.med} med, ${summary.bySeverity.low} low`;
  const steps =
    `${summary.stepsChanged}/${summary.stepsCompared} steps changed` +
    (summary.stepsAdded > 0 ? `, ${summary.stepsAdded} added` : '') +
    (summary.stepsRemoved > 0 ? `, ${summary.stepsRemoved} removed` : '') +
    (summary.stepsSpecChanged > 0 ? `, ${summary.stepsSpecChanged} spec-changed` : '') +
    (summary.stepsFailed > 0 ? `, ${summary.stepsFailed} failed` : '') +
    (summary.stepsBlocked > 0 ? `, ${summary.stepsBlocked} blocked` : '');
  lines.push(`${headline} · max pixel change ${percent(summary.maxPixelChangedRatio)} · ${steps}`);

  // A failed or blocked step is not a finding, and a summary that only counted findings would let a
  // run that never reached checkout read as "no findings" — the most misleading green in the tool.
  if (summary.stepsFailed > 0 || summary.stepsBlocked > 0) {
    lines.push('');
    lines.push(
      `> **This pair is incomplete.** ${summary.stepsFailed} step(s) failed and ` +
        `${summary.stepsBlocked} were blocked, so parts of the flow were never compared.`,
    );
  }

  const notices = input.notices ?? [];
  if (notices.length > 0) {
    lines.push('');
    for (const notice of notices) lines.push(`> ⚠️ ${notice}`);
  }

  if (result.warnings.length > 0) {
    lines.push('');
    for (const warning of result.warnings) lines.push(`> ${warning}`);
  }

  const gate = input.gate;
  if (gate !== undefined && gate.level !== GATE_NONE) {
    lines.push('');
    lines.push(gate.tripped ? `❌ **Gate failed** — ${gate.reason}` : `✅ Gate passed — ${gate.reason}`);
  }

  return lines;
}

function findingRow(finding: Finding): string[] {
  const where = `${finding.step}${finding.viewport === undefined ? '' : ` @${finding.viewport}`}`;
  const change =
    finding.changes.length === 0
      ? cell(finding.label)
      : `${cell(finding.label)}: ${finding.changes
          .slice(0, 3)
          .map((c) => `${cell(c.prop)} ${code(String(c.from ?? '—'))} → ${code(String(c.to ?? '—'))}`)
          .join('; ')}`;
  return [
    code(finding.id),
    SEVERITY_MARK[finding.severity],
    cell(finding.kind),
    code(where),
    code(finding.element?.selector ?? '—'),
    change,
  ];
}

function findingsSection(
  findings: readonly Finding[],
  shown: number,
  artifactHint: string,
): string[] {
  if (findings.length === 0) return [];
  const visible = findings.slice(0, Math.max(0, shown));
  const lines = ['', '#### Findings', ''];
  lines.push(...table(['ID', 'SEV', 'KIND', 'WHERE', 'ELEMENT', 'CHANGE'], visible.map(findingRow)));
  const dropped = findings.length - visible.length;
  if (dropped > 0) {
    lines.push('');
    lines.push(`… ${dropped} more finding${dropped === 1 ? '' : 's'} — ${artifactHint}`);
  }
  return lines;
}

function stepsSection(result: DiffResult, cells: readonly ShotCell[]): string[] {
  if (cells.length === 0) return [];
  const rows = cells.map((c) => [
    code(c.step),
    cell(c.status),
    code(c.viewport),
    c.missing === undefined ? percent(c.pixelChangedRatio) : `missing ${c.missing}`,
    String(c.findings.length),
    cell(result.steps.find((step) => step.id === c.step)?.detail ?? ''),
  ]);
  return [
    '',
    '<details><summary>All steps</summary>',
    '',
    ...table(['STEP', 'STATUS', 'VIEWPORT', 'PIXELS', 'FINDINGS', 'DETAIL'], rows),
    '',
    '</details>',
  ];
}

function imageGroup(cellData: ShotCell, imageBase: string): string[] {
  const img = (relative: string, alt: string): string =>
    `<img src="${joinUrl(imageBase, relative)}" alt="${alt}" width="300">`;
  const heading =
    `<code>${cellData.step}</code> @ ${cellData.viewport} — ` +
    (cellData.missing === undefined
      ? `${percent(cellData.pixelChangedRatio)} pixels, ${cellData.findings.length} finding(s)`
      : `capture missing on the ${cellData.missing} side`);

  // The base/head pair is shown even when the pixel diff is absent (an added step has no base to
  // difference against), because "what is there now" is still the useful half.
  const cells: string[] = [];
  if (cellData.missing !== 'base' && cellData.missing !== 'both') {
    cells.push(img(cellData.paths.base, `${cellData.step} base`));
  } else {
    cells.push('_no base capture_');
  }
  if (cellData.missing !== 'head' && cellData.missing !== 'both') {
    cells.push(img(cellData.paths.head, `${cellData.step} head`));
  } else {
    cells.push('_no head capture_');
  }
  cells.push(
    cellData.pixelStorePath === undefined
      ? '_no pixel diff_'
      : img(cellData.paths.pixel, `${cellData.step} diff`),
  );

  return [
    '',
    `<details open><summary>${heading}</summary>`,
    '',
    ...table(['base', 'head', 'diff'], [cells]),
    '',
    '</details>',
  ];
}

function imagesSection(
  cells: readonly ShotCell[],
  shown: number,
  imageBase: string | undefined,
  artifactHint: string,
): { lines: string[]; rendered: number; dropped: number } {
  if (imageBase === undefined || imageBase.length === 0 || cells.length === 0) {
    return { lines: [], rendered: 0, dropped: 0 };
  }
  const visible = cells.slice(0, Math.max(0, shown));
  const lines = ['', '#### Screenshots', ''];
  for (const cellData of visible) lines.push(...imageGroup(cellData, imageBase));
  const dropped = cells.length - visible.length;
  if (dropped > 0) {
    lines.push('');
    lines.push(`… ${dropped} more changed shot${dropped === 1 ? '' : 's'} — ${artifactHint}`);
  }
  return { lines, rendered: visible.length, dropped };
}

function footerLines(input: CommentInput): string[] {
  const { result } = input;
  const base = result.baseMeta.revision;
  const head = result.headMeta.revision;
  const parts = [
    `base \`${result.pair.base}\` @ \`${base.sha.slice(0, 8)}\`${base.dirty ? ' (dirty)' : ''}`,
    `head \`${result.pair.head}\` @ \`${head.sha.slice(0, 8)}\`${head.dirty ? ' (dirty)' : ''}`,
    `engine ${result.engineVersion}`,
    `vdiff ${input.version}`,
  ];
  if (input.artifactUrl !== undefined) parts.push(`[evidence bundle](${input.artifactUrl})`);
  else if (input.artifactName !== undefined) parts.push(`artifact \`${input.artifactName}\``);

  const lines = ['', '---', '', `<sub>${parts.join(' · ')}</sub>`];
  const repro = input.repro ?? [];
  if (repro.length > 0) {
    lines.push('');
    lines.push(`<sub>Reproduce locally: ${repro.map((command) => `\`${command}\``).join(' · ')}</sub>`);
  }
  return lines;
}

/* ------------------------------------------------------------------ assembly */

/** Where a truncated set can be found in full. Named once; every cap points at it. */
function artifactHintFor(input: CommentInput): string {
  if (input.artifactUrl !== undefined) {
    return `see [\`${BUNDLE_FILES.findings}\`](${input.artifactUrl}) in the evidence bundle`;
  }
  if (input.artifactName !== undefined) {
    return `see \`${BUNDLE_FILES.findings}\` in the \`${input.artifactName}\` artifact`;
  }
  return `see \`${BUNDLE_FILES.findings}\` in the evidence bundle`;
}

/**
 * Render the comment.
 *
 * Sections are assembled in priority order and shrunk from the bottom when the body will not fit:
 * the step table goes first, then screenshots, then finding rows. The verdict, the notices, the gate
 * line and the footer are never dropped — a comment that fits by removing the answer is not a
 * smaller comment, it is a different one.
 */
export function renderComment(input: CommentInput): CommentDocument {
  const marker = input.marker ?? markerFor(input.result.flow);
  const maxBytes = input.maxBytes ?? MAX_COMMENT_BYTES;
  const hint = artifactHintFor(input);

  const head = [marker, ...verdictLines(input)];
  const foot = footerLines(input);
  const findings = allFindings(input.result);
  const everyCell = shotCells(input.result);
  const cells = selectCells(everyCell, 'changed');

  let findingBudget = Math.min(findings.length, input.maxFindings ?? DEFAULT_MAX_FINDINGS);
  let imageBudget = Math.min(cells.length, input.maxImages ?? DEFAULT_MAX_IMAGES);
  let withSteps = true;

  const assemble = (): { lines: string[]; images: number } => {
    const images = imagesSection(cells, imageBudget, input.imageBase, hint);
    const lines = [
      ...head,
      ...findingsSection(findings, findingBudget, hint),
      ...images.lines,
      ...(withSteps ? stepsSection(input.result, everyCell) : []),
      ...foot,
    ];
    return { lines, images: images.rendered };
  };

  let built = assemble();
  const size = (): number => Buffer.byteLength(`${built.lines.join('\n')}\n`, 'utf8');

  // Shrink in the order above. Each loop re-measures rather than estimating, because a single
  // finding row carrying a long selector is worth more than a screenshot group.
  if (size() > maxBytes && withSteps) {
    withSteps = false;
    built = assemble();
  }
  while (size() > maxBytes && imageBudget > 0) {
    imageBudget -= 1;
    built = assemble();
  }
  while (size() > maxBytes && findingBudget > 1) {
    findingBudget = Math.max(1, Math.floor(findingBudget / 2));
    built = assemble();
  }

  const markdown = `${built.lines.join('\n')}\n`;
  return {
    markdown,
    marker,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    images: built.images,
    truncated: {
      findings: Math.max(0, findings.length - findingBudget),
      images: Math.max(0, cells.length - imageBudget),
      steps: !withSteps,
    },
  };
}

/** Convenience for a caller that has a level rather than a verdict. */
export function renderCommentWithGate(
  input: Omit<CommentInput, 'gate'>,
  level: GateLevel,
): { document: CommentDocument; gate: GateVerdict } {
  const gate = evaluateGate(input.result.summary, level);
  return { document: renderComment({ ...input, gate }), gate };
}
