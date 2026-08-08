import { describe, expect, it } from 'vitest';
import { isSupportedSelector, matchesAny, matchesSelector, selectorFor } from './selector.js';
import { domNode } from './testkit.js';

const rect = { x: 0, y: 0, w: 10, h: 10 };

describe('selectorFor', () => {
  it('prefers the test id, then the element id, then the path', () => {
    expect(
      selectorFor(
        domNode({ path: 'html>body>button', rect, testId: 'pay', attrs: { 'data-test': 'pay' } }),
      ),
    ).toBe('[data-test="pay"]');

    expect(
      selectorFor(domNode({ path: 'html>body>button', rect, testId: 'pay', attrs: { 'data-testid': 'pay' } })),
    ).toBe('[data-testid="pay"]');

    expect(selectorFor(domNode({ path: 'html>body>h1', rect, attrs: { id: 'title' } }))).toBe('#title');
    expect(selectorFor(domNode({ path: 'html>body>h1', rect }))).toBe('html>body>h1');
  });
});

describe('matchesSelector', () => {
  const node = domNode({
    path: 'html>body>span',
    rect,
    tag: 'span',
    role: 'status',
    attrs: { class: 'clock live', id: 'now', 'data-test': 'session-id' },
  });

  it('matches attribute selectors with and without a value', () => {
    expect(matchesSelector(node, '[data-test=session-id]')).toBe(true);
    expect(matchesSelector(node, '[data-test="session-id"]')).toBe(true);
    expect(matchesSelector(node, '[data-test=other]')).toBe(false);
    expect(matchesSelector(node, '[data-test]')).toBe(true);
    expect(matchesSelector(node, '[href]')).toBe(false);
  });

  it('matches tag, id and class compounds', () => {
    expect(matchesSelector(node, 'span')).toBe(true);
    expect(matchesSelector(node, 'div')).toBe(false);
    expect(matchesSelector(node, '#now')).toBe(true);
    expect(matchesSelector(node, '.clock')).toBe(true);
    expect(matchesSelector(node, '.clock.live')).toBe(true);
    expect(matchesSelector(node, '.clock.missing')).toBe(false);
    expect(matchesSelector(node, 'span#now.clock')).toBe(true);
  });

  it('matches the role field as if it were an attribute', () => {
    expect(matchesSelector(node, '[role=status]')).toBe(true);
  });

  it('accepts comma-separated lists', () => {
    expect(matchesAny(node, ['[data-test=other]', '.clock'])).toBe(true);
    expect(matchesAny(node, ['[data-test=other]', '.nope'])).toBe(false);
    expect(matchesSelector(node, 'div, span')).toBe(true);
  });

  it('reports selectors it cannot evaluate instead of pretending', () => {
    expect(isSupportedSelector('[data-test=pay]')).toBe(true);
    expect(isSupportedSelector('div.card')).toBe(true);
    expect(isSupportedSelector('div > .card')).toBe(false);
    expect(isSupportedSelector('div .card')).toBe(false);
    expect(isSupportedSelector('')).toBe(false);
  });
});
