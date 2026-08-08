/**
 * Capture (spec §7).
 *
 * Per step, per viewport, in one pass: a full-page screenshot, `dom.json` (visible nodes with a
 * stable path, tag, role, accessible name, text, bounding rect and the **fixed** style subset from
 * `types.ts#STYLE_PROPS`), and `a11y.json` — the latter taken *from the browser's accessibility
 * snapshot* (`captureA11ySnapshot`), never rebuilt from the DOM walk.
 *
 * The collector runs inside the page, so it is written as one self-contained function that closes
 * over nothing: Playwright serializes it to source and evaluates it in the page context. Every
 * value it needs — the style list, the attribute list, the node cap, the mask selectors — arrives
 * through its single argument.
 *
 * The node cap (spec §12) keeps `dom.json` bounded: past 5,000 nodes capture retains nodes in
 * document order and sets `truncated`, and DOM attribution degrades to the nearest retained
 * ancestor rather than failing.
 */

import { parse as parseYaml } from 'yaml';

import {
  CAPTURED_ATTRS,
  DEFAULTS,
  STYLE_PROPS,
  type A11yNode,
  type A11ySnapshot,
  type CapturedAttr,
  type DomNode,
  type DomSnapshot,
  type Rect,
  type StepId,
  type StyleProp,
  type StyleSubset,
  type ViewportId,
} from '../types.js';

/** Argument handed to the in-page collector. Plain JSON: it crosses a process boundary. */
export interface CollectArgs {
  styleProps: readonly string[];
  attrs: readonly string[];
  maxNodes: number;
  masks: readonly string[];
}

export interface CollectResult {
  url: string;
  document: { w: number; h: number };
  deviceScaleFactor: number;
  nodeCount: number;
  truncated: boolean;
  masks: Rect[];
  nodes: DomNode[];
}

/**
 * The in-page DOM collector. Exported so it can be handed to `page.evaluate` and so a test can
 * call it against a DOM-shaped stub; it must never reference anything outside `args`.
 */
