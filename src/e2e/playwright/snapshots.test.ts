import { describe, expect, it } from 'vitest';

import { flattenSnapshot, SnapshotIndex } from './snapshots.js';
import type { FrameSnapshotPayload } from './events.js';

function payload(
  name: string,
  html: unknown,
  overrides: Partial<FrameSnapshotPayload> = {},
): FrameSnapshotPayload {
  return {
    snapshotName: name,
    pageId: 'page@1',
    frameId: 'frame@1',
    frameUrl: 'http://localhost/',
    html,
    viewport: { width: 900, height: 600 },
    timestamp: 100,
    wallTime: 1_700_000_000_000,
    isMainFrame: true,
    ...overrides,
  };
}

/** The document every delta test builds on, matching the layout a real probe page produces. */
const FIRST_HTML = [
  'HTML',
  {},
  ['HEAD', {}, ['TITLE', {}, 'Probe']],
  ['BODY', {}, ['H1', { id: 'title' }, 'Trace Probe'], ['DIV', { class: 'card' }, 'idle']],
];

describe('SnapshotIndex', () => {
  it('resolves a self-contained snapshot', () => {
    const index = new SnapshotIndex();
    index.add(payload('before@call@10', FIRST_HTML));
    const resolved = index.resolve('page@1', 'before@call@10');
    expect(resolved?.root?.tag).toBe('HTML');
    expect(resolved?.root?.children).toHaveLength(2);
  });

  it('resolves a whole-document back-reference, which is what an unchanged page records', () => {
    // `[[1, N]]` means "the node N of the previous snapshot". Read in isolation this is an empty
    // document, and a reader that does not resolve it reports the page as blank.
    const index = new SnapshotIndex();
    index.add(payload('before@call@10', FIRST_HTML));
    // Post-order numbering: 'Probe'(0) TITLE(1) HEAD(2) 'Trace Probe'(3) H1(4) 'idle'(5) DIV(6)
    // BODY(7) HTML(8) — the document root is last, not first.
    index.add(payload('after@call@10', [[1, 8]]));
    const resolved = index.resolve('page@1', 'after@call@10');
    const nodes = flattenSnapshot(resolved?.root ?? null);
    expect(nodes.map((node) => node.path)).toEqual(['html', 'html>body', 'html>body>h1', 'html>body>div']);
    expect(nodes[2]?.text).toBe('Trace Probe');
  });

  it('numbers nodes post-order with text nodes counted, as the renderer does', () => {
    const index = new SnapshotIndex();
    index.add(payload('a', FIRST_HTML));
    // Node 4 is the H1 element: 'Probe'(0), TITLE(1), HEAD(2), 'Trace Probe'(3), H1(4).
    index.add(payload('b', ['DIV', {}, [[1, 4]]]));
    const resolved = index.resolve('page@1', 'b');
    const child = resolved?.root?.children[0];
    expect(typeof child === 'object' && child !== null ? child.tag : undefined).toBe('H1');
  });

  it('resolves a reference that reaches back more than one snapshot', () => {
    const index = new SnapshotIndex();
    index.add(payload('a', FIRST_HTML));
    index.add(payload('b', ['DIV', {}, 'changed']));
    index.add(payload('c', ['SECTION', {}, [[2, 4]]]));
    const resolved = index.resolve('page@1', 'c');
    const child = resolved?.root?.children[0];
    expect(typeof child === 'object' && child !== null ? child.attrs['id'] : undefined).toBe('title');
  });

  it('mixes resolved subtrees with newly recorded ones', () => {
    const index = new SnapshotIndex();
    index.add(payload('a', FIRST_HTML));
    index.add(
      payload('b', [
        'HTML',
        {},
        [[1, 2]],
        ['BODY', {}, ['H1', { id: 'title' }, 'Trace Probe'], ['DIV', { class: 'card' }, 'ready']],
      ]),
    );
    const nodes = flattenSnapshot(index.resolve('page@1', 'b')?.root ?? null);
    expect(nodes.find((node) => node.tag === 'div')?.text).toBe('ready');
  });

  it('keeps each frame on its own numbering', () => {
    // Back-references are relative to the frame's snapshot list, so grouping by page would resolve
    // an iframe's reference against the main frame's nodes.
    const index = new SnapshotIndex();
    index.add(payload('a', FIRST_HTML));
    index.add(payload('a', ['SPAN', {}, 'inner'], { frameId: 'frame@2', isMainFrame: false }));
    index.add(payload('b', [[1, 0]], { frameId: 'frame@2', isMainFrame: false }));
    const resolved = index.resolve('frame@2', 'b');
    expect(resolved?.root).toBeNull(); // node 0 of that frame is the text node 'inner'
    const main = index.resolve('page@1', 'a');
    expect(main?.root?.tag).toBe('HTML');
  });

  it('returns undefined for a snapshot name the archive does not contain', () => {
    const index = new SnapshotIndex();
    index.add(payload('a', FIRST_HTML));
    expect(index.resolve('page@1', 'after@call@99')).toBeUndefined();
    expect(index.resolve('page@nope', 'a')).toBeUndefined();
  });

  it('survives a reference that points outside the snapshot list', () => {
    const index = new SnapshotIndex();
    index.add(payload('a', [[5, 0]]));
    expect(index.resolve('page@1', 'a')?.root).toBeNull();
  });

  it('counts what it holds', () => {
    const index = new SnapshotIndex();
    index.add(payload('a', FIRST_HTML));
    index.add(payload('b', [[1, 2]]));
    expect(index.count).toBe(2);
  });
});

