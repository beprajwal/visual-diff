/**
 * Stage 1 — structural flow diff (spec §5 `flow/`, §8 stage 1, D4).
 *
 * "Align both `flow.snapshot.yaml` files by step `id`. Every step lands in exactly one bucket:
 * matched, added, removed, spec-changed, failed, blocked. Runs before any pixel work."
 *
 * Spec §5 puts "structural diff of two flow versions" in `flow/`, so this module is the single
 * implementation and `diff/` consumes it through the `flow/` module edge. It is pure: two snapshots
 * plus (optionally) the two runs' step results in, a `FlowDiffEntry[]` out. No filesystem, no
 * pixels, no Playwright.
 *
 * Alignment is by id and never by index (D4): reordering or inserting steps must not make unrelated
 * screens compare against each other. Position is reported through `baseIndex`/`headIndex` instead,
 * so a step whose body is unchanged stays `matched` even when it moved.
 *
 * The `failed` and `blocked` buckets describe what happened at replay time rather than what the two
 * specs say, so they are supplied by the caller as step results and folded in here — a step that
 * never ran cannot be pixel-compared, and the report needs that in the same list.
 */

import {
  STEP_VERBS,
  type FlowDiffEntry,
  type FlowDiffStatus,
  type FlowSnapshot,
  type FlowSpec,
  type Step,
  type StepId,
  type StepResult,
  type StepVerb,
} from '../types.js';
import { canonicalStep } from './serialize.js';

export interface FlowDiffInput {
  base: FlowSnapshot;
  head: FlowSnapshot;
  /** Step results keyed by id; supplies the `failed` and `blocked` buckets. */
  baseSteps?: Record<StepId, StepResult | undefined>;
  headSteps?: Record<StepId, StepResult | undefined>;
}

/** One verb-level difference between two versions of the same step. */
export interface StepFieldChange {
  key: StepVerb;
  /** `undefined` when the verb is absent in base. */
  from: unknown;
  /** `undefined` when the verb is absent in head. */
  to: unknown;
}

/** Verbs whose argument is a selector; their changes read as "selector 'a' -> 'b'" (spec §8). */
const SELECTOR_VERBS: ReadonlySet<StepVerb> = new Set<StepVerb>(['click', 'hover', 'waitFor']);

interface Located {
  step: Step;
  index: number;
}

/**
 * Align two flow snapshots by step id.
 *
 * Output order follows the head spec, with steps that exist only in base spliced in at the point
 * they disappeared from, so the result reads like the head flow with deletions visible. Flushing of
 * base-only steps stops as soon as it reaches a base step that still exists in head, so a reordered
 * step never drags unrelated deletions to the front; anything left over is appended.
 *
 * Every id appears exactly once, which the spec requires and the report's filmstrip relies on
 * (it keys steps by id). Duplicate ids are rejected by `validateFlowSpec`, so they only reach here
 * from a hand-edited snapshot; the first occurrence wins and the rest collapse into it.
 */
export function structuralFlowDiff(input: FlowDiffInput): FlowDiffEntry[] {
  // `?? []` is deliberate: snapshots are read back off disk, and a truncated `flow.snapshot.yaml`
  // should degrade to "everything on the other side is added/removed", not throw mid-diff.
  const baseSteps = input.base.steps ?? [];
  const headSteps = input.head.steps ?? [];

  const baseById = indexById(baseSteps);
  const headById = indexById(headSteps);

  const entryFor = (id: StepId): FlowDiffEntry => {
    const base = baseById.get(id);
    const head = headById.get(id);
    const baseIndex = base?.index ?? null;
    const headIndex = head?.index ?? null;

    if (head === undefined) return { id, status: 'removed', baseIndex, headIndex: null };
    if (base === undefined) return { id, status: 'added', baseIndex: null, headIndex };

    // Bucket precedence: existence (added/removed) beats execution outcome (failed, then blocked),
    // which beats spec drift, which beats matched. A step that never ran cannot be pixel-compared,
    // so its outcome outranks the fact that its selector also moved — the drift still shows in
    // `detail`.
    const drift = describeStepChanges(base.step, head.step);
    const outcome = runStatusBucket(input.baseSteps?.[id], input.headSteps?.[id]);

    if (outcome !== null) {
      const detail =
        drift.length > 0 ? [outcome.detail ?? outcome.status, ...drift].join('; ') : outcome.detail;
      return detail === undefined
        ? { id, status: outcome.status, baseIndex, headIndex }
        : { id, status: outcome.status, detail, baseIndex, headIndex };
    }
    if (drift.length > 0) {
      return { id, status: 'spec-changed', detail: drift.join('; '), baseIndex, headIndex };
    }
    return { id, status: 'matched', baseIndex, headIndex };
  };

  const entries: FlowDiffEntry[] = [];
  const emitted = new Set<StepId>();
  const emit = (id: StepId): void => {
    if (emitted.has(id)) return;
    emitted.add(id);
    entries.push(entryFor(id));
  };

  let cursor = 0;
  for (const headStep of headSteps) {
    while (cursor < baseSteps.length) {
      const candidate = baseSteps[cursor];
      if (candidate === undefined) break;
      if (candidate.id === headStep.id) {
        cursor += 1;
        break;
      }
      if (headById.has(candidate.id)) break;
      emit(candidate.id);
      cursor += 1;
    }
    emit(headStep.id);
  }
  for (const baseStep of baseSteps) emit(baseStep.id);

  return entries;
}

