import { describe, expect, it } from 'vitest';
import type { DomNode } from '../types.js';
import { attributeRegion, attributeSide, buildIndex } from './attribution.js';
import { domNode } from './testkit.js';

const body = domNode({ path: 'html>body', rect: { x: 0, y: 0, w: 400, h: 300 }, tag: 'body' });
const card = domNode({
  path: 'html>body>div',
  parent: 'html>body',
  rect: { x: 20, y: 20, w: 200, h: 120 },
});
const button = domNode({
  path: 'html>body>div>button',
  parent: 'html>body>div',
  tag: 'button',
  testId: 'pay',
  attrs: { 'data-test': 'pay' },
  rect: { x: 40, y: 60, w: 80, h: 30 },
});

const nodes: DomNode[] = [body, card, button];
const never = (): boolean => false;

describe('attributeSide', () => {
  it('picks the smallest node fully containing the region', () => {
    const index = buildIndex(nodes, 1, never);

    const hit = attributeSide({ x: 50, y: 70, w: 20, h: 10 }, index);

    expect(hit.node?.path).toBe(button.path);
    expect(hit.confidence).toBe('contained');
  });

  it('converts CSS rects to image space with the device scale factor', () => {
    const index = buildIndex(nodes, 2, never);

    // The button occupies 80..240 x 120..180 once doubled.
    expect(attributeSide({ x: 100, y: 130, w: 20, h: 10 }, index).node?.path).toBe(button.path);
    // Same coordinates unscaled would land inside the button; at 2x they land in the card only.
    expect(attributeSide({ x: 50, y: 70, w: 10, h: 10 }, index).node?.path).toBe(card.path);
  });

  it('prefers a containing node whose own rect changed', () => {
    const overlay = domNode({
      path: 'html>body>div>overlay',
      parent: 'html>body>div',
      rect: { x: 38, y: 58, w: 84, h: 34 },
    });
    const index = buildIndex([...nodes, overlay], 1, (n) => n.path === overlay.path);

    // The overlay is slightly larger than the button but within the tie-break budget.
    expect(attributeSide({ x: 50, y: 70, w: 20, h: 10 }, index).node?.path).toBe(overlay.path);
  });

  it('never lets a page-sized ancestor win the changed tie-break', () => {
    const index = buildIndex(nodes, 1, (n) => n.path === body.path);

    expect(attributeSide({ x: 50, y: 70, w: 20, h: 10 }, index).node?.path).toBe(button.path);
  });

  it('degrades to the largest overlapping node when nothing contains the region', () => {
    const index = buildIndex(nodes, 1, never);

    // A region straddling the card's edge is contained by body only, which does contain it.
    const straddle = attributeSide({ x: 10, y: 10, w: 60, h: 60 }, index);
    expect(straddle.node?.path).toBe(body.path);
    expect(straddle.confidence).toBe('contained');

    // With body absent there is no container left, so overlap wins.
    const overlapOnly = attributeSide({ x: 10, y: 10, w: 60, h: 60 }, buildIndex([card, button], 1, never));
    expect(overlapOnly.node?.path).toBe(card.path);
    expect(overlapOnly.confidence).toBe('overlap');
  });

  it('returns nothing when no node comes close', () => {
    const index = buildIndex([button], 1, never);
    expect(attributeSide({ x: 300, y: 250, w: 20, h: 20 }, index)).toEqual({
      node: null,
      confidence: 'none',
    });
  });

  it('skips invisible and zero-sized nodes', () => {
    const hidden = domNode({ path: 'html>body>hidden', rect: { x: 0, y: 0, w: 10, h: 10 }, visible: false });
    const empty = domNode({ path: 'html>body>empty', rect: { x: 0, y: 0, w: 0, h: 0 } });

    expect(buildIndex([hidden, empty], 1, never)).toHaveLength(0);
  });
});

describe('attributeRegion', () => {
  it('reports the head node when both sides hit, and the base node for removals', () => {
    const headIndex = buildIndex(nodes, 1, never);
    const baseIndex = buildIndex([body, card], 1, never);
    const region = { x: 50, y: 70, w: 20, h: 10 };

    const both = attributeRegion(region, headIndex, baseIndex);
    expect(both.side).toBe('head');
    expect(both.node?.path).toBe(button.path);
    expect(both.base.node?.path).toBe(card.path);

    const removal = attributeRegion(region, [], baseIndex);
    expect(removal.side).toBe('base');
    expect(removal.node?.path).toBe(card.path);
  });
});
