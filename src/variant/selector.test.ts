/**
 * The selector validator is the gate that stops "unparseable selector" (variants spec §7) from
 * becoming a silent no-match at run time, so both halves are tested: what a browser accepts must be
 * accepted, and what it throws on must be refused with a reason a person can act on.
 */

import { describe, expect, it } from 'vitest';
import { isValidSelector, parseSelector } from './selector.js';

function reason(selector: string): string {
  const parsed = parseSelector(selector);
  if (parsed.ok) throw new Error(`expected ${JSON.stringify(selector)} to be refused, but it parsed`);
  return parsed.reason;
}

describe('selectors a page would accept', () => {
  const accepted = [
    '[data-test=forecast-card]',
    '[data-test="forecast card"]',
    "[data-test='forecast-card']",
    '[data-test=plan-card]:first-child',
    '[hidden]',
    '[data-test^=plan-]',
    '[data-test~=plan]',
    '[data-test|=plan]',
    '[data-test$=card]',
    '[data-test*=card]',
    '[data-test="Card" i]',
    'div',
    '*',
    '#total',
    '.card',
    'div.card.is-open#main[data-test=x]',
    'main .card',
    'main > .card',
    'li + li',
    'li ~ li',
    'main   >   .card',
    '.a, .b, .c',
    '.card:not(.is-open)',
    '.card:not(.a, .b)',
    ':is(main, aside) .card',
    '.card:has(> img)',
    'li:nth-child(2n+1)',
    'li:nth-child(odd)',
    'li:nth-child(3)',
    'li:nth-last-child(-n+2)',
    'li:nth-child(2 of .card)',
    'input:checked',
    '.md\\:flex',
    '[data-test=forecast-card] , [data-test=air-quality]',
  ];

  for (const selector of accepted) {
    it(`accepts ${selector}`, () => {
      expect(parseSelector(selector).ok).toBe(true);
    });
  }

  it('counts the entries of a selector list', () => {
    const parsed = parseSelector('.a, .b, .c');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.count).toBe(3);
    expect(parsed.pseudoElements).toEqual([]);
  });

  it('reports pseudo-elements instead of refusing them, in both spellings', () => {
    for (const [selector, spelling] of [
      ['.card::before', '::before'],
      ['.card:after', ':after'],
      ['p::first-line', '::first-line'],
    ] as const) {
      const parsed = parseSelector(selector);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.pseudoElements).toEqual([spelling]);
    }
  });

  it('does not mistake a pseudo-class for a pseudo-element', () => {
    const parsed = parseSelector('li:first-child:hover');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.pseudoElements).toEqual([]);
  });
});

describe('selectors a page would throw on', () => {
  it('refuses an empty selector', () => {
    expect(reason('')).toBe('it is empty, so it matches nothing');
    expect(reason('   ')).toBe('it is empty, so it matches nothing');
  });

  it('refuses an empty entry in a selector list', () => {
    expect(reason('.a, , .b')).toBe(
      'a comma-separated selector list has an empty entry, so one of its selectors is missing',
    );
    expect(reason('.a,')).toBe(
      'a comma-separated selector list has an empty entry, so one of its selectors is missing',
    );
  });

  it('refuses a combinator with nothing on its right', () => {
    expect(reason('main >')).toBe("the combinator '>' has nothing on its right");
    expect(reason('main > , .b')).toBe("the combinator '>' has nothing on its right");
  });

  it('refuses a combinator with nothing on its left', () => {
    expect(reason('> .card')).toBe(
      "it starts with the combinator '>', which has nothing on its left",
    );
  });

  it('allows a leading combinator inside :has(), where it is relative', () => {
    expect(isValidSelector('.card:has(> img)')).toBe(true);
    expect(reason('.card:is(> img)')).toBe(
      "inside ':is(…)', it starts with the combinator '>', which has nothing on its left",
    );
  });

  it('refuses an unclosed attribute selector', () => {
    expect(reason('[data-test=card')).toBe(
      "an attribute selector opened with '[' is never closed",
    );
  });

  it('refuses an attribute selector with no name', () => {
    expect(reason('[=card]')).toBe(
      'an attribute selector needs an attribute name, as in [data-test=forecast-card]',
    );
  });

  it('names an unknown attribute operator', () => {
    expect(reason('[data-test!=card]')).toBe(
      'unknown attribute operator "!=": CSS has =, ~=, |=, ^=, $= and *=',
    );
  });

  it('refuses an unquoted attribute value that is not an identifier', () => {
    expect(reason('[data-index=3]')).toBe(
      'the attribute value "3" is not a CSS identifier, so a browser reads it as a syntax error ' +
        '— quote it, as in [data-test="3"]',
    );
  });

  it('refuses an unterminated quoted attribute value', () => {
    expect(reason('[data-test="card]')).toBe(
      'a quoted attribute value opened with " is never closed',
    );
  });

  it("refuses '.' and '#' with nothing after them", () => {
    expect(reason('.')).toBe("'.' must be followed by a class name, as in '.card'");
    expect(reason('#')).toBe("'#' must be followed by an id, as in '#total'");
    expect(reason('div.')).toBe("'.' must be followed by a class name, as in '.card'");
  });

  it("refuses ':' with no pseudo-class name", () => {
    expect(reason('div:')).toBe("':' must be followed by a pseudo-class name, as in ':first-child'");
  });

  it('refuses an unclosed functional pseudo-class', () => {
    expect(reason('.card:not(.a')).toBe("the argument of ':not(' is never closed");
  });

  it('refuses an empty functional pseudo-class argument', () => {
    expect(reason('.card:not()')).toBe("inside ':not(…)', it has an empty argument");
    expect(reason('.card:lang()')).toBe("':lang()' has an empty argument");
  });

  it('refuses a position that is not An+B', () => {
    expect(reason('li:nth-child(banana)')).toBe(
      "':nth-child(banana)' is not a valid position: it takes 'odd', 'even', a number, or an " +
        "An+B expression such as '2n+1'",
    );
  });

  it('refuses a namespaced selector rather than silently matching nothing', () => {
    expect(reason('svg|circle')).toBe(
      "namespaced selectors such as 'svg|circle' are not supported: write the local name on its own",
    );
  });

  it('names the character it could not understand', () => {
    expect(reason('.card!')).toBe('the character "!" cannot appear here');
    expect(reason('%')).toBe('the character "%" cannot appear here');
  });

  it('points at the offending character', () => {
    const parsed = parseSelector('main > .card!');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.index).toBe(12);
  });
});
