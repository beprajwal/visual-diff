/**
 * The golden tests are only as trustworthy as the document they run against, so the fixture DOM is
 * tested first: parsing, serialization, the selector subset, the tree mutations `applyVariantInPage`
 * performs, and the computed-style model the unstyled-clone check (§4) depends on.
 */

import { describe, expect, it } from 'vitest';

import {
  TestElement,
  computedStyle,
  parseCss,
  parseDocument,
  prettyPrint,
  serializeNode,
} from './testdom.js';

const PAGE = `<html>
  <head><style id="app">.card { padding: 16px; font-family: Inter; }</style></head>
  <body>
    <main data-test="page">
      <section class="card" data-test="a"><h2>Today</h2></section>
      <section class="card" data-test="b"><h2>Tomorrow</h2></section>
      <img src="/logo.png" alt="Logo">
    </main>
  </body>
</html>`;

describe('parsing and serialization', () => {
  it('round-trips a document through outerHTML', () => {
    const doc = parseDocument(PAGE);
    const again = parseDocument(doc.outerHTML);
    expect(again.outerHTML).toBe(doc.outerHTML);
  });

  it('keeps void elements unclosed and attributes on them', () => {
    const doc = parseDocument(PAGE);
    const img = doc.querySelector('img');
    expect(img).not.toBeNull();
    expect(serializeNode(img as TestElement)).toBe('<img src="/logo.png" alt="Logo">');
  });

  it('keeps <style> text raw rather than parsing it as markup', () => {
    const doc = parseDocument('<style>a > b { color: red; }</style>');
    expect(doc.querySelector('style')?.textContent).toBe('a > b { color: red; }');
  });

  it('drops comments and doctypes', () => {
    const doc = parseDocument('<!doctype html><!-- hi --><p>text</p>');
    expect(doc.body.innerHTML).toBe('<p>text</p>');
  });

  it('pretty-prints one element per line for readable golden diffs', () => {
    const doc = parseDocument('<div id="root"><span>a</span></div>');
    expect(prettyPrint(doc.body)).toBe(
      ['<body>', '  <div id="root">', '    <span>', '      a', '    </span>', '  </div>', '</body>'].join(
        '\n',
      ),
    );
  });
});

describe('selectors', () => {
  const doc = parseDocument(PAGE);

  it('matches attribute, class, tag, descendant and child selectors', () => {
    expect(doc.querySelectorAll('[data-test=a]').length).toBe(1);
    expect(doc.querySelectorAll('.card').length).toBe(2);
    expect(doc.querySelectorAll('main section').length).toBe(2);
    expect(doc.querySelectorAll('main > section > h2').length).toBe(2);
    expect(doc.querySelectorAll('body h2').length).toBe(2);
  });

  it('supports the positional pseudo-classes a clone source uses', () => {
    expect(doc.querySelector('.card:first-child')?.getAttribute('data-test')).toBe('a');
    expect(doc.querySelector('section:nth-child(2)')?.getAttribute('data-test')).toBe('b');
    expect(doc.querySelectorAll('section:last-of-type').length).toBe(1);
  });

  it('throws on a selector it cannot evaluate, exactly as querySelectorAll does', () => {
    expect(() => doc.querySelectorAll('div:has(> p)')).toThrow(/cannot evaluate/);
    expect(() => doc.querySelectorAll('[unclosed')).toThrow(/not a valid selector/);
    expect(() => doc.querySelectorAll('')).toThrow(/not a valid selector/);
  });

  it('excludes the root when querying from an element, as the DOM does', () => {
    const main = doc.querySelector('[data-test=page]') as TestElement;
    expect(main.querySelectorAll('[data-test=page]')).toEqual([]);
    expect(main.querySelectorAll('section').length).toBe(2);
  });
});

