/**
 * A miniature DOM for the golden tests (variants spec §8.3).
 *
 * §8.3 asks for "a fixture DOM plus a variant in, resulting DOM out, for every verb". That needs a
 * document that can be parsed from HTML, mutated, and serialized back — and this repository takes
 * no dependency it does not have to (`jsdom` is a large tree that would be downloaded by every
 * `npx` user of the package it would sit beside). So the substrate is written here, in the spirit
 * of `mocking/testkit.ts`: small, hermetic, and shaped by what the code under test actually
 * touches.
 *
 * **It is a test fixture, not a browser.** What it implements is exactly the surface
 * `applyVariantInPage` and `extractCloneSourceInPage` use, listed here so a reader can see the
 * whole contract at once:
 *
 * - `Document`: `querySelector`, `querySelectorAll`, `createElement`, `head`, `body`,
 *   `documentElement`, `defaultView.getComputedStyle`
 * - `Element`: `tagName`, `getAttribute`, `setAttribute`, `textContent`, `innerHTML`, `outerHTML`,
 *   `style` (`setProperty`, `getPropertyValue`, `getPropertyPriority`, `removeProperty`),
 *   `parentElement`, `firstElementChild`, `lastElementChild`, `nextElementSibling`,
 *   `previousElementSibling`, `nextSibling`, `insertBefore`, `appendChild`, `contains`,
 *   `isConnected`, `querySelector`, `querySelectorAll`, and `content` on a `<template>`
 *
 * `testdom.test.ts` pins that surface and the semantics that matter: insertion moves a node rather
 * than copying it, an unparseable selector throws as `querySelectorAll` does, and computed styles
 * come from the document's own `<style>` rules — the last of which is what makes the unstyled-clone
 * check (§4) testable at all, since an unstyled clone is precisely an element whose rules were left
 * behind on the page it came from.
 *
 * Simplifications, all deliberate and all irrelevant to the code under test: no specificity (later
 * rules win, inline wins over both), no shorthand expansion (`padding` and `padding-left` are two
 * unrelated properties), no `@media`, no namespaces, and a small table of initial values.
 */

/* ------------------------------------------------------------------ nodes */

export type TestNode = TestElement | TestText;

export class TestText {
  readonly nodeType = 3;
  parentNode: TestElement | null = null;
  ownerDocument: TestDocument | null = null;
  data: string;

  constructor(data: string) {
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  get isConnected(): boolean {
    return this.parentNode !== null && this.parentNode.isConnected;
  }
}

/** One inline style declaration block, ordered as written. */
export class TestStyle {
  readonly #values = new Map<string, string>();
  readonly #priorities = new Map<string, string>();

  setProperty(name: string, value: string, priority = ''): void {
    const property = name.trim().toLowerCase();
    // A browser drops a declaration it cannot parse, and so does this: the `style` verb's
    // "rejected declaration" reporting depends on the read-back being empty.
    if (value.trim() === '' || !isPlausibleCssValue(property, value)) {
      this.#values.delete(property);
      this.#priorities.delete(property);
      return;
    }
    this.#values.set(property, value.trim());
    this.#priorities.set(property, priority);
  }

  getPropertyValue(name: string): string {
    return this.#values.get(name.trim().toLowerCase()) ?? '';
  }

  getPropertyPriority(name: string): string {
    return this.#priorities.get(name.trim().toLowerCase()) ?? '';
  }

  removeProperty(name: string): string {
    const property = name.trim().toLowerCase();
    const previous = this.#values.get(property) ?? '';
    this.#values.delete(property);
    this.#priorities.delete(property);
    return previous;
  }

  get length(): number {
    return this.#values.size;
  }

