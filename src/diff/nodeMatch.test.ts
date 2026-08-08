import { describe, expect, it } from 'vitest';
import type { DomNode } from '../types.js';
import { matchNodes } from './nodeMatch.js';
import { diffNodePair, rectChanged } from './nodeDiff.js';
import { domNode } from './testkit.js';

const rect = { x: 0, y: 0, w: 100, h: 20 };

function button(overrides: Partial<DomNode>): DomNode {
  return domNode({ path: 'html>body>button', rect, tag: 'button', ...overrides });
}

describe('matchNodes', () => {
  it('pairs by test-id even when the DOM path moved', () => {
    const base = [button({ path: 'html>body>div>button', testId: 'pay', attrs: { 'data-test': 'pay' } })];
    const head = [
      button({ path: 'html>body>section>form>button', testId: 'pay', attrs: { 'data-test': 'pay' } }),
    ];

    const { pairs } = matchNodes(base, head);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.keyKind).toBe('test-id');
    expect(pairs[0]?.key).toBe('pay');
    expect(pairs[0]?.base).not.toBeNull();
    expect(pairs[0]?.head).not.toBeNull();
  });

  it('falls back to role plus accessible name', () => {
    const base = [button({ path: 'a>button', role: 'button', name: 'Pay now' })];
    const head = [button({ path: 'b>c>button', role: 'button', name: 'Pay now' })];

    const { pairs } = matchNodes(base, head);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.keyKind).toBe('role-name');
  });

  it('falls back to DOM path last', () => {
    const base = [domNode({ path: 'html>body>p', rect, text: 'before' })];
    const head = [domNode({ path: 'html>body>p', rect, text: 'after' })];

    const { pairs } = matchNodes(base, head);

    expect(pairs[0]?.keyKind).toBe('path');
    expect(pairs[0]?.key).toBe('html>body>p');
  });

  it('refuses to pair an ambiguous key and uses the path instead', () => {
    const dup = (path: string): DomNode =>
      domNode({ path, rect, testId: 'row', attrs: { 'data-test': 'row' } });
    const base = [dup('html>body>li:nth-of-type(1)'), dup('html>body>li:nth-of-type(2)')];
    const head = [dup('html>body>li:nth-of-type(1)'), dup('html>body>li:nth-of-type(2)')];

    const { pairs } = matchNodes(base, head);

    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.keyKind === 'path')).toBe(true);
  });

  it('reports unmatched nodes as one-sided pairs', () => {
    const base = [domNode({ path: 'html>body>old', rect })];
    const head = [domNode({ path: 'html>body>new', rect })];

    const { pairs } = matchNodes(base, head);

    expect(pairs).toHaveLength(2);
    expect(pairs.find((p) => p.base === null)?.head?.path).toBe('html>body>new');
    expect(pairs.find((p) => p.head === null)?.base?.path).toBe('html>body>old');
  });
});

describe('diffNodePair', () => {
  it('classifies a text change', () => {
    const [pair] = matchNodes(
      [domNode({ path: 'p', rect, text: 'Pay' })],
      [domNode({ path: 'p', rect, text: 'Pay now' })],
    ).pairs;

    const changes = diffNodePair(pair!);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('text');
    expect(changes[0]?.changes).toEqual([{ prop: 'text', from: 'Pay', to: 'Pay now' }]);
  });

  it('separates moved from resized', () => {
    const [pair] = matchNodes(
      [domNode({ path: 'p', rect: { x: 10, y: 10, w: 50, h: 20 } })],
      [domNode({ path: 'p', rect: { x: 10, y: 40, w: 80, h: 20 } })],
    ).pairs;

    const kinds = diffNodePair(pair!).map((c) => c.kind);

    expect(kinds).toEqual(['moved', 'resized']);
    const moved = diffNodePair(pair!).find((c) => c.kind === 'moved');
    expect(moved?.changes).toEqual([{ prop: 'y', from: 10, to: 40 }]);
  });

  it('ignores sub-pixel rect jitter', () => {
    const [pair] = matchNodes(
      [domNode({ path: 'p', rect: { x: 10, y: 10, w: 50, h: 20 } })],
      [domNode({ path: 'p', rect: { x: 10.2, y: 10.1, w: 50, h: 20 } })],
    ).pairs;

    expect(diffNodePair(pair!)).toEqual([]);
    expect(rectChanged(pair!)).toBe(false);
  });

  it('emits one style change carrying every changed property', () => {
    const [pair] = matchNodes(
      [domNode({ path: 'p', rect, styles: { color: 'rgb(0, 0, 0)', fontSize: '14px' } })],
      [domNode({ path: 'p', rect, styles: { color: 'rgb(20, 20, 20)', fontSize: '16px' } })],
    ).pairs;

    const changes = diffNodePair(pair!);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('style');
    expect(changes[0]?.changes).toEqual([
      { prop: 'color', from: 'rgb(0, 0, 0)', to: 'rgb(20, 20, 20)' },
      { prop: 'fontSize', from: '14px', to: '16px' },
    ]);
  });

  it('reports attribute, role and name changes together', () => {
    const [pair] = matchNodes(
      [domNode({ path: 'a', rect, role: 'link', name: 'Home', attrs: { href: '/' } })],
      [domNode({ path: 'a', rect, role: 'link', name: 'Home page', attrs: { href: '/home' } })],
    ).pairs;

    const changes = diffNodePair(pair!);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('attr');
    expect(changes[0]?.changes).toEqual([
      { prop: 'name', from: 'Home', to: 'Home page' },
      { prop: 'href', from: '/', to: '/home' },
    ]);
  });

  it('describes added and removed nodes', () => {
    const { pairs } = matchNodes(
      [domNode({ path: 'old', rect, text: 'gone' })],
      [domNode({ path: 'new', rect, text: 'fresh' })],
    );

    const added = diffNodePair(pairs.find((p) => p.base === null)!);
    const removed = diffNodePair(pairs.find((p) => p.head === null)!);

    expect(added[0]?.kind).toBe('added');
    expect(added[0]?.changes).toEqual([{ prop: 'text', from: null, to: 'fresh' }]);
    expect(removed[0]?.kind).toBe('removed');
    expect(removed[0]?.changes).toEqual([{ prop: 'text', from: 'gone', to: null }]);
  });
});
