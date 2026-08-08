/**
 * Capture (spec §7).
 *
 * Per step, per viewport, in one pass: a full-page screenshot, `dom.json` (visible nodes with a
 * stable path, tag, role, accessible name, text, bounding rect and the **fixed** style subset from
 * `types.ts#STYLE_PROPS`), and `a11y.json`.
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

/**
 * `a11y.json`, derived from the captured DOM.
 *
 * Playwright removed `page.accessibility` in 1.5x, and the diff engine derives every a11y finding
 * from `dom.json`'s role/name/aria attributes anyway (there is no spec decision on diffing the
 * accessibility tree itself). So the snapshot is the role/name tree implied by the captured nodes:
 * it is real captured data, not a stub, and it keeps the §6 file present for future work.
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
