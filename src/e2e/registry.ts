/**
 * `e2e/` — reader dispatch (e2e spec §2).
 *
 * §2's non-goals say it plainly: "Playwright traces only … the ingestion layer stays format-agnostic
 * internally so a second reader can be added without reshaping the pipeline, but no second reader
 * ships here." This is the whole of that seam — a list, a lookup, and a read that goes through the
 * interface rather than around it.
 *
 * It is one entry long today. It exists anyway, because the difference between a pipeline that can
 * accept a second reader and one that cannot is whether its callers ever named the first one.
 */

import { playwrightTraceReader } from './playwright/reader.js';
import type { E2eIngest, E2eReadOptions, E2eSourceFormat, E2eSourceReader } from './types.js';

/** Every reader this build ships, in the order `vdiff e2e` would try them. */
export const readers: readonly E2eSourceReader[] = [playwrightTraceReader];

export function readerFor(format: E2eSourceFormat): E2eSourceReader {
  const reader = readers.find((candidate) => candidate.format === format);
  if (reader === undefined) {
    // Unreachable through the CLI, whose `--from` argument is validated against the same list.
    throw new Error(
      `no e2e reader for format '${format}'; this build reads: ${readers
        .map((candidate) => candidate.format)
        .join(', ')}`,
    );
  }
  return reader;
}

/** Reads one archive with the named format's reader. */
export async function readSource(
  format: E2eSourceFormat,
  archivePath: string,
  options?: E2eReadOptions,
): Promise<E2eIngest> {
  return readerFor(format).read(archivePath, options);
}
