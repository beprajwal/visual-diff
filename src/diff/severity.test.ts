import { describe, expect, it } from 'vitest';
import type { DomNode, NodeChange } from '../types.js';
import { contrastRatio, parseCssColor } from './color.js';
import { matchNodes } from './nodeMatch.js';
import { diffNodePair } from './nodeDiff.js';
import {
  classifyNodeChange,
  CONTRAST_MIN,
  effectiveBackground,
  isSubPixelStyleChange,
  lostAccessibleName,
  nodeContrast,
} from './severity.js';
import { domNode } from './testkit.js';

const rect = { x: 0, y: 0, w: 100, h: 20 };

function pairOf(base: DomNode, head: DomNode): NodeChange[] {
  const { pairs } = matchNodes([base], [head]);
  return diffNodePair(pairs[0]!);
}

function byPath(nodes: DomNode[]): Map<string, DomNode> {
  return new Map(nodes.map((n) => [n.path, n]));
}

describe('colour parsing and contrast', () => {
  it('parses the forms computed styles emit', () => {
    expect(parseCssColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseCssColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseCssColor('#0a0b0c')).toEqual({ r: 10, g: 11, b: 12, a: 1 });
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor('nonsense')).toBeNull();
    expect(parseCssColor('')).toBeNull();
  });

  it('computes WCAG contrast', () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const black = { r: 0, g: 0, b: 0, a: 1 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    // #767676 on white is the canonical "just passes AA" pair.
    expect(contrastRatio(parseCssColor('#767676')!, white)).toBeGreaterThanOrEqual(CONTRAST_MIN);
    expect(contrastRatio(parseCssColor('#999999')!, white)).toBeLessThan(CONTRAST_MIN);
  });

  it('walks ancestors for the effective background', () => {
    const page = domNode({ path: 'html>body', rect, styles: { backgroundColor: 'rgb(0, 0, 0)' } });
    const child = domNode({
      path: 'html>body>p',
      parent: 'html>body',
      rect,
      text: 'hi',
      styles: { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(255, 255, 255)' },
    });

    expect(effectiveBackground(child, byPath([page, child]))).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(nodeContrast(child, byPath([page, child]))).toBeCloseTo(21, 5);
  });

  it('defaults to white when nothing paints a background', () => {
    const node = domNode({ path: 'p', rect, text: 'hi', styles: { color: 'rgb(0, 0, 0)' } });
    expect(nodeContrast(node, byPath([node]))).toBeCloseTo(21, 5);
  });
});

describe('classifyNodeChange', () => {
  it('makes a lost accessible name high severity a11y', () => {
    const changes = pairOf(
      domNode({ path: 'button', rect, role: 'button', name: 'Pay now', attrs: { 'aria-label': 'Pay now' } }),
      domNode({ path: 'button', rect, role: 'button', attrs: {} }),
    );
    const attr = changes.find((c) => c.kind === 'attr')!;

    expect(lostAccessibleName(attr.changes)).toBe(true);
    expect(classifyNodeChange(attr)).toMatchObject({
      kind: 'a11y',
      severity: 'high',
      reasons: ['lost-accessible-name'],
    });
  });

  it('makes a contrast drop below 4.5 high severity', () => {
    const base = domNode({ path: 'p', rect, text: 'Total', styles: { color: '#767676' } });
    const head = domNode({ path: 'p', rect, text: 'Total', styles: { color: '#999999' } });
    const changes = pairOf(base, head);
    const style = changes.find((c) => c.kind === 'style')!;

    const verdict = classifyNodeChange(style, {
      baseByPath: byPath([base]),
      headByPath: byPath([head]),
    });

    expect(verdict.kind).toBe('a11y');
    expect(verdict.severity).toBe('high');
    expect(verdict.reasons).toContain('contrast-below-4.5');
  });

  it('does not fire the contrast rule when the text was already failing', () => {
    const base = domNode({ path: 'p', rect, text: 'Total', styles: { color: '#aaaaaa' } });
    const head = domNode({ path: 'p', rect, text: 'Total', styles: { color: '#999999' } });
    const style = pairOf(base, head).find((c) => c.kind === 'style')!;

    const verdict = classifyNodeChange(style, {
      baseByPath: byPath([base]),
      headByPath: byPath([head]),
    });

    expect(verdict.severity).toBe('med');
    expect(verdict.kind).toBe('style');
  });

  it('makes a layout shift past the threshold high severity', () => {
    const moved = pairOf(
      domNode({ path: 'p', rect: { x: 0, y: 0, w: 100, h: 20 } }),
      domNode({ path: 'p', rect: { x: 0, y: 40, w: 100, h: 20 } }),
    ).find((c) => c.kind === 'moved')!;

    expect(classifyNodeChange(moved)).toMatchObject({
      kind: 'layout',
      severity: 'high',
      reasons: ['layout-shift'],
    });
  });

  it('keeps a 1px nudge low', () => {
    const moved = pairOf(
      domNode({ path: 'p', rect: { x: 0, y: 0, w: 100, h: 20 } }),
      domNode({ path: 'p', rect: { x: 0, y: 1, w: 100, h: 20 } }),
    ).find((c) => c.kind === 'moved')!;

    expect(classifyNodeChange(moved).severity).toBe('low');
  });

  it('keeps a 1px radius change low', () => {
    const style = pairOf(
      domNode({ path: 'p', rect, styles: { borderRadius: '4px' } }),
      domNode({ path: 'p', rect, styles: { borderRadius: '5px' } }),
    ).find((c) => c.kind === 'style')!;

    expect(isSubPixelStyleChange(style.changes)).toBe(true);
    expect(classifyNodeChange(style)).toMatchObject({ kind: 'style', severity: 'low' });
  });

  it('leaves a colour change at medium severity', () => {
    const style = pairOf(
      domNode({ path: 'p', rect, styles: { backgroundColor: 'rgb(204, 0, 0)' } }),
      domNode({ path: 'p', rect, styles: { backgroundColor: 'rgb(0, 0, 204)' } }),
    ).find((c) => c.kind === 'style')!;

    expect(classifyNodeChange(style)).toMatchObject({ kind: 'style', severity: 'med' });
  });

  it('classifies text as content and added/removed as structural', () => {
    const text = pairOf(
      domNode({ path: 'p', rect, text: 'a' }),
      domNode({ path: 'p', rect, text: 'b' }),
    )[0]!;
    expect(classifyNodeChange(text)).toMatchObject({ kind: 'content', severity: 'med' });

    const { pairs } = matchNodes([domNode({ path: 'old', rect })], [domNode({ path: 'new', rect })]);
    const added = diffNodePair(pairs.find((p) => p.base === null)!)[0]!;
    expect(classifyNodeChange(added).kind).toBe('structural');
  });
});