describe('flattenSnapshot', () => {
  it('builds runner-compatible paths, with nth-of-type only where a tag repeats', () => {
    const nodes = flattenSnapshot({
      tag: 'HTML',
      attrs: {},
      children: [
        {
          tag: 'BODY',
          attrs: {},
          children: [
            { tag: 'DIV', attrs: {}, children: [] },
            { tag: 'DIV', attrs: {}, children: [] },
            { tag: 'P', attrs: {}, children: [] },
          ],
        },
      ],
    });
    expect(nodes.map((node) => node.path)).toEqual([
      'html',
      'html>body',
      'html>body>div:nth-of-type(1)',
      'html>body>div:nth-of-type(2)',
      'html>body>p',
    ]);
    expect(nodes[2]?.parent).toBe('html>body');
    expect(nodes[2]?.depth).toBe(2);
  });

  it('lifts Playwright state sentinels out of the attributes', () => {
    const nodes = flattenSnapshot({
      tag: 'INPUT',
      attrs: {
        id: 'q',
        placeholder: 'query',
        __playwright_value_: 'hello world',
        __playwright_target__: '',
        __playwright_scroll_top_: '400',
      },
      children: [],
    });
    expect(nodes[0]?.attrs).toEqual({ id: 'q', placeholder: 'query' });
    expect(nodes[0]?.state).toEqual({ value: 'hello world', scrollTop: 400 });
    expect(nodes[0]?.target).toBe(true);
  });

  it('reads the strongest test id available and the role attribute', () => {
    const nodes = flattenSnapshot({
      tag: 'BUTTON',
      attrs: { 'data-testid': 'fetch', role: 'button' },
      children: ['Fetch'],
    });
    expect(nodes[0]?.testId).toBe('fetch');
    expect(nodes[0]?.role).toBe('button');
    expect(nodes[0]?.text).toBe('Fetch');
  });

  it('collapses whitespace and truncates very long text', () => {
    const long = 'x'.repeat(400);
    const nodes = flattenSnapshot({
      tag: 'P',
      attrs: {},
      children: ['  a\n  b  ', ` ${long}`],
    });
    expect(nodes[0]?.text?.startsWith('a b x')).toBe(true);
    expect(nodes[0]?.text?.endsWith('…')).toBe(true);
    expect(nodes[0]?.text).toHaveLength(301);
  });

  it('omits elements that render nothing but keeps their descendants addressable', () => {
    const nodes = flattenSnapshot({
      tag: 'HTML',
      attrs: {},
      children: [
        { tag: 'HEAD', attrs: {}, children: [{ tag: 'TITLE', attrs: {}, children: ['t'] }] },
        { tag: 'BODY', attrs: {}, children: [{ tag: 'SCRIPT', attrs: {}, children: ['x'] }] },
      ],
    });
    expect(nodes.map((node) => node.tag)).toEqual(['html', 'body']);
  });

  it('returns nothing for a snapshot that did not resolve', () => {
    expect(flattenSnapshot(null)).toEqual([]);
  });
});
