/**
 * ci/export — the portable evidence bundle (CI spec §5, D31).
 *
 * A bundle is the answer to "GitHub cannot render an image out of a workflow artifact". It is a
 * directory that is complete on its own: the stored diff verbatim, a rendered comment, a static HTML
 * page, and the PNGs both of them address. Zip it, attach it, push it to a branch, serve it from
 * Pages, or open it off a filesystem — the paths inside are relative, so none of those need a rewrite.
 *
 * What it is *not* is a second store. Nothing here is read back by any other command: the bundle is
 * an export in the plain sense, produced from `.visual-diff/` and never consulted by it. That is why
 * copying is one-way and why a missing source file is reported rather than repaired — a pruned run
 * has no screenshots, and inventing one would be worse than a bundle that says so.
 */

import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { DiffResult, IsoDate, RunMeta } from '../types.js';
import * as paths from '../store/paths.js';
import { renderComment, type CommentDocument, type CommentInput } from './comment.js';
import type { GateVerdict } from './gate.js';
import {
  BUNDLE_FILES,
  cropPath,
  selectCells,
  shotCells,
  type ImageSelection,
  type ShotCell,
} from './layout.js';
import { renderReportPage } from './report-html.js';

/** `summary.json` — the bundle's own header, for a consumer that will not parse a whole DiffResult. */
export interface BundleSummary {
  flow: string;
  pair: { base: string; head: string };
  summary: DiffResult['summary'];
  /** Pair-label sentences, exactly as the comment and the page show them. */
  notices: string[];
  gate: GateVerdict | null;
  engineVersion: string;
  version: string;
  generatedAt: IsoDate;
  images: ImageSelection;
  /** Both sides' provenance: revision, capture environment, status. */
  runs: {
    base: BundleRunInfo;
    head: BundleRunInfo;
  };
  /** Bundle-relative paths that were written. */
  files: string[];
  /** Source files that were expected and absent — a pruned run, or a diff without a pixel image. */
  missing: string[];
}

export interface BundleRunInfo {
  runId: string;
  revision: RunMeta['revision'];
  status: RunMeta['status'];
  scenario: string;
  startedAt: IsoDate;
  env: RunMeta['env'];
}

export interface ExportRequest {
  /** Project root — the directory containing `.visual-diff`. Store paths are built from it. */
  root: string;
  result: DiffResult;
  /** Directory to write. Created if absent; existing files of the same name are overwritten. */
  outDir: string;
  images: ImageSelection;
  version: string;
  generatedAt: IsoDate;
  notices?: readonly string[];
  gate?: GateVerdict;
  /** Link the bundle's own `comment.md` should carry, when the caller already knows it. */
  artifactUrl?: string;
  artifactName?: string;
  repro?: readonly string[];
}

export interface ExportReport {
  outDir: string;
  /** Bundle-relative paths written, in write order. */
  files: string[];
  /** Image files copied. Counts files, not cells: a cell is up to three of them. */
  images: number;
  missing: string[];
  comment: CommentDocument;
}

function runInfo(meta: RunMeta): BundleRunInfo {
  return {
    runId: meta.runId,
    revision: meta.revision,
    status: meta.status,
    scenario: meta.scenario,
    startedAt: meta.startedAt,
    env: meta.env,
  };
}

/** Absolute path of one side's capture for a cell, per the store layout (spec §6). */
function screenshotSource(
  root: string,
  flow: string,
  runId: string,
  cell: ShotCell,
): string {
  return path.join(
    paths.stepViewportDir(root, flow, runId, cell.step, cell.viewport),
    paths.SCREENSHOT_FILENAME,
  );
}

async function copyIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Write the bundle.
 *
 * The comment inside the bundle is rendered with `.` as its image base, so the markdown a reader
 * opens from the zip shows its pictures. The comment a *transport* posts is rendered separately with
 * whatever URL the images ended up reachable at (or with none at all, which is the default) — same
 * renderer, different base, and neither has to know about the other.
 */