  entries(): Array<[string, string]> {
    return [...this.#values.entries()];
  }

  get cssText(): string {
    return this.entries()
      .map(([name, value]) => {
        const priority = this.#priorities.get(name) ?? '';
        return `${name}: ${value}${priority === '' ? '' : ` !${priority}`};`;
      })
      .join(' ');
  }

  set cssText(text: string) {
    this.#values.clear();
    this.#priorities.clear();
    for (const declaration of text.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      const name = declaration.slice(0, colon);
      let value = declaration.slice(colon + 1).trim();
      let priority = '';
      if (/!important$/i.test(value)) {
        priority = 'important';
        value = value.replace(/!important$/i, '').trim();
      }
      this.setProperty(name, value, priority);
    }
  }
}

/**
 * A value a browser would keep. Only crude cases are rejected — a bare number where a length is
 * required, and an empty value — which is enough to exercise the "the browser rejected N
 * declarations" path without pretending to be a CSS parser.
 */
function isPlausibleCssValue(property: string, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  if (LENGTH_PROPS.has(property) && /^-?\d+(\.\d+)?$/.test(trimmed)) return false;
  return true;
}

const LENGTH_PROPS = new Set([
  'width',
  'height',
  'padding',
  'margin',
  'gap',
  'font-size',
  'border-radius',
  'top',
  'left',
  'right',
  'bottom',
]);

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const RAW_TEXT_TAGS = new Set(['style', 'script']);

export class TestElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: TestNode[] = [];
  readonly style = new TestStyle();
  parentNode: TestElement | null = null;
  ownerDocument: TestDocument | null = null;

  readonly #attributes = new Map<string, string>();

  constructor(tagName: string, ownerDocument: TestDocument | null = null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  /* ---------------------------------------------------------------- attributes */

  getAttribute(name: string): string | null {
    const key = name.toLowerCase();
    if (key === 'style') {
      if (this.style.length > 0) return this.style.cssText;
      return this.#attributes.get('style') ?? null;
    }
    return this.#attributes.get(key) ?? null;
  }

  setAttribute(name: string, value: string): void {
    const key = name.toLowerCase();
    if (key === 'style') {
      this.style.cssText = value;
      this.#attributes.set('style', value);
      return;
    }
    this.#attributes.set(key, value);
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name.toLowerCase());
  }

  /**
   * Attribute names in insertion order, with `style` always last.
   *
   * Normalising its position is what lets a golden expectation be written as ordinary HTML: an
   * element that arrived with a `style` attribute and one that grew inline declarations during
   * application then serialize the same way, so the comparison is about the DOM rather than about
   * the order two attributes happen to have been set in.
   */
  attributeNames(): string[] {
    const names = [...this.#attributes.keys()].filter((name) => name !== 'style');
    if (this.style.length > 0 || this.#attributes.has('style')) names.push('style');
    return names;
  }

  get id(): string {
    return this.getAttribute('id') ?? '';
  }

  get className(): string {
    return this.getAttribute('class') ?? '';
  }

  get classList(): string[] {
    return this.className.split(/\s+/).filter((entry) => entry !== '');
  }

  /* ---------------------------------------------------------------- tree */

  get parentElement(): TestElement | null {
    return this.parentNode;
  }

  get children(): TestElement[] {
    return this.childNodes.filter((node): node is TestElement => node.nodeType === 1);
  }

  get firstElementChild(): TestElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): TestElement | null {
    const kids = this.children;
    return kids[kids.length - 1] ?? null;
  }

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): TestNode | null {
    if (this.parentNode === null) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get previousSibling(): TestNode | null {
    if (this.parentNode === null) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return index <= 0 ? null : (this.parentNode.childNodes[index - 1] ?? null);
  }

  get nextElementSibling(): TestElement | null {
    if (this.parentNode === null) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get previousElementSibling(): TestElement | null {
    if (this.parentNode === null) return null;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    return index <= 0 ? null : (siblings[index - 1] ?? null);
  }

  get isConnected(): boolean {
    let node: TestElement = this;
    while (node.parentNode !== null) node = node.parentNode;
    return this.ownerDocument !== null && node === this.ownerDocument.documentElement;
  }

  contains(other: TestNode | null): boolean {
    let node: TestNode | null = other;
    while (node !== null) {
      if (node === (this as TestNode)) return true;
      node = node.parentNode;
    }
    return false;
  }

  insertBefore(node: TestNode, reference: TestNode | null): TestNode {
    if (node === (this as TestNode) || (node.nodeType === 1 && node.contains(this))) {
      throw new Error('HierarchyRequestError: a node cannot be inserted into its own descendant');
    }
    // Per the DOM spec, a reference equal to the node becomes the node's next sibling, which leaves
    // the node exactly where it already is. Browsers accept it; so does this.
    if (reference === node) return node;
    if (node.parentNode !== null) node.parentNode.removeChild(node);
    if (reference === null) {
      this.childNodes.push(node);
    } else {
      const index = this.childNodes.indexOf(reference);
      if (index === -1) throw new Error('NotFoundError: the reference node is not a child');
      this.childNodes.splice(index, 0, node);
    }
    node.parentNode = this;
    node.ownerDocument = this.ownerDocument;
    if (node.nodeType === 1) adoptDocument(node, this.ownerDocument);
    return node;
  }

  appendChild(node: TestNode): TestNode {
    return this.insertBefore(node, null);
  }

  removeChild(node: TestNode): TestNode {
    const index = this.childNodes.indexOf(node);
    if (index === -1) throw new Error('NotFoundError: the node to remove is not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  replaceWith(node: TestNode): void {
    const parent = this.parentNode;
    if (parent === null) return;
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }

  /** `<template>` exposes its parsed children through `content`; here they are the children. */
  get content(): TestElement {
    return this;
  }

  /* ---------------------------------------------------------------- text and markup */

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value: string) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes.length = 0;
    if (value !== '') this.appendChild(new TestText(value));
  }

  get innerHTML(): string {
    return this.childNodes.map(serializeNode).join('');
  }

  set innerHTML(html: string) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes.length = 0;
    for (const node of parseNodes(html, this.ownerDocument)) this.appendChild(node);
  }

