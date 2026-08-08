/**
 * store/internal — identifier allocation.
 *
 * Run ids are zero-padded and monotonically increasing *per flow* (spec §6). They are allocated
 * from the ids already on disk rather than from a counter file, so a crashed run leaves no gap in
 * a counter and a manually deleted directory cannot cause a collision.
 */

import type { PairId, RunId } from '../../types.js';

export const RUN_ID_WIDTH = 4;

const RUN_ID_RE = /^\d{4,}$/;
const LOOSE_RUN_ID_RE = /^\d+$/;
const PAIR_ID_RE = /^(\d+)\.\.(\d+)$/;

/** A directory name is a run id only if it is all digits and at least the padded width. */
export function isRunId(value: string): boolean {
  return RUN_ID_RE.test(value);
}

/** `7` → `"0007"`. Ids past 9999 simply get wider; they never wrap or truncate. */
export function formatRunId(n: number): RunId {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`run ordinal must be a non-negative integer, got ${String(n)}`);
  }
  return String(n).padStart(RUN_ID_WIDTH, '0');
}

export function parseRunId(id: string): number | null {
  if (!LOOSE_RUN_ID_RE.test(id)) return null;
  const n = Number.parseInt(id, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** Accepts what a human types (`7`, `007`, `0007`) and returns the canonical padded form. */
export function normalizeRunId(input: string): RunId | null {
  const n = parseRunId(input.trim());
  return n === null ? null : formatRunId(n);
}

/**
 * Monotonic per flow: one past the highest id seen, so ids never repeat even after a prune or a
 * manual deletion in the middle of the range.
 */
export function nextRunId(existing: readonly RunId[]): RunId {
  let max = -1;
  for (const id of existing) {
    const n = parseRunId(id);
    if (n !== null && n > max) max = n;
  }
  return formatRunId(max + 1);
}

export function compareRunIds(a: RunId, b: RunId): number {
  const na = parseRunId(a);
  const nb = parseRunId(b);
  if (na !== null && nb !== null) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortRunIds(ids: readonly RunId[]): RunId[] {
  return [...ids].sort(compareRunIds);
}

export function pairId(base: RunId, head: RunId): PairId {
  return `${base}..${head}`;
}

export function parsePairId(value: string): { base: RunId; head: RunId } | null {
  const match = PAIR_ID_RE.exec(value.trim());
  if (match === null) return null;
  const base = normalizeRunId(match[1] as string);
  const head = normalizeRunId(match[2] as string);
  if (base === null || head === null) return null;
  return { base, head };
}

const FEEDBACK_ID_RE = /^fb_(\d+)$/;
export const FEEDBACK_ID_WIDTH = 2;

/** `1` → `"fb_01"`, matching the spec §9 example. */
export function feedbackId(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`feedback ordinal must be a positive integer, got ${String(n)}`);
  }
  return `fb_${String(n).padStart(FEEDBACK_ID_WIDTH, '0')}`;
}

export function parseFeedbackId(id: string): number | null {
  const match = FEEDBACK_ID_RE.exec(id);
  if (match === null) return null;
  const n = Number.parseInt(match[1] as string, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function nextFeedbackId(existing: readonly string[]): string {
  let max = 0;
  for (const id of existing) {
    const n = parseFeedbackId(id);
    if (n !== null && n > max) max = n;
  }
  return feedbackId(max + 1);
}
