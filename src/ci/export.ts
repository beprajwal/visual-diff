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

import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { DiffResult, IsoDate, Review, RunMeta, RunSummary } from '../types.js';
import * as paths from '../store/paths.js';
import { screenshotPath } from '../report/ui/paths.js';
import type { ReportSnapshot } from '../report/ui/snapshot.js';
import { renderComment, type CommentDocument, type CommentInput } from './comment.js';
import type { GateVerdict } from './gate.js';
import {
  BUNDLE_FILES,
  cropPath,
  selectCells,
  shotCells,
  type HtmlMode,
  type ImageSelection,
  type ShotCell,
} from './layout.js';
import { PREVIEW_PAGE, renderPreviewCard } from './preview-card.js';
import { renderReportPage } from './report-html.js';
import { significantReview } from '../diff/significance.js';

/** `summary.json` — the bundle's own header, for a consumer that will not parse a whole DiffResult. */
export interface BundleSummary {
  flow: string;
  pair: { base: string; head: string };
  summary: DiffResult['summary'];
  /** Pair-label sentences, exactly as the comment and the page show them. */
  notices: string[];
  gate: GateVerdict | null;
  /** The model-written review the bundle carries in `review.json` (D39); null when none was. */
  review: Review | null;
  engineVersion: string;
  version: string;
  generatedAt: IsoDate;
  images: ImageSelection;
  html: HtmlMode;
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
  /**
   * How the page addresses its images: `linked` (the default) writes today's relative-path
   * `report.html`; `inline` embeds the shots as `data:` URIs so `report.html` alone is the report;
   * `both` writes the linked page plus a self-contained `report.inline.html`. The rest of the
   * bundle — `images/`, `comment.md`, the JSON — is the same in every mode.
   */
  html?: HtmlMode;
  /**
   * The prebuilt report app (`dist/ui/report-static.js`), inlined into the page (D38). The command
   * layer resolves it (`app-script.ts`); null or absent writes a page that carries the data and a
   * note instead of the app, so a missing dev build never turns an evidence export into a failure.
   */
  appScript?: string | null;
  version: string;
  generatedAt: IsoDate;
  notices?: readonly string[];
  gate?: GateVerdict;
  /**
   * A model's reading of the pair (D39). Written into the bundle as `review.json`, rendered into
   * its `comment.md`, and embedded in the page's snapshot. Absent writes the bundle exactly as
   * before this field existed.
   */
  review?: Review;
  /** Link the bundle's own `comment.md` should carry, when the caller already knows it. */
  artifactUrl?: string;
  artifactName?: string;
  repro?: readonly string[];
  /**
   * Write `preview.html`, the card the comment's picture is taken of (D51): the changed cells,
   * ranked, with base and head side by side. The capture itself is the command layer's job — it
   * needs a browser, and this writer must not.
   */
  preview?: boolean;
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

/**
 * A `RunSummary` for the snapshot's run pickers, from the meta the diff already carries. The three
 * fields the meta cannot know (`pinned`, `pruned`, `findingsCount`) get the values that claim
 * nothing: a bundle is not a store, and the page must not invent timeline state.
 */
function runSummary(meta: RunMeta): RunSummary {
  return {
    runId: meta.runId,
    flow: meta.flow,
    scenario: meta.scenario,
    revision: meta.revision,
    mode: meta.mode,
    status: meta.status,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    viewports: meta.viewports,
    failedSteps: meta.failedSteps,
    unstable: meta.unstable,
    pinned: false,
    pruned: false,
    findingsCount: null,
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
  const currentReview = significantReview(result, request.review);
  const flow = result.flow;
  const files: string[] = [];
  const missing: string[] = [];
  let images = 0;

  await mkdir(outDir, { recursive: true });

  const everyCell = shotCells(result);
  const selected = selectCells(everyCell, request.images);
  const html = request.html ?? 'linked';

  // What actually copied, keyed by the *store-relative* path the report app will ask `blob()` for —
  // the snapshot's image map must cover exactly the images the bundle carries, no more (the
  // ImageSelection contract). `to` is the bundle-relative copy, `from` its absolute source.
  const shotSources = new Map<string, { from: string; to: string }>();

  for (const cell of selected) {
    const wanted: Array<[key: string, from: string, to: string]> = [];
    if (cell.missing !== 'base' && cell.missing !== 'both') {
      wanted.push([
        screenshotPath(flow, result.pair.base, cell.step, cell.viewport),
        screenshotSource(root, flow, result.pair.base, cell),
        cell.paths.base,
      ]);
    }
    if (cell.missing !== 'head' && cell.missing !== 'both') {
      wanted.push([
        screenshotPath(flow, result.pair.head, cell.step, cell.viewport),
        screenshotSource(root, flow, result.pair.head, cell),
        cell.paths.head,
      ]);
    }
    if (cell.pixelStorePath !== undefined) {
      wanted.push([
        cell.pixelStorePath,
        paths.resolveInsideVdiff(root, cell.pixelStorePath),
        cell.paths.pixel,
      ]);
    }

    for (const [key, from, to] of wanted) {
      if (await copyIfPresent(from, path.join(outDir, to))) {
        files.push(to);
        images += 1;
        shotSources.set(key, { from, to });
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
        shotSources.set(finding.crop, {
          from: paths.resolveInsideVdiff(root, finding.crop),
          to,
        });
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
  if (request.review !== undefined) commentInput.review = request.review;
  const comment = renderComment(commentInput);
  await writeFile(path.join(outDir, BUNDLE_FILES.comment), comment.markdown, 'utf8');
  files.push(BUNDLE_FILES.comment);

  if (request.preview === true) {
    const available = new Set(Array.from(shotSources.values(), (source) => source.to));
    await writeFile(
      path.join(outDir, PREVIEW_PAGE),
      renderPreviewCard({ result, review: request.review, cells: selected, available, version: request.version }),
      'utf8',
    );
    files.push(PREVIEW_PAGE);
  }

  // The review verbatim, like findings.json: a consumer reading the bundle gets the same object the
  // store holds, attribution included, rather than only the rendering of it (D39).
  if (request.review !== undefined) {
    await writeFile(
      path.join(outDir, BUNDLE_FILES.review),
      `${JSON.stringify(request.review, null, 2)}\n`,
      'utf8',
    );
    files.push(BUNDLE_FILES.review);
  }

  // The snapshot the page carries: the diff verbatim, both runs summarised for the header's run
  // pickers, and an image map in the shape this bundle's `--html` mode asked for. Attribution is
  // not embedded (it lives outside the DiffResult); the app renders no annotations for it, exactly
  // as a live report does when the fetch fails.
  const snapshotWith = (imageMap: Record<string, string>): ReportSnapshot => ({
    flow,
    base: result.pair.base,
    head: result.pair.head,
    diff: result,
    runs: [runSummary(result.baseMeta), runSummary(result.headMeta)],
    images: imageMap,
    ...(request.notices === undefined || request.notices.length === 0
      ? {}
      : { notices: [...request.notices] }),
    ...(request.gate === undefined ? {} : { gate: request.gate }),
    ...(currentReview === undefined ? {} : { review: currentReview }),
    version: request.version,
    generatedAt: request.generatedAt,
  });

  const linkedImages = (): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const [key, { to }] of shotSources) map[key] = to;
    return map;
  };

  // The self-contained map reads the images back rather than reusing bytes from the copy above,
  // because the copy is a streamed `copyFile`. A source that vanished between the two reads drops
  // out of the map, and the app renders its missing-capture state — never a broken image icon.
  const inlineImages = async (): Promise<Record<string, string>> => {
    const map: Record<string, string> = {};
    for (const [key, { from }] of shotSources) {
      try {
        map[key] = `data:image/png;base64,${(await readFile(from)).toString('base64')}`;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return map;
  };

  const appScript = request.appScript ?? null;
  const page = (imageMap: Record<string, string>): string =>
    renderReportPage({ snapshot: snapshotWith(imageMap), appScript });

  if (html === 'inline') {
    await writeFile(path.join(outDir, BUNDLE_FILES.report), page(await inlineImages()), 'utf8');
    files.push(BUNDLE_FILES.report);
  } else {
    await writeFile(path.join(outDir, BUNDLE_FILES.report), page(linkedImages()), 'utf8');
    files.push(BUNDLE_FILES.report);
    if (html === 'both') {
      await writeFile(
        path.join(outDir, BUNDLE_FILES.reportInline),
        page(await inlineImages()),
        'utf8',
      );
      files.push(BUNDLE_FILES.reportInline);
    }
  }

  const summary: BundleSummary = {
    flow,
    pair: result.pair,
    summary: result.summary,
    notices: [...(request.notices ?? [])],
    gate: request.gate ?? null,
    review: request.review ?? null,
    engineVersion: result.engineVersion,
    version: request.version,
    generatedAt: request.generatedAt,
    images: request.images,
    html,
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
