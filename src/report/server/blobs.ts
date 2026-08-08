/**
 * Blob serving from the store (spec §9): screenshots, pixel diffs, crops, and the JSON/YAML
 * artefacts the report reads directly.
 *
 * Paths are relative to `.visual-diff`, exactly as they appear in `findings.json`
 * (`diffs/<flow>/<pair>/crops/f1.png`) and as the UI joins them for run artefacts
 * (`runs/<flow>/<run>/steps/<step>/<viewport>/screenshot.png`).
 *
 * The traversal guard lives in `store-reader.ts#resolveBlob`: it rejects absolute paths, `..`,
 * anything outside `runs/` and `diffs/`, disallowed extensions, non-files, and symlinks pointing
 * out of the store. This file only turns the resolved path into a response.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

import type { ReportStore } from './deps.js';
import { baseHeaders, contentTypeFor, HttpError } from './http.js';

/** Blobs are content-addressed by run id in practice: a stored artefact never changes in place. */
const CACHE_CONTROL = 'private, max-age=60';

export async function serveBlob(
  store: ReportStore,
  relPath: string,
  res: ServerResponse,
): Promise<void> {
  const resolved = await store.resolveBlob(relPath);
  if (!resolved) {
    throw new HttpError(404, 'no-such-blob', `No stored artefact at "${relPath}".`);
  }

  let body: Buffer;
  try {
    body = await fs.readFile(resolved);
  } catch {
    throw new HttpError(404, 'no-such-blob', `No stored artefact at "${relPath}".`);
  }

  res.writeHead(200, {
    ...baseHeaders(),
    'Content-Type': contentTypeFor(path.extname(resolved)),
    'Content-Length': String(body.byteLength),
    'Cache-Control': CACHE_CONTROL,
  });
  res.end(body);
}
