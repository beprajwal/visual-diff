/**
 * Stage 5b — node classification (spec §8).
 *
 * A matched pair can carry several independent changes at once (a button can move *and* restyle),
 * and `NodeChange.kind` is singular, so one pair yields one `NodeChange` per kind, in a fixed
 * order: added/removed, text, moved, resized, style, attr.
 */

import { CAPTURED_ATTRS, STYLE_PROPS } from '../types.js';
import type { CapturedAttr, DomNode, NodeChange, PropChange, StyleProp } from '../types.js';
import type { NodePair } from './nodeMatch.js';

/** Sub-pixel rect jitter is not a move. */
export const RECT_EPSILON = 0.5;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function text(node: DomNode): string {
  return (node.text ?? '').trim();
}

function styleValue(node: DomNode, prop: StyleProp): string {
  const styles = node.styles as Partial<Record<StyleProp, string>> | undefined;
  return styles?.[prop] ?? '';
}

function attrValue(node: DomNode, attr: CapturedAttr): string | undefined {
  return node.attrs[attr];
}

export function styleChanges(base: DomNode, head: DomNode): PropChange[] {
  const out: PropChange[] = [];
  for (const prop of STYLE_PROPS) {
    const from = styleValue(base, prop);
    const to = styleValue(head, prop);
    if (from === to) continue;
    out.push({ prop, from, to });
  }
  return out;
}

export function attrChanges(base: DomNode, head: DomNode): PropChange[] {
  const out: PropChange[] = [];
  if ((base.role ?? '') !== (head.role ?? '')) {
    out.push({ prop: 'role', from: base.role ?? null, to: head.role ?? null });
  }
  if ((base.name ?? '') !== (head.name ?? '')) {
    out.push({ prop: 'name', from: base.name ?? null, to: head.name ?? null });
  }
  if (base.tag !== head.tag) out.push({ prop: 'tag', from: base.tag, to: head.tag });
  if (base.visible !== head.visible) {
    out.push({ prop: 'visible', from: base.visible, to: head.visible });
  }
  for (const attr of CAPTURED_ATTRS) {
    // `role` is already reported as its own property above; reporting both duplicates the change.
    if (attr === 'role') continue;
    const from = attrValue(base, attr);
    const to = attrValue(head, attr);
    if (from === to) continue;
    out.push({ prop: attr, from: from ?? null, to: to ?? null });
  }
  return out;
}

export function diffNodePair(pair: NodePair): NodeChange[] {
  const { base, head, key, keyKind } = pair;
  const changes: NodeChange[] = [];
  const make = (kind: NodeChange['kind'], props: PropChange[]): NodeChange => ({
    kind,
    key,
    keyKind,
    base,
    head,
    changes: props,
  });

  if (base === null && head === null) return changes;

  if (base === null && head !== null) {
    const props: PropChange[] = [];
    const t = text(head);
    if (t !== '') props.push({ prop: 'text', from: null, to: t });
    if (head.name !== undefined && head.name !== '') {
      props.push({ prop: 'name', from: null, to: head.name });
    }
    return [make('added', props)];
  }

  if (head === null && base !== null) {
    const props: PropChange[] = [];
    const t = text(base);
    if (t !== '') props.push({ prop: 'text', from: t, to: null });
    if (base.name !== undefined && base.name !== '') {
      props.push({ prop: 'name', from: base.name, to: null });
    }
    return [make('removed', props)];
  }

  const b = base as DomNode;
  const h = head as DomNode;

  const bText = text(b);
  const hText = text(h);
  if (bText !== hText) changes.push(make('text', [{ prop: 'text', from: bText, to: hText }]));

  const moved: PropChange[] = [];
  if (Math.abs(b.rect.x - h.rect.x) > RECT_EPSILON) {
    moved.push({ prop: 'x', from: round(b.rect.x), to: round(h.rect.x) });
  }
  if (Math.abs(b.rect.y - h.rect.y) > RECT_EPSILON) {
    moved.push({ prop: 'y', from: round(b.rect.y), to: round(h.rect.y) });
  }
  if (moved.length > 0) changes.push(make('moved', moved));

  const resized: PropChange[] = [];
  if (Math.abs(b.rect.w - h.rect.w) > RECT_EPSILON) {
    resized.push({ prop: 'width', from: round(b.rect.w), to: round(h.rect.w) });
  }
  if (Math.abs(b.rect.h - h.rect.h) > RECT_EPSILON) {
    resized.push({ prop: 'height', from: round(b.rect.h), to: round(h.rect.h) });
  }
  if (resized.length > 0) changes.push(make('resized', resized));

  const styles = styleChanges(b, h);
  if (styles.length > 0) changes.push(make('style', styles));

  const attrs = attrChanges(b, h);
  if (attrs.length > 0) changes.push(make('attr', attrs));

  return changes;
}

export function diffNodePairs(pairs: readonly NodePair[]): NodeChange[] {
  return pairs.flatMap((p) => diffNodePair(p));
}

/** True when a pair's own rect moved or resized — the DOM-attribution preference (spec §8). */
export function rectChanged(pair: NodePair): boolean {
  if (pair.base === null || pair.head === null) return true;
  return (
    Math.abs(pair.base.rect.x - pair.head.rect.x) > RECT_EPSILON ||
    Math.abs(pair.base.rect.y - pair.head.rect.y) > RECT_EPSILON ||
    Math.abs(pair.base.rect.w - pair.head.rect.w) > RECT_EPSILON ||
    Math.abs(pair.base.rect.h - pair.head.rect.h) > RECT_EPSILON
  );
}
