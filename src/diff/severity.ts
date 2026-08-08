/**
 * Finding kind and severity heuristics (spec §8).
 *
 * Severity is heuristic, not learned. High: a lost accessible name, a new console error, a contrast
 * ratio dropping below 4.5, a layout shift past threshold. Low: a 1px radius change. Everything
 * else is `med`. **Severity only orders the list and colours badges — it never hides anything**, so
 * this module returns a verdict and never a filter.
 */

import type { DomNode, FindingKind, NodeChange, PropChange, Severity } from '../types.js';
import { compositeOver, contrastRatio, parseCssColor } from './color.js';
import type { Rgba } from './color.js';

/** WCAG AA normal-text minimum. */
export const CONTRAST_MIN = 4.5;
/** CSS pixels of movement or size change that make a layout finding high severity. */
export const LAYOUT_SHIFT_PX = 8;
/** A length change of at most this many CSS pixels is cosmetic (the "1px radius change" rule). */
export const SMALL_LENGTH_DELTA_PX = 1;

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const MAX_ANCESTOR_WALK = 32;

export interface Verdict {
  kind: FindingKind;
  severity: Severity;
  reasons: string[];
  label: string;
}

const A11Y_PROPS = new Set(['name', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-expanded', 'aria-disabled', 'alt']);

function isBlank(v: PropChange['to']): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** A lost accessible name: it had one, and now it does not. */
export function lostAccessibleName(changes: readonly PropChange[]): boolean {
  return changes.some((c) => c.prop === 'name' && !isBlank(c.from) && isBlank(c.to));
}

function parsePx(value: PropChange['from']): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return m === null ? null : Number.parseFloat(m[1] as string);
}

/** True when every change is a length that moved by at most 1px — the cosmetic-radius rule. */
export function isSubPixelStyleChange(changes: readonly PropChange[]): boolean {
  if (changes.length === 0) return false;
  return changes.every((c) => {
    const from = parsePx(c.from);
    const to = parsePx(c.to);
    if (from === null || to === null) return false;
    return Math.abs(to - from) <= SMALL_LENGTH_DELTA_PX;
  });
}

export function maxLengthDelta(changes: readonly PropChange[]): number {
  let max = 0;
  for (const c of changes) {
    const from = parsePx(c.from);
    const to = parsePx(c.to);
    if (from === null || to === null) continue;
    max = Math.max(max, Math.abs(to - from));
  }
  return max;
}

/** Effective background behind a node: its own background composited over its ancestors', then white. */
export function effectiveBackground(node: DomNode, byPath: ReadonlyMap<string, DomNode>): Rgba {
  let acc: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  let cur: DomNode | undefined = node;
  for (let i = 0; i < MAX_ANCESTOR_WALK && cur !== undefined; i += 1) {
    const c = parseCssColor(cur.styles?.backgroundColor);
    if (c !== null && c.a > 0) {
      acc = acc.a === 0 ? c : compositeOver(acc, c);
      if (acc.a >= 0.999) return acc;
    }
    cur = cur.parent === null ? undefined : byPath.get(cur.parent);
  }
  return acc.a === 0 ? WHITE : compositeOver(acc, WHITE);
}

/** Text contrast of a node against its effective background, or null when it cannot be computed. */
export function nodeContrast(node: DomNode, byPath: ReadonlyMap<string, DomNode>): number | null {
  const text = (node.text ?? '').trim();
  if (text === '') return null;
  const fg = parseCssColor(node.styles?.color);
  if (fg === null || fg.a === 0) return null;
  return contrastRatio(fg, effectiveBackground(node, byPath));
}

export interface ContrastContext {
  baseByPath: ReadonlyMap<string, DomNode>;
  headByPath: ReadonlyMap<string, DomNode>;
}

/** Fires only on a real regression: readable before, below 4.5 after. */
export function contrastRegression(
  change: NodeChange,
  ctx: ContrastContext | undefined,
): { base: number; head: number } | null {
  if (ctx === undefined || change.base === null || change.head === null) return null;
  if (!change.changes.some((c) => c.prop === 'color' || c.prop === 'backgroundColor')) return null;
  const base = nodeContrast(change.base, ctx.baseByPath);
  const head = nodeContrast(change.head, ctx.headByPath);
  if (base === null || head === null) return null;
  if (head >= CONTRAST_MIN || base < CONTRAST_MIN) return null;
  return { base, head };
}

function kindForAttrChange(changes: readonly PropChange[]): FindingKind {
  return changes.some((c) => A11Y_PROPS.has(c.prop)) ? 'a11y' : 'content';
}

const LABELS: Record<NodeChange['kind'], string> = {
  added: 'element added',
  removed: 'element removed',
  moved: 'element moved',
  resized: 'element resized',
  text: 'text changed',
  style: 'style changed',
  attr: 'attributes changed',
};

/**
 * Kind + severity for one node change. `ctx` enables the contrast heuristic; without it the rule
 * simply does not fire.
 */
export function classifyNodeChange(change: NodeChange, ctx?: ContrastContext): Verdict {
  const reasons: string[] = [];
  let severity: Severity = 'med';
  let kind: FindingKind;
  let label = LABELS[change.kind];

  switch (change.kind) {
    case 'added':
    case 'removed':
      kind = 'structural';
      break;
    case 'text':
      kind = 'content';
      break;
    case 'moved':
    case 'resized':
      kind = 'layout';
      break;
    case 'style':
      kind = 'style';
      break;
    case 'attr':
      kind = kindForAttrChange(change.changes);
      break;
  }

  if (lostAccessibleName(change.changes)) {
    kind = 'a11y';
    severity = 'high';
    label = 'accessible name lost';
    reasons.push('lost-accessible-name');
  }

  const contrast = contrastRegression(change, ctx);
  if (contrast !== null) {
    kind = 'a11y';
    severity = 'high';
    label = `contrast dropped to ${contrast.head.toFixed(2)}:1`;
    reasons.push('contrast-below-4.5');
  }

  if ((change.kind === 'moved' || change.kind === 'resized') && reasons.length === 0) {
    const delta = maxLengthDelta(change.changes);
    if (delta > LAYOUT_SHIFT_PX) {
      severity = 'high';
      reasons.push('layout-shift');
    } else if (delta <= SMALL_LENGTH_DELTA_PX) {
      severity = 'low';
      reasons.push('sub-pixel-change');
    }
  }

  if (change.kind === 'style' && reasons.length === 0 && isSubPixelStyleChange(change.changes)) {
    severity = 'low';
    reasons.push('small-length-change');
  }

  return { kind, severity, reasons, label };
}