  get outerHTML(): string {
    return serializeNode(this);
  }

  /* ---------------------------------------------------------------- selectors */

  querySelectorAll(selector: string): TestElement[] {
    const list = parseSelectorList(selector);
    const out: TestElement[] = [];
    walkElements(this, (element) => {
      if (element !== (this as TestElement) && matchesList(element, list)) out.push(element);
    });
    return out;
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  matches(selector: string): boolean {
    return matchesList(this, parseSelectorList(selector));
  }
}

function adoptDocument(element: TestElement, doc: TestDocument | null): void {
  element.ownerDocument = doc;
  for (const child of element.childNodes) {
    child.ownerDocument = doc;
    if (child.nodeType === 1) adoptDocument(child, doc);
  }
}

function walkElements(root: TestElement, visit: (element: TestElement) => void): void {
  visit(root);
  for (const child of root.childNodes) {
    if (child.nodeType === 1) walkElements(child, visit);
  }
}

/* ------------------------------------------------------------------ document */

export interface TestComputedStyle {
  getPropertyValue(name: string): string;
}

export class TestDocument {
  documentElement: TestElement;

  constructor() {
    this.documentElement = new TestElement('html', this);
    this.documentElement.appendChild(new TestElement('head', this));
    this.documentElement.appendChild(new TestElement('body', this));
  }

  get head(): TestElement {
    return this.documentElement.querySelector('head') ?? this.documentElement;
  }

  get body(): TestElement {
    return this.documentElement.querySelector('body') ?? this.documentElement;
  }

  createElement(tagName: string): TestElement {
    return new TestElement(tagName, this);
  }

  createTextNode(data: string): TestText {
    const text = new TestText(data);
    text.ownerDocument = this;
    return text;
  }

