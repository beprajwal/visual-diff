import { describe, expect, it } from 'vitest';

import type { Page } from 'playwright-core';

import { CAPTURED_ATTRS, DEFAULTS, STYLE_PROPS, type A11yNode, type DomNode } from '../types.js';
import {
  A11Y_ROOT_ROLE,
  captureA11ySnapshot,
  type AriaSnapshotSource,
  collectArgs,
  emptyStyles,
  parseAriaHeader,
  parseAriaSnapshot,
  toA11ySnapshot,
  toDomSnapshot,
} from './capture.js';
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

/* ------------------------------------------------------------------ a11y.json (spec §7) */

/**
 * Fixtures are verbatim `locator.ariaSnapshot()` output from Chromium via Playwright — the point
 * of the fix is that `a11y.json` is the browser's accessibility tree, so the tests are pinned to
 * what the browser actually emits rather than to a shape invented here.
 */
const ARIA_YAML = `- main "Shop":
  - heading "Cart" [level=2]
  - list "Links":
    - listitem:
      - link "Home":
        - /url: /
    - listitem:
      - link "About":
        - /url: /about
  - paragraph: Some plain text
  - textbox "Card number": "4242"
  - checkbox "Save card" [checked]
  - button "Pay now" [disabled]
  - img "Logo"
`;

describe('parseAriaHeader', () => {
  it('reads a bare role', () => {
    expect(parseAriaHeader('progressbar')).toEqual({ role: 'progressbar' });
  });

  it('reads role and accessible name', () => {
    expect(parseAriaHeader('link "Home"')).toEqual({ role: 'link', name: 'Home' });
  });

  it('promotes heading level to its own field', () => {
    expect(parseAriaHeader('heading "Cart" [level=2]')).toEqual({
      role: 'heading',
      name: 'Cart',
      level: 2,
    });
  });

  it('keeps every other state annotation verbatim', () => {
    expect(parseAriaHeader('checkbox "Save card" [checked]')).toEqual({
      role: 'checkbox',
      name: 'Save card',
      states: 'checked',
    });
    expect(parseAriaHeader('option "2" [selected] [disabled]').states).toBe('selected disabled');
  });

  it('unescapes a quoted name that contains quotes', () => {
    expect(parseAriaHeader('button "Say \\"hi\\""')).toEqual({ role: 'button', name: 'Say "hi"' });
  });
});

describe('parseAriaSnapshot', () => {
  const snapshot = parseAriaSnapshot(ARIA_YAML, 'cart', '1280x800', 'Checkout');

  it('hangs the browser tree under a single stable root', () => {
    expect(snapshot).toMatchObject({ step: 'cart', viewport: '1280x800' });
    expect(snapshot.root?.role).toBe(A11Y_ROOT_ROLE);
    expect(snapshot.root?.name).toBe('Checkout');
    expect(snapshot.root?.children?.map((child) => child.role)).toEqual(['main']);
  });

  it('keeps the accessibility tree structure, not the DOM structure', () => {
    const main = snapshot.root?.children?.[0];
    expect(main).toMatchObject({ role: 'main', name: 'Shop' });
    expect(main?.children?.map((child) => child.role)).toEqual([
      'heading',
      'list',
      'paragraph',
      'textbox',
      'checkbox',
      'button',
      'img',
    ]);
  });

  it('carries heading level, control value and state annotations', () => {
    const main = snapshot.root?.children?.[0];
    const byRole = (role: string): A11yNode | undefined =>
      main?.children?.find((child) => child.role === role);
    expect(byRole('heading')).toMatchObject({ name: 'Cart', level: 2 });
    expect(byRole('textbox')).toMatchObject({ name: 'Card number', value: '4242' });
    expect(byRole('paragraph')).toMatchObject({ value: 'Some plain text' });
    expect(byRole('checkbox')).toMatchObject({ name: 'Save card', description: 'checked' });
    expect(byRole('button')).toMatchObject({ name: 'Pay now', description: 'disabled' });
    expect(byRole('img')).toEqual({ role: 'img', name: 'Logo' });
  });

  it('folds node properties like /url into the node instead of faking a child', () => {
    const main = snapshot.root?.children?.[0];
    const list = main?.children?.find((child) => child.role === 'list');
    const firstItem = list?.children?.[0];
    expect(firstItem?.role).toBe('listitem');
    expect(firstItem?.children).toEqual([{ role: 'link', name: 'Home', description: '/url=/' }]);
  });

  it('keeps generic static text as a text node', () => {
    const parsed = parseAriaSnapshot('- text: Bare text here\n- progressbar\n', 'cart', '1280x800');
    expect(parsed.root?.children).toEqual([
      { role: 'text', name: 'Bare text here' },
      { role: 'progressbar' },
    ]);
  });

  it('is an explicit empty tree for an empty page — never an invented one', () => {
    expect(parseAriaSnapshot('', 'cart', '1280x800')).toEqual({
      step: 'cart',
      viewport: '1280x800',
      root: null,
    });
  });

  it('refuses to guess at a snapshot it could not parse', () => {
    expect(parseAriaSnapshot('- [unbalanced\n  "', 'cart', '1280x800').root).toBeNull();
  });
});

/**
 * Compile-time contract: a real Playwright `Page` is an `AriaSnapshotSource`. Without this the
 * structural type could drift away from Playwright's and only fail at the one call site that
 * matters.
 */
const pageIsAriaSource: (page: Page) => AriaSnapshotSource = (page) => page;

describe('captureA11ySnapshot', () => {
  it('accepts a real Playwright page', () => {
    expect(typeof pageIsAriaSource).toBe('function');
  });

  it('takes the browser accessibility snapshot rather than rebuilding one from the DOM', async () => {
    const calls: string[] = [];
    const page = {
      locator: (selector: string) => {
        calls.push(selector);
        return { ariaSnapshot: async () => ARIA_YAML };
      },
      title: async () => 'Checkout',
    };
    const snapshot = await captureA11ySnapshot(page, 'cart', '1280x800');
    expect(calls).toEqual(['body']);
    expect(snapshot.root?.role).toBe(A11Y_ROOT_ROLE);
    expect(snapshot.root?.children?.[0]?.name).toBe('Shop');
  });

  it('returns an empty tree when the page is gone, with no DOM-derived substitute', async () => {
    const page = {
      locator: () => ({
        ariaSnapshot: async (): Promise<string> => {
          throw new Error('Target page, context or browser has been closed');
        },
      }),
      title: async () => '',
    };
    await expect(captureA11ySnapshot(page, 'cart', '1280x800')).resolves.toEqual({
      step: 'cart',
      viewport: '1280x800',
      root: null,
    });
  });
});