export function collectDom(args: CollectArgs): CollectResult {
  const doc = document;
  const root = doc.documentElement;

  const round = (n: number): number => Math.round(n * 100) / 100;

  const rectOf = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return {
      x: round(r.left + window.scrollX),
      y: round(r.top + window.scrollY),
      w: round(r.width),
      h: round(r.height),
    };
  };

  const maskRects: Rect[] = [];
  for (const selector of args.masks) {
    let found: Element[] = [];
    try {
      found = Array.from(doc.querySelectorAll(selector));
    } catch {
      found = [];
    }
    for (const el of found) maskRects.push(rectOf(el));
  }

  const IMPLICIT_ROLES: Record<string, string> = {
    A: 'link',
    BUTTON: 'button',
    H1: 'heading',
    H2: 'heading',
    H3: 'heading',
    H4: 'heading',
    H5: 'heading',
    H6: 'heading',
    IMG: 'img',
    INPUT: 'textbox',
    LI: 'listitem',
    NAV: 'navigation',
    OL: 'list',
    P: 'paragraph',
    SELECT: 'combobox',
    TABLE: 'table',
    TEXTAREA: 'textbox',
    UL: 'list',
    MAIN: 'main',
    HEADER: 'banner',
    FOOTER: 'contentinfo',
    FORM: 'form',
    SECTION: 'region',
    DIALOG: 'dialog',
  };

  const roleOf = (el: Element): string | undefined => {
    const explicit = el.getAttribute('role');
    if (explicit !== null && explicit.trim() !== '') return explicit.trim();
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    return IMPLICIT_ROLES[tag];
  };

  const textOf = (el: Element): string => {
    const raw = el.textContent ?? '';
    return raw.replace(/\s+/g, ' ').trim();
  };

  const ownText = (el: Element): string => {
    let out = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) out += child.nodeValue ?? '';
    }
    return out.replace(/\s+/g, ' ').trim();
  };

  const nameOf = (el: Element): string | undefined => {
    const label = el.getAttribute('aria-label');
    if (label !== null && label.trim() !== '') return label.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy !== null && labelledBy.trim() !== '') {
      const parts: string[] = [];
      for (const id of labelledBy.trim().split(/\s+/)) {
        const target = doc.getElementById(id);
        if (target) parts.push(textOf(target));
      }
      const joined = parts.join(' ').trim();
      if (joined !== '') return joined;
    }

    const tag = el.tagName;
    if (tag === 'IMG') {
      const alt = el.getAttribute('alt');
      return alt === null || alt === '' ? undefined : alt;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const id = el.getAttribute('id');
      if (id !== null && id !== '') {
        let labels: Element[] = [];
        try {
          labels = Array.from(doc.querySelectorAll(`label[for="${CSS.escape(id)}"]`));
        } catch {
          labels = [];
        }
        const first = labels[0];
        if (first) return textOf(first);
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder !== null && placeholder !== '') return placeholder;
      const title = el.getAttribute('title');
      return title === null || title === '' ? undefined : title;
    }

    const text = textOf(el);
    if (text !== '' && text.length <= 200) return text;
    const title = el.getAttribute('title');
    return title === null || title === '' ? undefined : title;
  };

  const testIdOf = (el: Element): string | undefined => {
    for (const attr of ['data-test', 'data-testid', 'data-test-id']) {
      const value = el.getAttribute(attr);
      if (value !== null && value !== '') return value;
    }
    return undefined;
  };

  const segmentFor = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    let index = 0;
    let seen = 0;
    for (const sibling of Array.from(parent.children)) {
      if (sibling.tagName === el.tagName) {
        seen += 1;
        if (sibling === el) index = seen;
      }
    }
    return seen > 1 ? `${tag}:nth-of-type(${index})` : tag;
  };

  const nodes: DomNode[] = [];
  let total = 0;
  let truncated = false;

  const walk = (el: Element, parentPath: string | null, depth: number): void => {
    total += 1;
    const path = parentPath === null ? segmentFor(el) : `${parentPath}>${segmentFor(el)}`;

    const style = window.getComputedStyle(el);
    const rect = rectOf(el);
    const visible =
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 &&
      rect.w > 0 &&
      rect.h > 0;

    if (visible) {
      if (nodes.length >= args.maxNodes) {
        truncated = true;
      } else {
        const styles: Record<string, string> = {};
        for (const prop of args.styleProps) {
          styles[prop] = String(style.getPropertyValue(toKebab(prop)) || readStyle(style, prop));
        }
        const attrs: Record<string, string> = {};
        for (const attr of args.attrs) {
          const value = el.getAttribute(attr);
          if (value !== null) attrs[attr] = value;
        }
        const node: DomNode = {
          path,
          parent: parentPath,
          depth,
          tag: el.tagName.toLowerCase(),
          rect,
          visible: true,
          styles: styles as unknown as DomNode['styles'],
          attrs: attrs as DomNode['attrs'],
        };
        const testId = testIdOf(el);
        if (testId !== undefined) node.testId = testId;
        const role = roleOf(el);
        if (role !== undefined) node.role = role;
        const name = nameOf(el);
        if (name !== undefined) node.name = name;
        const own = ownText(el);
        if (own !== '') node.text = own.length > 300 ? `${own.slice(0, 300)}…` : own;
        nodes.push(node);
      }
    }

    for (const child of Array.from(el.children)) walk(child, path, depth + 1);
  };

  function toKebab(prop: string): string {
    return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  }

  function readStyle(style: CSSStyleDeclaration, prop: string): string {
    const value = (style as unknown as Record<string, unknown>)[prop];
    return typeof value === 'string' ? value : '';
  }

  walk(root, null, 0);

  return {
    url: location.href,
    document: {
      w: Math.max(root.scrollWidth, doc.body ? doc.body.scrollWidth : 0),
      h: Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0),
    },
    deviceScaleFactor: window.devicePixelRatio,
    nodeCount: total,
    truncated,
    masks: maskRects,
    nodes,
  };
}

export interface SnapshotArgs {
  step: StepId;
  viewport: ViewportId;
  masks: readonly string[];
  maxNodes?: number;
  deviceScaleFactor: number;
  capturedAt: string;
}

/** Assemble the on-disk `dom.json` from a raw collector result. */
export function toDomSnapshot(raw: CollectResult, args: SnapshotArgs): DomSnapshot {
  return {
    step: args.step,
    viewport: args.viewport,
    url: raw.url,
    capturedAt: args.capturedAt,
    deviceScaleFactor:
      Number.isFinite(raw.deviceScaleFactor) && raw.deviceScaleFactor > 0
        ? raw.deviceScaleFactor
        : args.deviceScaleFactor,
    document: raw.document,
    nodeCount: raw.nodeCount,
    truncated: raw.truncated,
    masks: raw.masks,
    nodes: raw.nodes,
  };
}