  querySelectorAll(selector: string): TestElement[] {
    const list = parseSelectorList(selector);
    const out: TestElement[] = [];
    walkElements(this.documentElement, (element) => {
      if (matchesList(element, list)) out.push(element);
    });
    return out;
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  get defaultView(): { getComputedStyle(element: TestElement): TestComputedStyle } {
    return {
      getComputedStyle: (element: TestElement): TestComputedStyle => computedStyle(this, element),
    };
  }

  get outerHTML(): string {
    return serializeNode(this.documentElement);
  }
}

/* ------------------------------------------------------------------ parsing */

const ATTR_RE = /([^\s"'>/=]+)(\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Parse a fragment into nodes. Comments and doctypes are dropped; void tags never nest. */
export function parseNodes(html: string, doc: TestDocument | null): TestNode[] {
  const root = new TestElement('fragment', doc);
  const stack: TestElement[] = [root];
  let index = 0;

  const top = (): TestElement => stack[stack.length - 1] as TestElement;

  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next === -1) {
      const text = html.slice(index);
      if (text !== '') top().appendChild(new TestText(text));
      break;
    }
    if (next > index) {
      top().appendChild(new TestText(html.slice(index, next)));
    }
    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', next)) {
      const end = html.indexOf('>', next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', next)) {
      const end = html.indexOf('>', next);
      const name = html.slice(next + 2, end === -1 ? html.length : end).trim().toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if ((stack[i] as TestElement).tagName === name.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const end = html.indexOf('>', next);
    if (end === -1) {
      top().appendChild(new TestText(html.slice(next)));
      break;
    }
    let source = html.slice(next + 1, end);
    const selfClosing = source.endsWith('/');
    if (selfClosing) source = source.slice(0, -1);
    const space = source.search(/\s/);
    const tagName = (space === -1 ? source : source.slice(0, space)).toLowerCase();
    const element = new TestElement(tagName, doc);
    if (space !== -1) {
      const attrs = source.slice(space);
      ATTR_RE.lastIndex = 0;
      let match = ATTR_RE.exec(attrs);
      while (match !== null) {
        const name = match[1] as string;
        const value = match[4] ?? match[5] ?? match[6] ?? '';
        element.setAttribute(name, value);
        match = ATTR_RE.exec(attrs);
      }
    }
    top().appendChild(element);
    index = end + 1;

    if (selfClosing || VOID_TAGS.has(tagName)) continue;

    if (RAW_TEXT_TAGS.has(tagName)) {
      const closing = html.toLowerCase().indexOf(`</${tagName}`, index);
      const raw = html.slice(index, closing === -1 ? html.length : closing);
      if (raw !== '') element.appendChild(new TestText(raw));
      if (closing === -1) {
        index = html.length;
      } else {
        const closeEnd = html.indexOf('>', closing);
        index = closeEnd === -1 ? html.length : closeEnd + 1;
      }
      continue;
    }
    stack.push(element);
  }

  const nodes = [...root.childNodes];
  for (const node of nodes) node.parentNode = null;
  root.childNodes.length = 0;
  return nodes;
}

/** Parse a whole document. Anything outside `<html>` is hoisted into a synthesized one. */
export function parseDocument(html: string): TestDocument {
  const doc = new TestDocument();
  const nodes = parseNodes(html, doc);
  const parsedHtml = nodes.find(
    (node): node is TestElement => node.nodeType === 1 && node.tagName === 'HTML',
  );
  if (parsedHtml !== undefined) {
    doc.documentElement = parsedHtml;
    adoptDocument(parsedHtml, doc);
    if (parsedHtml.querySelector('body') === null) {
      const body = new TestElement('body', doc);
      for (const child of [...parsedHtml.childNodes]) {
        if (child.nodeType === 1 && (child as TestElement).tagName === 'HEAD') continue;
        body.appendChild(child);
      }
      parsedHtml.appendChild(body);
    }
    if (parsedHtml.querySelector('head') === null) {
      parsedHtml.insertBefore(new TestElement('head', doc), parsedHtml.firstChild);
    }
    return doc;
  }
  for (const node of nodes) {
    if (node.nodeType === 1 && (node as TestElement).tagName === 'STYLE') {
      doc.head.appendChild(node);
      continue;
    }
    doc.body.appendChild(node);
  }
  return doc;
}

/* ------------------------------------------------------------------ serialization */

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function serializeNode(node: TestNode): string {
  if (node.nodeType === 3) return escapeText((node as TestText).data);
  const element = node as TestElement;
  const tag = element.tagName.toLowerCase();
  const attrs = element
    .attributeNames()
    .map((name) => ` ${name}="${escapeAttr(element.getAttribute(name) ?? '')}"`)
    .join('');
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  const inner = RAW_TEXT_TAGS.has(tag)
    ? element.childNodes.map((child) => child.textContent).join('')
    : element.childNodes.map(serializeNode).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Serialize a document for a golden comparison, one element per line and indented, so a diff of two
 * expectations points at the element that moved rather than at one very long line.
 */
export function prettyPrint(node: TestNode | TestDocument, depth = 0): string {
  const target: TestNode = node instanceof TestDocument ? node.documentElement : node;
  const pad = '  '.repeat(depth);
  if (target.nodeType === 3) {
    const text = (target as TestText).data.trim();
    return text === '' ? '' : `${pad}${escapeText(text)}`;
  }
  const element = target as TestElement;
  const tag = element.tagName.toLowerCase();
  const attrs = element
    .attributeNames()
    .map((name) => ` ${name}="${escapeAttr(element.getAttribute(name) ?? '')}"`)
    .join('');
  const children = element.childNodes
    .map((child) => prettyPrint(child, depth + 1))
    .filter((line) => line !== '');
  if (VOID_TAGS.has(tag)) return `${pad}<${tag}${attrs}>`;
  if (children.length === 0) return `${pad}<${tag}${attrs}></${tag}>`;
  return [`${pad}<${tag}${attrs}>`, ...children, `${pad}</${tag}>`].join('\n');
}

/* ------------------------------------------------------------------ selectors */

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; operator?: string; value?: string }>;
  pseudos: Array<{ name: string; argument?: string }>;
}

interface ComplexPart {
  compound: Compound;
  /** How this part relates to the one before it: ' ' descendant, '>' child. */
  combinator: ' ' | '>' | null;
}

const SELECTOR_CACHE = new Map<string, ComplexPart[][]>();

export function parseSelectorList(selector: string): ComplexPart[][] {
  const cached = SELECTOR_CACHE.get(selector);
  if (cached !== undefined) return cached;
  const list = selector
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (list.length === 0) {
    throw new Error(`SyntaxError: '${selector}' is not a valid selector`);
  }
  const parsed = list.map((entry) => parseComplex(entry, selector));
  SELECTOR_CACHE.set(selector, parsed);
  return parsed;
}

function parseComplex(entry: string, whole: string): ComplexPart[] {
  const parts: ComplexPart[] = [];
  let combinator: ' ' | '>' | null = null;
  let index = 0;
  while (index < entry.length) {
    while (index < entry.length && /\s/.test(entry[index] as string)) {
      if (parts.length > 0) combinator = combinator === '>' ? '>' : ' ';
      index += 1;
    }
    if (index >= entry.length) break;
    if (entry[index] === '>') {
      combinator = '>';
      index += 1;
      continue;
    }
    const { compound, next } = parseCompound(entry, index, whole);
    parts.push({ compound, combinator: parts.length === 0 ? null : (combinator ?? ' ') });
    combinator = null;
    index = next;
  }
  if (parts.length === 0) throw new Error(`SyntaxError: '${whole}' is not a valid selector`);
  return parts;
}

function parseCompound(entry: string, start: number, whole: string): { compound: Compound; next: number } {
  const compound: Compound = { classes: [], attrs: [], pseudos: [] };
  let index = start;
  let consumed = false;
  while (index < entry.length) {
    const char = entry[index] as string;
    if (char === '*') {
      consumed = true;
      index += 1;
      continue;
    }
    if (/[A-Za-z]/.test(char) && !consumed && compound.tag === undefined && index === start) {
      const match = /^[A-Za-z][\w-]*/.exec(entry.slice(index));
      if (match === null) break;
      compound.tag = match[0].toUpperCase();
      consumed = true;
      index += match[0].length;
      continue;
    }
    if (char === '#' || char === '.') {
      const match = /^[\w-]+/.exec(entry.slice(index + 1));
      if (match === null) throw new Error(`SyntaxError: '${whole}' is not a valid selector`);
      if (char === '#') compound.id = match[0];
      else compound.classes.push(match[0]);
      consumed = true;
      index += 1 + match[0].length;
      continue;
    }
    if (char === '[') {
      const end = entry.indexOf(']', index);
      if (end === -1) throw new Error(`SyntaxError: '${whole}' is not a valid selector`);
      const body = entry.slice(index + 1, end);
      const match = /^\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(.*?)\s*)?$/.exec(body);
      if (match === null) throw new Error(`SyntaxError: '${whole}' is not a valid selector`);
      const name = (match[1] as string).toLowerCase();
      const operator = match[2];
      let value = match[3];
      if (value !== undefined) value = stripQuotes(value);
      compound.attrs.push(
        operator === undefined ? { name } : { name, operator, value: value ?? '' },
      );
      consumed = true;
      index = end + 1;
      continue;
    }
    if (char === ':') {
      const match = /^::?([\w-]+)(\(([^)]*)\))?/.exec(entry.slice(index));
      if (match === null) throw new Error(`SyntaxError: '${whole}' is not a valid selector`);
      const name = (match[1] as string).toLowerCase();
      if (!SUPPORTED_PSEUDOS.has(name)) {
        throw new Error(
          `SyntaxError: '${whole}' uses ':${name}', which this document cannot evaluate`,
        );
      }
      const argument = match[3];
      compound.pseudos.push(argument === undefined ? { name } : { name, argument });
      consumed = true;
      index += match[0].length;
      continue;
    }
    break;
  }
  if (!consumed) throw new Error(`SyntaxError: '${whole}' is not a valid selector`);
  return { compound, next: index };
}

const SUPPORTED_PSEUDOS = new Set([
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'nth-child',
  'not',
]);

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function matchesAttr(
  element: TestElement,
  attr: { name: string; operator?: string; value?: string },
): boolean {
  const actual = element.getAttribute(attr.name);
  if (actual === null) return false;
  if (attr.operator === undefined || attr.value === undefined) return true;
  switch (attr.operator) {
    case '=':
      return actual === attr.value;
    case '~=':
      return actual.split(/\s+/).includes(attr.value);
    case '^=':
      return actual.startsWith(attr.value);
    case '$=':
      return actual.endsWith(attr.value);
    case '*=':
      return actual.includes(attr.value);
    case '|=':
      return actual === attr.value || actual.startsWith(`${attr.value}-`);
    default:
      return false;
  }
}

function matchesCompound(element: TestElement, compound: Compound): boolean {
  if (compound.tag !== undefined && element.tagName !== compound.tag) return false;
  if (compound.id !== undefined && element.id !== compound.id) return false;
  for (const className of compound.classes) {
    if (!element.classList.includes(className)) return false;
  }
  for (const attr of compound.attrs) {
    if (!matchesAttr(element, attr)) return false;
  }
  for (const pseudo of compound.pseudos) {
    if (!matchesPseudo(element, pseudo)) return false;
  }
  return true;
}

function matchesPseudo(element: TestElement, pseudo: { name: string; argument?: string }): boolean {
  const siblings = element.parentNode?.children ?? [element];
  switch (pseudo.name) {
    case 'first-child':
      return siblings[0] === element;
    case 'last-child':
      return siblings[siblings.length - 1] === element;
    case 'only-child':
      return siblings.length === 1;
    case 'first-of-type':
      return siblings.find((sibling) => sibling.tagName === element.tagName) === element;
    case 'last-of-type':
      return (
        [...siblings].reverse().find((sibling) => sibling.tagName === element.tagName) === element
      );
    case 'nth-child': {
      const wanted = Number(pseudo.argument);
      if (!Number.isInteger(wanted)) return false;
      return siblings[wanted - 1] === element;
    }
    case 'not':
      return !matchesList(element, parseSelectorList(pseudo.argument ?? '*'));
    default:
      return false;
  }
}

function matchesComplex(element: TestElement, parts: ComplexPart[]): boolean {
  const last = parts[parts.length - 1];
  if (last === undefined) return false;
  if (!matchesCompound(element, last.compound)) return false;
  let current: TestElement | null = element;
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const part = parts[i] as ComplexPart;
    const previous = parts[i - 1] as ComplexPart;
    if (part.combinator === '>') {
      current = current === null ? null : current.parentElement;
      if (current === null || !matchesCompound(current, previous.compound)) return false;
      continue;
    }
    let ancestor: TestElement | null = current === null ? null : current.parentElement;
    while (ancestor !== null && !matchesCompound(ancestor, previous.compound)) {
      ancestor = ancestor.parentElement;
    }
    if (ancestor === null) return false;
    current = ancestor;
  }
  return true;
}

function matchesList(element: TestElement, list: ComplexPart[][]): boolean {
  return list.some((parts) => matchesComplex(element, parts));
}

/* ------------------------------------------------------------------ computed style */

interface CssRule {
  selector: string;
  declarations: Array<[string, string]>;
}

/** Parse `<style>` text into flat rules. At-rules are skipped whole, braces and all. */
export function parseCss(text: string): CssRule[] {
  const rules: CssRule[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open === -1) break;
    const prelude = text.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === '{') depth += 1;
      else if (text[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    const body = text.slice(open + 1, cursor - 1);
    index = cursor;
    if (prelude.startsWith('@')) continue;
    const declarations: Array<[string, string]> = [];
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      const name = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).replace(/!important/i, '').trim();
      if (name === '' || value === '') continue;
      declarations.push([name, value]);
    }
    for (const selector of prelude.split(',')) {
      const trimmed = selector.trim();
      if (trimmed !== '') rules.push({ selector: trimmed, declarations });
    }
  }
  return rules;
}

