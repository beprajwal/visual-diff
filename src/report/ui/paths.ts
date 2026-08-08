/**
 * Store paths and blob URLs, mirrored from the on-disk layout in spec §6.
 *
 * The diff payload (`DiffResult`) carries diff-side artifact paths (`pixelPath`, `regionsPath`,
 * `Finding.crop`) but not the run-side screenshots, because those belong to the runs rather than to
 * the pair. Their location is fully determined by §6:
 *
 *   runs/<flow>/<runId>/steps/<stepId>/<viewport>/screenshot.png
 *
 * so the UI reconstructs them here rather than requiring an extra round trip. Everything in this
 * file is pure string work; it is the single place that knows the store layout.
 */

import type { PairId, RunId, StepId, ViewportId } from '../../types.js';

/**
 * URL prefix under which the report server exposes blobs from the store (spec §9, "blobs served
 * from the store"). It sits under `/api` with every other route, because the session-token gate in
 * `report/server/auth.ts` covers `/api/*` — a blob namespace outside it would be an unauthenticated
 * read of the store.
 */
export const BLOB_BASE = '/api/blob';

/** Directory of one run, relative to the `.visual-diff` directory. */
export function runDir(flow: string, runId: RunId): string {
  return `runs/${flow}/${runId}`;
}

/** Directory of one step within a run, keyed by step id and never by ordinal (spec §6). */
export function stepDir(flow: string, runId: RunId, step: StepId): string {
  return `${runDir(flow, runId)}/steps/${step}`;
}

/** Full-page screenshot for one shot, relative to the `.visual-diff` directory. */
export function screenshotPath(
  flow: string,
  runId: RunId,
  step: StepId,
  viewport: ViewportId,
): string {
  return `${stepDir(flow, runId, step)}/${viewport}/screenshot.png`;
}

/** DOM snapshot for one shot, relative to the `.visual-diff` directory. */
export function domPath(flow: string, runId: RunId, step: StepId, viewport: ViewportId): string {
  return `${stepDir(flow, runId, step)}/${viewport}/dom.json`;
}

/** "<base>..<head>". */
export function pairId(base: RunId, head: RunId): PairId {
  return `${base}..${head}`;
}

/** Inverse of {@link pairId}. Returns null for anything that is not exactly two run ids. */
export function parsePairId(id: string): { base: RunId; head: RunId } | null {
  const parts = id.split('..');
  if (parts.length !== 2) return null;
  const base = parts[0];
  const head = parts[1];
  if (!base || !head) return null;
  return { base, head };
}

/** Stored diff directory for a pair, relative to the `.visual-diff` directory. */
export function diffDir(flow: string, base: RunId, head: RunId): string {
  return `diffs/${flow}/${pairId(base, head)}`;
}

/** Pixel-diff image for one (step, viewport) of a pair. */
export function pixelPath(
  flow: string,
  base: RunId,
  head: RunId,
  step: StepId,
  viewport: ViewportId,
): string {
  return `${diffDir(flow, base, head)}/steps/${step}/${viewport}/pixel.png`;
}

/** Crop image for one finding of a pair. */
export function cropPath(flow: string, base: RunId, head: RunId, findingId: string): string {
  return `${diffDir(flow, base, head)}/crops/${findingId}.png`;
}

/** Strips leading `./` and `/` so a store-relative path never escapes the blob namespace. */
function normalizeStorePath(storePath: string): string {
  let p = storePath.trim();
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  return p;
}

/**
 * Blob URL for a path relative to the `.visual-diff` directory. Each segment is encoded
 * individually so slashes survive and everything else (spaces, `#`, `?`) is escaped.
 */
export function blobUrl(storePath: string, token?: string | null): string {
  const encoded = normalizeStorePath(storePath)
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join('/');
  const url = `${BLOB_BASE}/${encoded}`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}
