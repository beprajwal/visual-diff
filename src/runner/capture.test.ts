import { describe, expect, it } from 'vitest';

import { CAPTURED_ATTRS, DEFAULTS, STYLE_PROPS, type DomNode } from '../types.js';
import { collectArgs, emptyStyles, toA11ySnapshot, toDomSnapshot } from './capture.js';
import type { CollectResult } from './capture.js';

function node(overrides: Partial<DomNode> & { path: string }): DomNode {
  return {
    parent: null,
    depth: 0,
    tag: 'div',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    visible: true,
    styles: emptyStyles(),
    attrs: {},
    ...overrides,
  };
}

describe('collectArgs', () => {
  it('carries the closed style and attribute lists from types.ts', () => {
    const args = collectArgs(['[data-test=order-date]']);
    expect(args.styleProps).toEqual([...STYLE_PROPS]);
    expect(args.attrs).toEqual([...CAPTURED_ATTRS]);
    expect(args.masks).toEqual(['[data-test=order-date]']);
    expect(args.maxNodes).toBe(DEFAULTS.maxDomNodes);
  });

  it('accepts a lower cap for tests and degraded capture', () => {
    expect(collectArgs([], 10).maxNodes).toBe(10);
  });
});

describe('toDomSnapshot', () => {
  const raw: CollectResult = {
    url: 'http://localhost:5173/cart',
    document: { w: 1280, h: 2400 },
    deviceScaleFactor: 2,
    nodeCount: 312,
    truncated: false,
    masks: [{ x: 1, y: 2, w: 3, h: 4 }],
    nodes: [node({ path: 'html' })],
  };

  it('assembles the on-disk shape', () => {
    const snapshot = toDomSnapshot(raw, {
      step: 'cart',
      viewport: '1280x800',
      masks: [],
      deviceScaleFactor: 2,
      capturedAt: '2026-08-08T10:00:00Z',
    });
    expect(snapshot).toMatchObject({
      step: 'cart',
      viewport: '1280x800',
      url: 'http://localhost:5173/cart',
      capturedAt: '2026-08-08T10:00:00Z',
      deviceScaleFactor: 2,
      document: { w: 1280, h: 2400 },
      nodeCount: 312,
      truncated: false,
      masks: [{ x: 1, y: 2, w: 3, h: 4 }],
    });
  });

  it('falls back to the configured scale when the page reports a useless one', () => {
    const snapshot = toDomSnapshot(
      { ...raw, deviceScaleFactor: 0 },
      {
        step: 'cart',
        viewport: '1280x800',
        masks: [],
        deviceScaleFactor: 2,
        capturedAt: '2026-08-08T10:00:00Z',
      },
    );
    expect(snapshot.deviceScaleFactor).toBe(2);
  });
});

describe('toA11ySnapshot', () => {
  it('nests roles by DOM ancestry, skipping nodes that carry no role', () => {
    const snapshot = toA11ySnapshot(
      [
        node({ path: 'html', role: 'document', parent: null }),
        node({ path: 'html>body', parent: 'html' }),
        node({ path: 'html>body>nav', parent: 'html>body', role: 'navigation' }),
        node({
          path: 'html>body>nav>a',
          parent: 'html>body>nav',
          tag: 'a',
          role: 'link',
          name: 'Cart',
        }),
        node({ path: 'html>body>h1', parent: 'html>body', tag: 'h2', role: 'heading', name: 'Pay' }),
      ],
      'cart',
      '1280x800',
    );

    expect(snapshot.step).toBe('cart');
    expect(snapshot.root?.role).toBe('document');
    const children = snapshot.root?.children ?? [];
    expect(children.map((child) => child.role)).toEqual(['navigation', 'heading']);
    expect(children[0]?.children?.[0]).toEqual({ role: 'link', name: 'Cart' });
    expect(children[1]?.level).toBe(2);
  });

  it('is a null tree when nothing was captured', () => {
    expect(toA11ySnapshot([], 'cart', '1280x800')).toEqual({
      step: 'cart',
      viewport: '1280x800',
      root: null,
    });
  });
});