const INHERITED = new Set([
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'visibility',
]);

const INITIAL: Record<string, string> = {
  color: 'rgb(0, 0, 0)',
  'background-color': 'rgba(0, 0, 0, 0)',
  'background-image': 'none',
  'font-family': 'Times',
  'font-size': '16px',
  'font-weight': '400',
  'font-style': 'normal',
  'line-height': 'normal',
  'letter-spacing': 'normal',
  'text-align': 'start',
  'text-transform': 'none',
  'text-decoration-line': 'none',
  'border-top-width': '0px',
  'border-right-width': '0px',
  'border-bottom-width': '0px',
  'border-left-width': '0px',
  'border-color': 'rgb(0, 0, 0)',
  'border-style': 'none',
  'border-radius': '0px',
  'box-shadow': 'none',
  display: 'block',
  position: 'static',
  opacity: '1',
  'z-index': 'auto',
  margin: '0px',
  padding: '0px',
  gap: 'normal',
  visibility: 'visible',
};

const INLINE_TAGS = new Set(['SPAN', 'A', 'EM', 'STRONG', 'B', 'I', 'SMALL', 'LABEL', 'CODE']);

function declaredStyle(doc: TestDocument, element: TestElement): Map<string, string> {
  const declared = new Map<string, string>();
  for (const styleElement of doc.querySelectorAll('style')) {
    for (const rule of parseCss(styleElement.textContent)) {
      let matched = false;
      try {
        matched = element.matches(rule.selector);
      } catch {
        matched = false;
      }
      if (!matched) continue;
      for (const [name, value] of rule.declarations) declared.set(name, value);
    }
  }
  for (const [name, value] of element.style.entries()) declared.set(name, value);
  return declared;
}