/** The argument the collector is called with, built from the shared contracts. */
export function collectArgs(
  masks: readonly string[],
  maxNodes: number = DEFAULTS.maxDomNodes,
): CollectArgs {
  return {
    styleProps: STYLE_PROPS as readonly StyleProp[] as readonly string[],
    attrs: CAPTURED_ATTRS as readonly CapturedAttr[] as readonly string[],
    maxNodes,
    masks: [...masks],
  };
}

/* ------------------------------------------------------------------ a11y.json (§7) */

/**
 * The slice of Playwright's `Locator` / `Page` the accessibility capture needs.
 *
 * Structural rather than the real `Page` type so `capture.ts` stays testable without a browser —
 * a real Playwright `Page` satisfies it.
 */
export interface AriaSnapshotSource {
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  title(): Promise<string>;
}

/** Root of the tree the accessibility snapshot is hung under. Matches the store's fixtures. */
export const A11Y_ROOT_ROLE = 'WebArea';

/** `role "name" [level=2] [checked]` — one line of Playwright's ARIA YAML. */
interface AriaHeader {
  role: string;
  name?: string;
  level?: number;
  /** Remaining state annotations, space-joined in source order, e.g. `checked disabled`. */
  states?: string;
}

/**
 * Split an ARIA snapshot key into role, accessible name and state annotations.
 *
 * The grammar Playwright emits is `role`, `role "accessible name"`, and either form followed by
 * zero or more ` [key]` / ` [key=value]` annotations.
 */
export function parseAriaHeader(header: string): AriaHeader {
  const states: string[] = [];
  let level: number | undefined;

  const withoutStates = header.replace(/\s*\[([^\]]*)\]/g, (_match, body: string) => {
    const trimmed = body.trim();
    if (trimmed === '') return '';
    const eq = trimmed.indexOf('=');
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq);
    const value = eq === -1 ? undefined : trimmed.slice(eq + 1);
    if (key === 'level' && value !== undefined) {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        level = parsed;
        return '';
      }
    }
    states.push(trimmed);
    return '';
  });

  const quoted = /^(\S+)\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(withoutStates.trim());
  const out: AriaHeader = { role: quoted === null ? withoutStates.trim() : (quoted[1] as string) };
  if (quoted !== null) out.name = (quoted[2] as string).replace(/\\(.)/g, '$1');
  if (level !== undefined) out.level = level;
  if (states.length > 0) out.states = states.join(' ');
  return out;
}

function ariaEntryToNode(entry: unknown): A11yNode | null {
  if (typeof entry === 'string') {
    const header = parseAriaHeader(entry);
    return headerToNode(header);
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;

  const record = entry as Record<string, unknown>;
  const key = Object.keys(record)[0];
  if (key === undefined) return null;
  const value = record[key];

  // `- text: some words` is Playwright's generic static text node.
  if (key === 'text') {
    const node: A11yNode = { role: 'text' };
    if (typeof value === 'string' && value !== '') node.name = value;
    return node;
  }
  // `- /url: /about` is a node *property*, not a child; the caller folds it into its parent.
  if (key.startsWith('/')) return null;

  const node = headerToNode(parseAriaHeader(key));
  if (Array.isArray(value)) {
    const children: A11yNode[] = [];
    for (const child of value) {
      if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
        const childKey = Object.keys(child as Record<string, unknown>)[0];
        if (childKey !== undefined && childKey.startsWith('/')) {
          const property = (child as Record<string, unknown>)[childKey];
          if (typeof property === 'string' && property !== '') {
            node.description =
              node.description === undefined
                ? `${childKey}=${property}`
                : `${node.description} ${childKey}=${property}`;
          }
          continue;
        }
      }
      const converted = ariaEntryToNode(child);
      if (converted !== null) children.push(converted);
    }
    if (children.length > 0) node.children = children;
  } else if (typeof value === 'string' && value !== '') {
    // The scalar Playwright renders for a leaf: its text content, or a form control's value.
    node.value = value;
  } else if (typeof value === 'number') {
    node.value = value;
  }
  return node;
}

function headerToNode(header: AriaHeader): A11yNode {
  const node: A11yNode = { role: header.role === '' ? 'generic' : header.role };
  if (header.name !== undefined) node.name = header.name;
  if (header.level !== undefined) node.level = header.level;
  if (header.states !== undefined) node.description = header.states;
  return node;
}