/** Steps whose pixels are worth comparing: present on both sides and not failed or blocked. */
export function isComparable(status: FlowDiffStatus): boolean {
  return status === 'matched' || status === 'spec-changed';
}

/**
 * Verb-level differences between two versions of a step, in `STEP_VERBS` order.
 *
 * `STEP_VERBS` is the closed vocabulary from `types.ts`, so there is no second comparison table to
 * drift out of sync when a verb is added.
 *
 * Both sides are canonicalized first (the same canonical form `flowHash` uses), so an omitted
 * `shoot` equals an explicit `shoot: true` and the authored key order inside `scroll` or an `expect`
 * entry is irrelevant — reformatting a flow file must not light up the report. The order of `fill`
 * entries is *not* normalized away: fields are filled in the order they are written, so reordering
 * them is a real change (see `describeFillChanges`).
 */
export function stepSpecChanges(base: Step, head: Step): StepFieldChange[] {
  const baseCanonical = canonicalStep(base);
  const headCanonical = canonicalStep(head);

  const changes: StepFieldChange[] = [];
  for (const verb of STEP_VERBS) {
    const from = baseCanonical[verb];
    const to = headCanonical[verb];
    if (from === undefined && to === undefined) continue;
    if (jsonOf(from) === jsonOf(to)) continue;
    changes.push({ key: verb, from, to });
  }
  return changes;
}

/** Human-readable, machine-stable description of the differences between two same-id steps. */
export function describeStepChanges(base: Step, head: Step): string[] {
  return formatStepChanges(stepSpecChanges(base, head));
}

/**
 * Renders verb-level changes as the strings the report shows on a `spec-changed` step, e.g.
 * `selector '#pay' -> '[data-test=pay]'` (spec §8). Joined with `; ` they become `FlowDiffEntry.detail`.
 *
 * Rules, in the order they apply:
 *   - `fill` expands per field, by field name only — fill values are card numbers and passwords, so
 *     they are never printed (see `describeFillChanges`);
 *   - a verb present on one side only reads `added <verb> <value>` / `removed <verb> <value>`;
 *   - a changed selector verb reads `selector 'a' -> 'b'`, unless two selector verbs changed at
 *     once, in which case each is named by its verb so the pair stays unambiguous;
 *   - a changed scalar reads `<verb> <from> -> <to>`;
 *   - a changed structured value (`scroll`, `mask`, `expect`) reads `<verb> changed`. These live in
 *     a filmstrip badge tooltip, and dumping a whole `expect` array there is unreadable.
 */
export function formatStepChanges(changes: readonly StepFieldChange[]): string[] {
  // Only two-sided selector changes can print the ambiguous word "selector"; `added hover '#x'`
  // already names its verb, so it never forces disambiguation.
  const ambiguousSelectors =
    changes.filter(
      (change) =>
        SELECTOR_VERBS.has(change.key) && change.from !== undefined && change.to !== undefined,
    ).length > 1;

  const out: string[] = [];
  for (const change of changes) {
    if (change.key === 'fill') {
      out.push(...describeFillChanges(change.from, change.to));
      continue;
    }
    if (change.from === undefined) {
      out.push(`added ${change.key} ${quoted(change.to)}`);
      continue;
    }
    if (change.to === undefined) {
      out.push(`removed ${change.key} ${quoted(change.from)}`);
      continue;
    }
    if (SELECTOR_VERBS.has(change.key)) {
      const label = ambiguousSelectors ? change.key : 'selector';
      out.push(`${label} ${quoted(change.from)} -> ${quoted(change.to)}`);
      continue;
    }
    if (isScalar(change.from) && isScalar(change.to)) {
      out.push(`${change.key} ${quoted(change.from)} -> ${quoted(change.to)}`);
      continue;
    }
    out.push(`${change.key} changed`);
  }
  return out;
}

