/**
 * Stage 1 — structural flow diff (spec §8).
 *
 * Aligns two `flow.snapshot.yaml` step lists by `id` (never by index — D4 depends on it) and puts
 * every step in exactly one bucket: matched, added, removed, spec-changed, failed, blocked.
 * Runs before any pixel work, and is pure: two snapshots plus the two runs' step results in,
 * a `FlowDiffEntry[]` out.
 *
 * NOTE: this lives in `src/diff` rather than `src/flow` only because the diff engine is the sole
 * consumer today and must not depend on a module that is being written in parallel. It is a pure
 * function of two `FlowSnapshot`s, so moving it behind a `src/flow` export later is mechanical.
 */

import type {
  FlowDiffEntry,
  FlowDiffStatus,
  FlowSnapshot,
  Step,
  StepId,
  StepResult,
} from '../types.js';

export interface FlowDiffInput {
  base: FlowSnapshot;
  head: FlowSnapshot;
  /** Step results keyed by id; supplies the `failed` and `blocked` buckets. */
  baseSteps?: Record<StepId, StepResult | undefined>;
  headSteps?: Record<StepId, StepResult | undefined>;
}

/** Verbs compared for the drift signal, in report order. `id` is the alignment key, not a change. */
const COMPARED_KEYS = [
  'goto',
  'click',
  'fill',
  'press',
  'hover',
  'scroll',
  'viewport',
  'waitFor',
  'expect',
  'mask',
  'shoot',
] as const;
type ComparedKey = (typeof COMPARED_KEYS)[number];

/** Verbs whose value is a selector, so drift reads as `selector 'a' -> 'b'` (spec §8 example). */
const SELECTOR_KEYS: ReadonlySet<ComparedKey> = new Set(['click', 'hover', 'waitFor']);

function quoted(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : JSON.stringify(v);
}

function valueOf(step: Step, key: ComparedKey): unknown {
  const v = (step as unknown as Record<string, unknown>)[key];
  if (key === 'shoot') return v === undefined ? true : v;
  return v;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function describeFillChange(base: unknown, head: unknown): string[] {
  const b = (base ?? {}) as Record<string, string>;
  const h = (head ?? {}) as Record<string, string>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(h)])].sort();
  const out: string[] = [];
  for (const k of keys) {
    if (b[k] === h[k]) continue;
    if (b[k] === undefined) out.push(`added fill ${quoted(k)}`);
    else if (h[k] === undefined) out.push(`removed fill ${quoted(k)}`);
    else out.push(`fill ${quoted(k)} changed`);
  }
  return out;
}

/** Human-readable, machine-stable description of the differences between two same-id steps. */
export function describeStepChanges(base: Step, head: Step): string[] {
  const out: string[] = [];
  for (const key of COMPARED_KEYS) {
    const b = valueOf(base, key);
    const h = valueOf(head, key);
    if (sameValue(b, h)) continue;
    if (key === 'fill') {
      out.push(...describeFillChange(b, h));
      continue;
    }
    if (b === undefined) {
      out.push(`added ${key} ${quoted(h)}`);
      continue;
    }
    if (h === undefined) {
      out.push(`removed ${key} ${quoted(b)}`);
      continue;
    }
    if (SELECTOR_KEYS.has(key)) {
      out.push(`selector ${quoted(b)} -> ${quoted(h)}`);
      continue;
    }
    if (typeof b === 'string' || typeof b === 'boolean' || typeof b === 'number') {
      out.push(`${key} ${quoted(b)} -> ${quoted(h)}`);
      continue;
    }
    out.push(`${key} changed`);
  }
  return out;
}

function runStatusBucket(
  baseResult: StepResult | undefined,
  headResult: StepResult | undefined,
): { status: FlowDiffStatus; detail?: string } | null {
  const failed = [
    ['base', baseResult],
    ['head', headResult],
  ] as const;
  for (const [side, result] of failed) {
    if (result?.status === 'failed') {
      const message = result.failure?.message;
      return {
        status: 'failed',
        detail: message === undefined ? `failed in ${side}` : `failed in ${side}: ${message}`,
      };
    }
  }
  for (const [side, result] of failed) {
    if (result?.status === 'blocked' || result?.status === 'skipped') {
      return { status: 'blocked', detail: `${result.status} in ${side}` };
    }
  }
  return null;
}

/**
 * Bucket precedence: existence (added/removed) beats execution outcome (failed, then blocked),
 * which beats spec drift, which beats matched. A step that never ran cannot be pixel-compared, so
 * its outcome outranks the fact that its selector also moved — the drift still shows in `detail`.
 */
export function structuralFlowDiff(input: FlowDiffInput): FlowDiffEntry[] {
  const { base, head } = input;
  const baseSteps = base.steps ?? [];
  const headSteps = head.steps ?? [];

  const baseById = new Map<StepId, { step: Step; index: number }>();
  baseSteps.forEach((step, index) => {
    if (!baseById.has(step.id)) baseById.set(step.id, { step, index });
  });
  const headById = new Map<StepId, { step: Step; index: number }>();
  headSteps.forEach((step, index) => {
    if (!headById.has(step.id)) headById.set(step.id, { step, index });
  });

  const entryFor = (id: StepId): FlowDiffEntry => {
    const b = baseById.get(id);
    const h = headById.get(id);
    const baseIndex = b?.index ?? null;
    const headIndex = h?.index ?? null;
    const outcome = runStatusBucket(input.baseSteps?.[id], input.headSteps?.[id]);

    if (b === undefined && h !== undefined) {
      return { id, status: 'added', baseIndex, headIndex };
    }
    if (h === undefined && b !== undefined) {
      return { id, status: 'removed', baseIndex, headIndex };
    }
    if (b === undefined || h === undefined) {
      // Present in neither snapshot: only reachable from a run directory holding an orphan step.
      return { id, status: 'removed', baseIndex, headIndex };
    }

    const drift = describeStepChanges(b.step, h.step);
    if (outcome !== null) {
      const detail =
        drift.length > 0 ? `${outcome.detail ?? outcome.status}; ${drift.join('; ')}` : outcome.detail;
      return detail === undefined
        ? { id, status: outcome.status, baseIndex, headIndex }
        : { id, status: outcome.status, detail, baseIndex, headIndex };
    }
    if (drift.length > 0) {
      return { id, status: 'spec-changed', detail: drift.join('; '), baseIndex, headIndex };
    }
    return { id, status: 'matched', baseIndex, headIndex };
  };

  // Merge in head order, flushing base-only steps at the position they were removed from.
  const entries: FlowDiffEntry[] = [];
  const emitted = new Set<StepId>();
  let bi = 0;
  for (const h of headSteps) {
    while (bi < baseSteps.length) {
      const candidate = baseSteps[bi] as Step;
      if (candidate.id === h.id) {
        bi += 1;
        break;
      }
      if (headById.has(candidate.id)) break;
      if (!emitted.has(candidate.id)) {
        entries.push(entryFor(candidate.id));
        emitted.add(candidate.id);
      }
      bi += 1;
    }
    if (!emitted.has(h.id)) {
      entries.push(entryFor(h.id));
      emitted.add(h.id);
    }
  }
  for (const b of baseSteps) {
    if (emitted.has(b.id)) continue;
    entries.push(entryFor(b.id));
    emitted.add(b.id);
  }
  return entries;
}

/** Steps whose pixels are worth comparing: present on both sides and not failed or blocked. */
export function isComparable(status: FlowDiffStatus): boolean {
  return status === 'matched' || status === 'spec-changed';
}
