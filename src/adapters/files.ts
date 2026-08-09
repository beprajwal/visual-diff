/**
 * Managed-file writing shared by every harness adapter.
 *
 * An adapter's whole job is to drop markdown into a harness's config directory (spec §5, §9). The
 * only interesting behaviour is what happens on the second install: the files must be refreshed
 * when the tool ships new content, and a file a human has edited must never be silently clobbered.
 *
 * Every generated file therefore ends with a stamp line carrying the sha256 of its own body:
 *
 *     <!-- vdiff:managed v1 sha256:… -->
 *
 * If the stamp still matches the body, the file is exactly as this tool last wrote it and may be
 * replaced. If it does not match, or the stamp is gone, a human touched it: the file is preserved
 * and reported back in `skipped`.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import { applyBlock } from './blocks.js';

/** Bumped only if the stamp format itself changes. */
export const MANAGED_STAMP_VERSION = 'v1';

const STAMP_RE = /^<!--\s*vdiff:managed\s+(v\d+)\s+sha256:([0-9a-f]{64})\s*-->$/;

/**
 * How much of a file this tool owns.
 *
 * - `file`  — all of it. The body is written verbatim above a stamp line, and a human edit is
 *   detected and preserved. This is every skill and command file.
 * - `block` — only the span between the `vdiff` markers (D19). The file belongs to the user, so
 *   there is no stamp, nothing is ever preserved-and-skipped (nothing of theirs is at risk), and a
 *   malformed block throws instead of guessing.
 */
export type ManagedMode = 'file' | 'block';

/** One file an adapter wants to exist, addressed relative to the project root. */
export interface ManagedFile {
  /** Path relative to the project root, always with `/` separators. */
  path: string;
  /** Markdown body, written verbatim above the stamp line — or into the block, in `block` mode. */
  body: string;
  /** Defaults to `file`. */
  mode?: ManagedMode;
}

/**
 * - `created`   — the file did not exist
 * - `updated`   — the file was ours and out of date
 * - `unchanged` — the file was already byte-identical to what we would write
 * - `preserved` — a human edited it; left alone and reported
 */
export type FileStatus = 'created' | 'updated' | 'unchanged' | 'preserved';

export interface FileOutcome {
  path: string;
  status: FileStatus;
}

export interface WriteOptions {
  /** Overwrite human-edited files instead of preserving them. */
  force?: boolean;
  /** Compute outcomes without touching the disk. */
  dryRun?: boolean;
}

export interface WriteReport {
  /** Paths that were (or would be) written: `created` plus `updated`. */
  written: string[];
  /** Paths left alone: `unchanged` plus `preserved`. */
  skipped: string[];
  files: FileOutcome[];
}

/** Normalise line endings and guarantee exactly one trailing newline. */
export function normalizeBody(body: string): string {
  return `${body.replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`;
}

/** sha256 of the normalised body — the value carried by the stamp. */
export function bodyHash(body: string): string {
  return createHash('sha256').update(normalizeBody(body), 'utf8').digest('hex');
}

export function stampLine(hash: string): string {
  return `<!-- vdiff:managed ${MANAGED_STAMP_VERSION} sha256:${hash} -->`;
}

/** Body plus a blank line plus the stamp. This is the exact bytes written to disk. */
export function renderManaged(body: string): string {
  const normalized = normalizeBody(body);
  return `${normalized}\n${stampLine(bodyHash(normalized))}\n`;
}

/** Split a file back into body and claimed hash, or null when it carries no stamp. */
export function parseManaged(content: string): { body: string; hash: string } | null {
  const lines = content.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1] ?? '';
  const match = STAMP_RE.exec(last.trim());
  if (!match) return null;
  return { body: normalizeBody(lines.slice(0, -1).join('\n')), hash: match[2] as string };
}

/** True when the file is byte-for-byte what this tool last wrote (whatever version that was). */
export function isUnmodifiedManaged(content: string): boolean {
  const parsed = parseManaged(content);
  if (!parsed) return false;
  return bodyHash(parsed.body) === parsed.hash;
}

/** The decision for a single file. Pure: existing content in, status out. */
export function planFile(existing: string | null, body: string, force = false): FileStatus {
  const desired = renderManaged(body);
  if (existing === null) return 'created';
  if (existing === desired) return 'unchanged';
  if (force || isUnmodifiedManaged(existing)) return 'updated';
  return 'preserved';
}

function resolveInsideRoot(root: string, relPath: string): string {
  if (isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
    throw new Error(`adapter file path must be relative and inside the project root: ${relPath}`);
  }
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, relPath);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new Error(`adapter file path escapes the project root: ${relPath}`);
  }
  return target;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The decision for a block-managed file (D19). Pure, and it never returns `preserved`: the user's
 * bytes outside the block are kept whatever happens, so there is nothing to refuse.
 */
export function planBlock(
  existing: string | null,
  body: string,
  path: string,
): { status: FileStatus; content: string } {
  const content = applyBlock(existing, body, path);
  if (existing === null) return { status: 'created', content };
  return { status: content === existing ? 'unchanged' : 'updated', content };
}

/**
 * Write every managed file under `root`, honouring the preserve rule above.
 *
 * Shared by all four harness adapters — only the file list differs, and a "global" install is the
 * same relative paths written under the home directory rather than the project root, which is why
 * every path here must stay relative.
 *
 * A `block`-mode file whose markers are malformed throws {@link MalformedBlockError} rather than
 * being silently skipped, including under `--dry-run`: the point of a dry run is to find out.
 */
export async function writeManagedFiles(
  root: string,
  files: readonly ManagedFile[],
  options: WriteOptions = {},
): Promise<WriteReport> {
  const outcomes: FileOutcome[] = [];

  for (const file of files) {
    const target = resolveInsideRoot(root, file.path);
    const existing = await readIfPresent(target);

    let status: FileStatus;
    let content: string;
    if ((file.mode ?? 'file') === 'block') {
      const planned = planBlock(existing, file.body, file.path);
      status = planned.status;
      content = planned.content;
    } else {
      status = planFile(existing, file.body, options.force ?? false);
      content = renderManaged(file.body);
    }

    if (!options.dryRun && (status === 'created' || status === 'updated')) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }

    outcomes.push({ path: file.path, status });
  }

  return {
    written: outcomes.filter((o) => o.status === 'created' || o.status === 'updated').map((o) => o.path),
    skipped: outcomes.filter((o) => o.status === 'unchanged' || o.status === 'preserved').map((o) => o.path),
    files: outcomes,
  };
}