describe('tree mutation', () => {
  it('moves a node rather than copying it', () => {
    const doc = parseDocument('<div id="a"><p id="p"></p></div><div id="b"></div>');
    const p = doc.querySelector('#p') as TestElement;
    const b = doc.querySelector('#b') as TestElement;
    b.appendChild(p);
    expect(doc.querySelectorAll('#p').length).toBe(1);
    expect(p.parentElement).toBe(b);
    expect((doc.querySelector('#a') as TestElement).children).toEqual([]);
  });

  it('treats inserting a node before itself as leaving it where it is', () => {
    const doc = parseDocument('<ul><li id="one"></li><li id="two"></li></ul>');
    const list = doc.querySelector('ul') as TestElement;
    const one = doc.querySelector('#one') as TestElement;
    expect(() => list.insertBefore(one, one)).not.toThrow();
    expect(list.firstElementChild).toBe(one);
  });

  it('refuses to insert a node into its own descendant', () => {
    const doc = parseDocument('<div id="outer"><div id="inner"></div></div>');
    const outer = doc.querySelector('#outer') as TestElement;
    const inner = doc.querySelector('#inner') as TestElement;
    expect(() => inner.appendChild(outer)).toThrow(/HierarchyRequestError/);
  });

  it('reports isConnected only for nodes attached to the document', () => {
    const doc = parseDocument('<div id="a"></div>');
    const a = doc.querySelector('#a') as TestElement;
    const detached = doc.createElement('div');
    expect(a.isConnected).toBe(true);
    expect(detached.isConnected).toBe(false);
    a.remove();
    expect(a.isConnected).toBe(false);
  });

  it('replaces children when textContent is set, as a text rule does', () => {
    const doc = parseDocument('<button id="cta"><span>Save</span></button>');
    const cta = doc.querySelector('#cta') as TestElement;
    cta.textContent = 'Save this location';
    expect(cta.innerHTML).toBe('Save this location');
    expect(cta.children).toEqual([]);
  });
});

describe('inline style', () => {
  it('reads back what it stored and renders it into the style attribute', () => {
    const doc = parseDocument('<div id="a"></div>');
    const a = doc.querySelector('#a') as TestElement;
    a.style.setProperty('padding', '8px', 'important');
    expect(a.style.getPropertyValue('padding')).toBe('8px');
    expect(a.style.getPropertyPriority('padding')).toBe('important');
    expect(a.getAttribute('style')).toBe('padding: 8px !important;');
    expect(a.outerHTML).toBe('<div id="a" style="padding: 8px !important;"></div>');
  });

  it('drops a declaration a browser would reject, so the read-back is empty', () => {
    const doc = parseDocument('<div id="a"></div>');
    const a = doc.querySelector('#a') as TestElement;
    a.style.setProperty('padding', '8', 'important');
    expect(a.style.getPropertyValue('padding')).toBe('');
  });

  it('parses a style attribute present in the source markup', () => {
    const doc = parseDocument('<div id="a" style="color: red; gap: 4px"></div>');
    const a = doc.querySelector('#a') as TestElement;
    expect(a.style.getPropertyValue('color')).toBe('red');
    expect(a.style.getPropertyValue('gap')).toBe('4px');
  });
});

describe('computed style', () => {
  it('applies document rules, then inline styles', () => {
    const doc = parseDocument(PAGE);
    const card = doc.querySelector('[data-test=a]') as TestElement;
    expect(computedStyle(doc, card).getPropertyValue('padding')).toBe('16px');
    card.style.setProperty('padding', '8px', 'important');
    expect(computedStyle(doc, card).getPropertyValue('padding')).toBe('8px');
  });

  it('inherits inheritable properties and leaves the rest at their initial value', () => {
    const doc = parseDocument(PAGE);
    const heading = doc.querySelector('[data-test=a] h2') as TestElement;
    expect(computedStyle(doc, heading).getPropertyValue('font-family')).toBe('Inter');
    expect(computedStyle(doc, heading).getPropertyValue('padding')).toBe('0px');
  });

  it('is what makes an unstyled clone visible: no rules, no styling', () => {
    const doc = parseDocument('<main><section class="card"></section></main>');
    const card = doc.querySelector('.card') as TestElement;
    expect(computedStyle(doc, card).getPropertyValue('font-family')).toBe('Times');
    expect(computedStyle(doc, card).getPropertyValue('padding')).toBe('0px');
  });

  it('skips at-rules whole rather than mistaking their contents for declarations', () => {
    const rules = parseCss('@media (min-width: 40em) { .card { padding: 2px; } } .card { gap: 1px; }');
    expect(rules).toEqual([{ selector: '.card', declarations: [['gap', '1px']] }]);
  });
});
