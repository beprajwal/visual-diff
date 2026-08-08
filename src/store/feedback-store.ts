/**
 * store/feedback-store — `feedback/pending.jsonl` and its archive (spec §9, D6).
 *
 * The report page appends JSON here and nothing else; **no code path in this file executes a
 * process, touches git, or runs a build**, and that must remain true as the tool grows (D6).
 *
 * Appends are a single `O_APPEND` write of one line, so two writers interleave lines rather than
 * corrupting one. `ack` rewrites `pending.jsonl` atomically with exactly the entries that were not
 * acknowledged — including any line the reader could not parse, which is preserved verbatim rather
 * than silently dropped.
 */

import { promises as fsp } from 'node:fs';

import { writeFileAtomic } from './internal/atomic.js';
import { ensureDir, listDirEntries, readJsonl } from './internal/fs.js';
import { nextFeedbackId } from './internal/id.js';
import { stableStringifyLine } from './internal/json.js';
import * as paths from './paths.js';
import type { FeedbackEntry, FeedbackInput } from '../types.js';

export interface AppendFeedbackOptions {
  /** Crop path relative to `.visual-diff/`, as produced by `diff-store.writeCrop`. */
  crop?: string;
  /** Injected for deterministic tests. */
  now?: Date;
  /** Injected for deterministic tests; otherwise allocated from what is already stored. */
  id?: string;
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Ids already used, across pending and every archive file, so ids never repeat. */
async function usedIds(root: string): Promise<string[]> {
  const ids: string[] = [];
  for (const line of await readJsonl<FeedbackEntry>(paths.feedbackPendingFile(root))) {
    if (line.value !== null && typeof line.value.id === 'string') ids.push(line.value.id);
  }
  for (const entry of await listDirEntries(paths.feedbackArchiveDir(root))) {
    if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;
    const file = paths.feedbackArchiveFile(root, entry.name.slice(0, -'.jsonl'.length));
    for (const line of await readJsonl<FeedbackEntry>(file)) {
      if (line.value !== null && typeof line.value.id === 'string') ids.push(line.value.id);
    }
  }
  return ids;
}

export async function appendFeedback(
  root: string,
  input: FeedbackInput,
  options: AppendFeedbackOptions = {},
): Promise<FeedbackEntry> {
  const now = options.now ?? new Date();
  const id = options.id ?? nextFeedbackId(await usedIds(root));
  const entry: FeedbackEntry = {
    id,
    ts: now.toISOString(),
    flow: input.flow,
    pair: input.pair,
    text: input.text,
    status: 'pending',
  };
  if (input.step !== undefined) entry.step = input.step;
  if (input.viewport !== undefined) entry.viewport = input.viewport;
  if (input.findingId !== undefined) entry.findingId = input.findingId;
  if (input.element !== undefined) entry.element = input.element;
  if (input.region !== undefined) entry.region = input.region;
  if (options.crop !== undefined) entry.crop = options.crop;

  await ensureDir(paths.feedbackDir(root));
  await fsp.appendFile(paths.feedbackPendingFile(root), `${stableStringifyLine(entry)}\n`, {
    encoding: 'utf8',
  });
  return entry;
}

export interface ReadFeedbackFilter {
  flow?: string;
  pair?: string;
}

function matches(entry: FeedbackEntry, filter: ReadFeedbackFilter): boolean {
  if (filter.flow !== undefined && entry.flow !== filter.flow) return false;
  if (filter.pair !== undefined && entry.pair !== filter.pair) return false;
  return true;
}

export async function readPendingFeedback(
  root: string,
  filter: ReadFeedbackFilter = {},
): Promise<FeedbackEntry[]> {
  const lines = await readJsonl<FeedbackEntry>(paths.feedbackPendingFile(root));
  const out: FeedbackEntry[] = [];
  for (const line of lines) {
    if (line.value === null) continue;
    if (matches(line.value, filter)) out.push(line.value);
  }
  return out;
}

export interface AckResult {
  acked: FeedbackEntry[];
  /** Entries left in `pending.jsonl`. */
  remaining: number;
  /** Archive file written, absolute; null when nothing was acknowledged. */
  archive: string | null;
}

/**
 * Archive exactly the entries named by `ids`, leaving everything else pending — which is what
 * `vdiff feedback --json --ack` needs: it archives what it read, not what arrived while it read.
 */
export async function ackFeedback(
  root: string,
  ids: readonly string[],
  options: { now?: Date } = {},
): Promise<AckResult> {
  const wanted = new Set(ids);
  if (wanted.size === 0) {
    return { acked: [], remaining: (await readPendingFeedback(root)).length, archive: null };
  }
  const now = options.now ?? new Date();
  const ackedAt = now.toISOString();
  const lines = await readJsonl<FeedbackEntry>(paths.feedbackPendingFile(root));

  const acked: FeedbackEntry[] = [];
  const keep: string[] = [];
  for (const line of lines) {
    if (line.value !== null && wanted.has(line.value.id)) {
      acked.push({ ...line.value, status: 'acked', ackedAt });
    } else {
      // Unparsable lines are kept verbatim: acking must never destroy data it could not read.
      keep.push(line.raw);
    }
  }
  if (acked.length === 0) {
    return { acked: [], remaining: keep.length, archive: null };
  }

  const archive = paths.feedbackArchiveFile(root, dayStamp(now));
  await ensureDir(paths.feedbackArchiveDir(root));
  await fsp.appendFile(archive, `${acked.map(stableStringifyLine).join('\n')}\n`, {
    encoding: 'utf8',
  });
  await writeFileAtomic(
    paths.feedbackPendingFile(root),
    keep.length === 0 ? '' : `${keep.join('\n')}\n`,
  );
  return { acked, remaining: keep.length, archive };
}

/** Acknowledge every entry currently pending (optionally narrowed by flow). */
export async function ackAllPending(
  root: string,
  filter: ReadFeedbackFilter = {},
  options: { now?: Date } = {},
): Promise<AckResult> {
  const pending = await readPendingFeedback(root, filter);
  return ackFeedback(
    root,
    pending.map((entry) => entry.id),
    options,
  );
}

export async function readArchivedFeedback(
  root: string,
  date?: string,
): Promise<FeedbackEntry[]> {
  const files: string[] = [];
  if (date !== undefined) {
    files.push(paths.feedbackArchiveFile(root, date));
  } else {
    for (const entry of await listDirEntries(paths.feedbackArchiveDir(root))) {
      if (entry.isFile && entry.name.endsWith('.jsonl')) {
        files.push(paths.feedbackArchiveFile(root, entry.name.slice(0, -'.jsonl'.length)));
      }
    }
    files.sort();
  }
  const out: FeedbackEntry[] = [];
  for (const file of files) {
    for (const line of await readJsonl<FeedbackEntry>(file)) {
      if (line.value !== null) out.push(line.value);
    }
  }
  return out;
}