/**
 * Parse Playwright's ARIA snapshot YAML into the `a11y.json` tree.
 *
 * Pure, so the parser is tested without a browser. `level` becomes `A11yNode.level`; any other
 * state annotation Playwright rendered (`checked`, `disabled`, `selected`, `expanded`, …) is kept
 * verbatim in `description`, and a node's `/url`-style properties are appended there too, so a
 * change in any of them still shows up in a future a11y diff.
 */
export function parseAriaSnapshot(yaml: string, step: StepId, viewport: ViewportId, title = ''): A11ySnapshot {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    // Refuse to invent a tree from a snapshot we could not read.
    return { step, viewport, root: null };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { step, viewport, root: null };

  const children: A11yNode[] = [];
  for (const entry of parsed) {
    const node = ariaEntryToNode(entry);
    if (node !== null) children.push(node);
  }
  if (children.length === 0) return { step, viewport, root: null };

  const root: A11yNode = { role: A11Y_ROOT_ROLE };
  if (title !== '') root.name = title;
  root.children = children;
  return { step, viewport, root };
}

/**
 * `a11y.json` — spec §7: "`a11y.json` from the accessibility snapshot".
 *
 * This is the browser's own accessibility tree, taken through Playwright's `ariaSnapshot()`, not a
 * tree reconstructed from a DOM walk. A hand-rolled role table and name algorithm agree with the
 * platform accessibility tree only for the easy cases, so a reconstruction is exactly wrong where
 * an a11y regression is most worth catching.
 *
 * If the snapshot cannot be taken — the page navigated away, the context closed — the result is an
 * explicit empty tree. There is no DOM-derived substitute: a synthesized tree that claims to be the
 * accessibility snapshot is worse than an honest absence.
 */
export async function captureA11ySnapshot(
  page: AriaSnapshotSource,
  step: StepId,
  viewport: ViewportId,
): Promise<A11ySnapshot> {
  try {
    const [yaml, title] = await Promise.all([
      page.locator('body').ariaSnapshot(),
      page.title().catch(() => ''),
    ]);
    return parseAriaSnapshot(yaml, step, viewport, title);
  } catch {
    return { step, viewport, root: null };
  }
}

/**
 * The role/name tree *implied by* `dom.json` — an additive, DOM-derived view, **not** `a11y.json`.
 *
 * Kept because the diff engine's a11y findings are computed from `dom.json`'s role/name/aria
 * attributes, so this projection is a useful lens on the captured nodes. It is deliberately not
 * what capture persists: only `captureA11ySnapshot` produces the accessibility snapshot spec §7
 * asks for, and this function must never be used as a stand-in for it.
 */
export function toA11ySnapshot(nodes: readonly DomNode[], step: StepId, viewport: ViewportId): A11ySnapshot {
  const byPath = new Map<string, { node: A11yNode; parent: string | null }>();
  let root: A11yNode | null = null;

  for (const node of nodes) {
    if (node.role === undefined && node.parent !== null) continue;
    const entry: A11yNode = { role: node.role ?? 'generic' };
    if (node.name !== undefined) entry.name = node.name;
    if (node.role === 'heading') {
      const level = Number(node.tag.slice(1));
      if (Number.isInteger(level) && level > 0) entry.level = level;
    }
    const value = node.attrs.value;
    if (value !== undefined) entry.value = value;
    byPath.set(node.path, { node: entry, parent: node.parent });
    if (root === null) root = entry;
  }

  for (const [, entry] of byPath) {
    if (entry.parent === null) continue;
    let parentPath: string | null = entry.parent;
    while (parentPath !== null && !byPath.has(parentPath)) {
      const index = parentPath.lastIndexOf('>');
      parentPath = index === -1 ? null : parentPath.slice(0, index);
    }
    const parent = parentPath === null ? undefined : byPath.get(parentPath);
    if (parent === undefined || parent.node === entry.node) continue;
    (parent.node.children ??= []).push(entry.node);
  }

  return { step, viewport, root };
}

/** Styles for a node that carries none — used by tests and by degraded capture paths. */
export function emptyStyles(): StyleSubset {
  const out: Record<string, string> = {};
  for (const prop of STYLE_PROPS) out[prop] = '';
  return out as StyleSubset;
}