export async function exportBundle(request: ExportRequest): Promise<ExportReport> {
  const { result, root, outDir } = request;
  const flow = result.flow;
  const files: string[] = [];
  const missing: string[] = [];
  let images = 0;

  await mkdir(outDir, { recursive: true });

  const everyCell = shotCells(result);
  const selected = selectCells(everyCell, request.images);

  for (const cell of selected) {
    const wanted: Array<[from: string, to: string]> = [];
    if (cell.missing !== 'base' && cell.missing !== 'both') {
      wanted.push([screenshotSource(root, flow, result.pair.base, cell), cell.paths.base]);
    }
    if (cell.missing !== 'head' && cell.missing !== 'both') {
      wanted.push([screenshotSource(root, flow, result.pair.head, cell), cell.paths.head]);
    }
    if (cell.pixelStorePath !== undefined) {
      wanted.push([paths.resolveInsideVdiff(root, cell.pixelStorePath), cell.paths.pixel]);
    }

    for (const [from, to] of wanted) {
      if (await copyIfPresent(from, path.join(outDir, to))) {
        files.push(to);
        images += 1;
      } else {
        missing.push(to);
      }
    }

    // Crops are per finding rather than per cell, and cheap: a crop is the region a finding is
    // about, which is the one image a reviewer wants when the full page is 2400px tall.
    for (const finding of cell.findings) {
      if (finding.crop === undefined) continue;
      const to = cropPath(finding.id);
      if (await copyIfPresent(paths.resolveInsideVdiff(root, finding.crop), path.join(outDir, to))) {
        if (!files.includes(to)) {
          files.push(to);
          images += 1;
        }
      } else if (!missing.includes(to)) {
        missing.push(to);
      }
    }
  }

  // findings.json is the stored diff verbatim — the same bytes the store holds, so a consumer can
  // treat the bundle as the source of truth without wondering what this layer reshaped.
  await writeFile(
    path.join(outDir, BUNDLE_FILES.findings),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  files.push(BUNDLE_FILES.findings);

  const commentInput: CommentInput = {
    result,
    version: request.version,
    imageBase: request.images === 'none' ? undefined : '.',
  };
  if (request.notices !== undefined) commentInput.notices = request.notices;
  if (request.gate !== undefined) commentInput.gate = request.gate;
  if (request.artifactUrl !== undefined) commentInput.artifactUrl = request.artifactUrl;
  if (request.artifactName !== undefined) commentInput.artifactName = request.artifactName;
  if (request.repro !== undefined) commentInput.repro = request.repro;
  const comment = renderComment(commentInput);
  await writeFile(path.join(outDir, BUNDLE_FILES.comment), comment.markdown, 'utf8');
  files.push(BUNDLE_FILES.comment);

  const page = renderReportPage({
    result,
    images: request.images,
    version: request.version,
    generatedAt: request.generatedAt,
    ...(request.notices === undefined ? {} : { notices: request.notices }),
    ...(request.gate === undefined ? {} : { gate: request.gate }),
  });
  await writeFile(path.join(outDir, BUNDLE_FILES.report), page, 'utf8');
  files.push(BUNDLE_FILES.report);

  const summary: BundleSummary = {
    flow,
    pair: result.pair,
    summary: result.summary,
    notices: [...(request.notices ?? [])],
    gate: request.gate ?? null,
    engineVersion: result.engineVersion,
    version: request.version,
    generatedAt: request.generatedAt,
    images: request.images,
    runs: { base: runInfo(result.baseMeta), head: runInfo(result.headMeta) },
    files: [...files, BUNDLE_FILES.summary],
    missing,
  };
  await writeFile(
    path.join(outDir, BUNDLE_FILES.summary),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  files.push(BUNDLE_FILES.summary);

  return { outDir, files, images, missing, comment };
}