/**
 * Flow-level drift that is not per-step: base URL, viewport matrix, network mode and HAR. Returned
 * as human strings for `DiffResult.warnings`, because these change what a run *means* without
 * changing any single step — the same steps against a different base URL is not the same comparison.
 */
export function flowLevelChanges(base: FlowSpec, head: FlowSpec): string[] {
  const out: string[] = [];
  if (base.baseUrl !== head.baseUrl) {
    out.push(`baseUrl ${valued(base.baseUrl)} -> ${valued(head.baseUrl)}`);
  }
  if (jsonOf(base.viewports) !== jsonOf(head.viewports)) {
    out.push(`viewports ${valued(base.viewports)} -> ${valued(head.viewports)}`);
  }
  if (base.network.mode !== head.network.mode) {
    out.push(`network.mode ${valued(base.network.mode)} -> ${valued(head.network.mode)}`);
  }
  if (base.network.har !== head.network.har) {
    out.push(`network.har ${valued(base.network.har)} -> ${valued(head.network.har)}`);
  }
  return out;
}

/* ------------------------------------------------------------------ helpers */

function indexById(steps: readonly Step[]): Map<StepId, Located> {
  const out = new Map<StepId, Located>();
  steps.forEach((step, index) => {
    if (!out.has(step.id)) out.set(step.id, { step, index });
  });
  return out;
}

function runStatusBucket(
  baseResult: StepResult | undefined,
  headResult: StepResult | undefined,
): { status: FlowDiffStatus; detail?: string } | null {
  const sides = [
    ['base', baseResult],
    ['head', headResult],
  ] as const;

  for (const [side, result] of sides) {
    if (result?.status === 'failed') {
      const message = result.failure?.message;
      return {
        status: 'failed',
        detail: message === undefined ? `failed in ${side}` : `failed in ${side}: ${message}`,
      };
    }
  }
  for (const [side, result] of sides) {
    if (result?.status === 'blocked' || result?.status === 'skipped') {
      return { status: 'blocked', detail: `${result.status} in ${side}` };
    }
  }
  return null;
}

/**
 * Per-field `fill` drift, by field name only — never by value, because the values are exactly the
 * card numbers, passwords and coupon codes a flow types into a form. Fields are listed in a stable
 * sorted order, plus a `fill reordered` note when the shared fields kept their values but changed
 * their relative order, since fill order is the order the form is typed into.
 */
export function describeFillChanges(base: unknown, head: unknown): string[] {
  const b = (base ?? {}) as Record<string, string>;
  const h = (head ?? {}) as Record<string, string>;

  const out: string[] = [];
  for (const key of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort()) {
    if (b[key] === h[key]) continue;
    if (b[key] === undefined) out.push(`added fill ${quoted(key)}`);
    else if (h[key] === undefined) out.push(`removed fill ${quoted(key)}`);
    else out.push(`fill ${quoted(key)} changed`);
  }

  const shared = (keys: string[], other: Record<string, string>): string[] =>
    keys.filter((key) => other[key] !== undefined);
  // `\0` as the join separator, written as an escape rather than a literal byte: a field name can
  // contain any printable character, so a printable separator would let two different key orders
  // stringify to the same thing. (A literal NUL here makes the whole source file read as binary to
  // git and grep, which is how this line was found.)
  if (shared(Object.keys(b), h).join('\0') !== shared(Object.keys(h), b).join('\0')) {
    out.push('fill reordered');
  }
  return out;
}

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function quoted(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
}

/** Like `quoted`, but names an absent value instead of rendering it as the string "undefined". */
function valued(value: unknown): string {
  return value === undefined ? 'unset' : quoted(value);
}

/** Distinguishes an absent verb from any JSON value, which `JSON.stringify` alone does not. */
function jsonOf(value: unknown): string {
  return value === undefined ? ' unset' : JSON.stringify(value);
}