/**
 * The computed value of every property this fixture knows about: document rules in order, then
 * inline styles, then inheritance from the parent, then an initial value.
 */
export function computedStyle(doc: TestDocument, element: TestElement): TestComputedStyle {
  const chain: TestElement[] = [];
  let node: TestElement | null = element;
  while (node !== null) {
    chain.unshift(node);
    node = node.parentElement;
  }
  const resolved = new Map<string, string>();
  for (const current of chain) {
    const declared = declaredStyle(doc, current);
    const own = new Map<string, string>();
    for (const [name, value] of resolved) {
      if (INHERITED.has(name)) own.set(name, value);
    }
    for (const [name, value] of declared) own.set(name, value);
    resolved.clear();
    for (const [name, value] of own) resolved.set(name, value);
  }
  const initialDisplay = INLINE_TAGS.has(element.tagName) ? 'inline' : INITIAL.display;
  return {
    getPropertyValue(name: string): string {
      const property = name.trim().toLowerCase();
      const value = resolved.get(property);
      if (value !== undefined) return value;
      if (property === 'display') return initialDisplay ?? 'block';
      return INITIAL[property] ?? '';
    },
  };
}

/* ------------------------------------------------------------------ the cast */

/**
 * The single point where the fixture is handed to code typed against the real DOM.
 *
 * `applyVariantInPage` is typed against `Document` because that is what it receives in a page;
 * pretending this fixture *is* a `Document` in the type system would mean either weakening those
 * types or implementing several hundred members nothing calls. Keeping the lie to one exported
 * function makes it reviewable.
 */
export function asDocument(doc: TestDocument): Document {
  return doc as unknown as Document;
}

/** Parse a fixture document and hand it over as a `Document`, for the golden tests. */
export function fixtureDocument(html: string): { doc: TestDocument; asDocument: Document } {
  const doc = parseDocument(html);
  return { doc, asDocument: asDocument(doc) };
}
