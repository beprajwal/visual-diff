/**
 * Config `ignore` is a findings contract, not a region filter (spec §8, noise control). These
 * tests pin the "no finding at all" promise on every path that can produce one: the region merge,
 * the pixel-free a11y pass, and the page-size finding — plus the warning that fires when an ignore
 * rule cannot be evaluated, because a rule that silently does nothing is worse than no rule.
 */

import { describe, expect, it } from 'vitest';
import type { DomNode, PixelImage, Rect, ViewportId } from '../types.js';
import { defaultDiffOptions } from './engine.js';
import { diffViewport, exclusionRects, ignoredNodes } from './viewportDiff.js';
import type { ShotSide, ViewportDiffOutput } from './viewportDiff.js';
import { domNode, paintRect, solidImage } from './testkit.js';

const VIEWPORT: ViewportId = '1280x800';
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const RED: [number, number, number, number] = [255, 0, 0, 255];

function side(image: PixelImage, nodes: DomNode[], masks: Rect[] = []): ShotSide {
  return {
    image,
    shot: {
      viewport: VIEWPORT,
      screenshotPath: `/fixture/${image.width}x${image.height}.png`,
      dom: {
        step: 'cart',
        viewport: VIEWPORT,
        url: 'http://localhost:5173/',
        capturedAt: '2026-08-08T10:00:00.000Z',
        deviceScaleFactor: 1,
        document: { w: image.width, h: image.height },
        nodeCount: nodes.length,
        truncated: false,
        masks,
        nodes,
      },
      a11y: null,
      size: { w: image.width, h: image.height },
    },
  };
}

function run(base: ShotSide, head: ShotSide, ignore: string[] = []): ViewportDiffOutput {
  return diffViewport({
    step: 'cart',
    viewport: VIEWPORT,
    base,
    head,
    options: defaultDiffOptions({ deviceScaleFactor: 1, minRegionArea: 4, ignore }),
  });
}

function body(height = 100): DomNode {
  return domNode({
    path: 'html>body',
    parent: null,
    tag: 'body',
    rect: { x: 0, y: 0, w: 100, h: height },
  });
}

/** The classic noisy element: a session badge whose accessible name churns on every run. */
function sessionBadge(label: string | undefined, rect: Rect = { x: 10, y: 10, w: 60, h: 20 }): DomNode {
  const node: DomNode = domNode({
    path: 'html>body>div',
    parent: 'html>body',
    tag: 'div',
    testId: 'session-id',
    role: 'status',
    rect,
    attrs: { 'data-test': 'session-id', ...(label === undefined ? {} : { 'aria-label': label }) },
  });
  if (label !== undefined) node.name = label;
  return node;
}

describe('ignoredNodes', () => {
  const nodes = [
    body(),
    sessionBadge('Session 4f21'),
    domNode({
      path: 'html>body>div>span',
      parent: 'html>body>div',
      tag: 'span',
      rect: { x: 12, y: 12, w: 40, h: 12 },
      text: 'Session 4f21',
    }),
    domNode({ path: 'html>body>p', parent: 'html>body', tag: 'p', rect: { x: 10, y: 60, w: 60, h: 20 } }),
  ];

  it('covers the matched node and its whole subtree', () => {
    const ignored = ignoredNodes(nodes, ['[data-test=session-id]']);
    expect([...ignored].map((n) => n.path).sort()).toEqual(['html>body>div', 'html>body>div>span']);
  });

  it('is empty without an ignore list', () => {
    expect(ignoredNodes(nodes, []).size).toBe(0);
  });

  it('does not depend on the order nodes are listed in', () => {
    const reversed = ignoredNodes([...nodes].reverse(), ['[data-test=session-id]']);
    expect([...reversed].map((n) => n.path).sort()).toEqual([
      'html>body>div',
      'html>body>div>span',
    ]);
  });

  it('survives a parent chain that points at itself', () => {
    const looped = domNode({
      path: 'html>body>div',
      parent: 'html>body>div',
      tag: 'div',
      rect: { x: 0, y: 0, w: 10, h: 10 },
    });
    expect(ignoredNodes([looped], ['.clock']).size).toBe(0);
  });

  it('feeds the ignored subtree into the exclusion rects', () => {
    const rects = exclusionRects(side(solidImage(100, 100, WHITE), nodes), ['[data-test=session-id]'], 1);
    expect(rects).toEqual([
      { x: 10, y: 10, w: 60, h: 20 },
      { x: 12, y: 12, w: 40, h: 12 },
    ]);
  });
});

describe('ignore and the a11y pass', () => {
  // Identical screenshots: the only path to a finding is the pixel-free a11y pass.
  const image = () => solidImage(100, 100, WHITE);
  const before = () => side(image(), [body(), sessionBadge('Session 4f21')]);
  const after = () => side(image(), [body(), sessionBadge(undefined)]);

  it('reports a lost accessible name when nothing is ignored', () => {
    const out = run(before(), after());
    expect(out.diff.regions).toEqual([]);
    expect(out.diff.findings).toHaveLength(1);
    expect(out.diff.findings[0]?.kind).toBe('a11y');
    expect(out.diff.findings[0]?.severity).toBe('high');
    expect(out.diff.findings[0]?.element?.selector).toBe('[data-test="session-id"]');
  });

  it('produces no finding at all for an ignored element whose label churns', () => {
    const out = run(before(), after(), ['[data-test=session-id]']);
    expect(out.diff.findings).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('produces no finding for a churning aria-label that also repaints its own box', () => {
    const clean = solidImage(100, 100, WHITE);
    const repainted = paintRect(solidImage(100, 100, WHITE), { x: 12, y: 12, w: 40, h: 12 }, RED);
    const base = side(clean, [body(), sessionBadge('Session 4f21')]);
    const head = side(repainted, [body(), sessionBadge('Session 9c05')]);

    const reported = run(base, head);
    const attrFinding = reported.diff.findings.find((f) => f.nodeChange === 'attr');
    expect(attrFinding?.kind).toBe('a11y');
    expect(attrFinding?.changes).toContainEqual({
      prop: 'aria-label',
      from: 'Session 4f21',
      to: 'Session 9c05',
    });

    const ignored = run(base, head, ['[data-test=session-id]']);
    expect(ignored.diff.regions).toEqual([]);
    expect(ignored.diff.findings).toEqual([]);
  });

  it('still reports the same regression on a sibling that is not ignored', () => {
    const sibling = (name: string | undefined): DomNode => {
      const node = domNode({
        path: 'html>body>button',
        parent: 'html>body',
        tag: 'button',
        testId: 'pay',
        role: 'button',
        rect: { x: 10, y: 60, w: 60, h: 20 },
        attrs: { 'data-test': 'pay' },
      });
      if (name !== undefined) node.name = name;
      return node;
    };
    const out = run(
      side(image(), [body(), sessionBadge('Session 4f21'), sibling('Pay now')]),
      side(image(), [body(), sessionBadge(undefined), sibling(undefined)]),
      ['[data-test=session-id]'],
    );
    expect(out.diff.findings).toHaveLength(1);
    expect(out.diff.findings[0]?.element?.selector).toBe('[data-test="pay"]');
  });
});

describe('ignore and regions', () => {
  it('suppresses pixel changes inside an ignored subtree, even where the child overflows', () => {
    // The span paints outside its ignored parent's box; ignoring the parent ignores the subtree.
    const span = (text: string): DomNode =>
      domNode({
        path: 'html>body>div>span',
        parent: 'html>body>div',
        tag: 'span',
        rect: { x: 10, y: 10, w: 60, h: 40 },
        text,
      });
    const base = side(solidImage(100, 100, WHITE), [body(), sessionBadge('Session 4f21'), span('4f21')]);
    const head = side(
      paintRect(solidImage(100, 100, WHITE), { x: 12, y: 34, w: 40, h: 12 }, RED),
      [body(), sessionBadge('Session 9c05'), span('9c05')],
    );

    const reported = run(base, head);
    expect(reported.diff.regions.length).toBeGreaterThan(0);
    expect(reported.diff.findings.length).toBeGreaterThan(0);

    const ignored = run(base, head, ['[data-test=session-id]']);
    expect(ignored.diff.pixelChangedRatio).toBeGreaterThan(0);
    expect(ignored.diff.regions).toEqual([]);
    expect(ignored.diff.findings).toEqual([]);
  });

  it('keeps reporting changes outside the ignored element', () => {
    const total = (text: string): DomNode =>
      domNode({
        path: 'html>body>p',
        parent: 'html>body',
        tag: 'p',
        rect: { x: 10, y: 60, w: 60, h: 20 },
        attrs: { id: 'total' },
        text,
      });
    const base = side(solidImage(100, 100, WHITE), [body(), sessionBadge('Session 4f21'), total('10')]);
    const head = side(
      paintRect(solidImage(100, 100, WHITE), { x: 12, y: 62, w: 40, h: 12 }, RED),
      [body(), sessionBadge('Session 9c05'), total('20')],
    );

    const out = run(base, head, ['[data-test=session-id]']);
    expect(out.diff.findings).toHaveLength(1);
    expect(out.diff.findings[0]?.element?.selector).toBe('#total');
    expect(out.diff.findings[0]?.changes).toEqual([{ prop: 'text', from: '10', to: '20' }]);
  });

  it('never attributes a surviving region to an ignored element', () => {
    // A truncated DOM keeps only the badge, so the escaping region has no containing node and
    // attribution would otherwise fall back to the very element the user asked to ignore.
    const base = side(solidImage(100, 100, WHITE), [sessionBadge('Session 4f21')]);
    const head = side(
      paintRect(solidImage(100, 100, WHITE), { x: 20, y: 24, w: 40, h: 20 }, RED),
      [sessionBadge('Session 9c05')],
    );

    const blamed = run(base, head);
    expect(blamed.diff.findings[0]?.element?.selector).toBe('[data-test="session-id"]');

    const out = run(base, head, ['[data-test=session-id]']);
    expect(out.diff.findings).toHaveLength(1);
    expect(out.diff.findings[0]?.element).toBeUndefined();
    expect(out.diff.findings[0]?.reasons).toEqual(['pixels-only']);
  });
});

describe('ignore and the page-size finding', () => {
  const banner = (height: number): DomNode =>
    domNode({
      path: 'html>body>div',
      parent: 'html>body',
      tag: 'div',
      testId: 'session-id',
      rect: { x: 0, y: 0, w: 100, h: height },
      attrs: { 'data-test': 'session-id' },
    });

  it('reports the growth when nothing is ignored', () => {
    const out = run(
      side(solidImage(100, 100, WHITE), [body(100), banner(20)]),
      side(solidImage(100, 140, WHITE), [body(140), banner(60)]),
    );
    const size = out.diff.findings.find((f) => f.reasons.includes('dimensions-changed'));
    expect(size?.changes).toEqual([{ prop: 'height', from: 100, to: 140 }]);
  });

  it('suppresses it when an ignored element alone explains the growth', () => {
    const out = run(
      side(solidImage(100, 100, WHITE), [body(100), banner(20)]),
      side(solidImage(100, 140, WHITE), [body(140), banner(60)]),
      ['[data-test=session-id]'],
    );
    // The fact is still recorded — only the finding, which is noise here, goes away.
    expect(out.diff.dimensionsChanged).toBe(true);
    expect(out.diff.findings).toEqual([]);
  });

  it('keeps it when the page grew by more than the ignored element', () => {
    const out = run(
      side(solidImage(100, 100, WHITE), [body(100), banner(20)]),
      side(solidImage(100, 200, WHITE), [body(200), banner(60)]),
      ['[data-test=session-id]'],
    );
    const size = out.diff.findings.find((f) => f.reasons.includes('dimensions-changed'));
    expect(size?.severity).toBe('high');
    expect(size?.changes).toEqual([{ prop: 'height', from: 100, to: 200 }]);
  });

  it('reports the unexplained axis and drops the explained one', () => {
    const wide = domNode({
      path: 'html>body>aside',
      parent: 'html>body',
      tag: 'aside',
      rect: { x: 0, y: 0, w: 40, h: 10 },
    });
    const out = run(
      side(solidImage(100, 100, WHITE), [body(100), banner(20), wide]),
      side(solidImage(160, 140, WHITE), [body(140), banner(60), wide]),
      ['[data-test=session-id]'],
    );
    const size = out.diff.findings.find((f) => f.reasons.includes('dimensions-changed'));
    expect(size?.changes).toEqual([{ prop: 'width', from: 100, to: 160 }]);
  });
});

describe('unsupported ignore selectors', () => {
  const nodes = [body()];

  it('warns rather than silently covering nothing', () => {
    const out = run(
      side(solidImage(100, 100, WHITE), nodes),
      side(solidImage(100, 100, WHITE), nodes),
      ['div > .clock', '[data-test=session-id]'],
    );
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('"div > .clock"');
    expect(out.warnings[0]).toContain('matches nothing');
  });

  it('warns even when one side is missing and no comparison happens', () => {
    const out = diffViewport({
      step: 'cart',
      viewport: VIEWPORT,
      base: null,
      head: side(solidImage(100, 100, WHITE), nodes),
      options: defaultDiffOptions({ deviceScaleFactor: 1, ignore: ['.a .b'] }),
    });
    expect(out.diff.missing).toBe('base');
    expect(out.warnings).toHaveLength(1);
  });
});
