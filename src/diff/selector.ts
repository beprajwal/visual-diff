/**
 * Selector rendering and a deliberately small selector matcher.
 *
 * The engine never has a live DOM, so it cannot run `querySelectorAll`. It only needs to answer
 * "does this captured node match one of the config `ignore` selectors" (spec §8, noise control),
 * which in practice are simple compound selectors like `[data-test=session-id]` or `.clock`.
 * Combinators are not supported and are reported by {@link isSupportedSelector} so callers can
 * surface a warning rather than silently ignoring an entry.
 */

import type { DomNode } from '../types.js';

/** The best stable selector for a captured node, used in findings and feedback. */
export function selectorFor(node: DomNode): string {
  if (node.testId !== undefined && node.testId !== '') {
    const attr =
      node.attrs['data-test'] !== undefined
        ? 'data-test'
        : node.attrs['data-testid'] !== undefined
          ? 'data-testid'
          : node.attrs['data-test-id'] !== undefined
            ? 'data-test-id'
            : 'data-test';
    return `[${attr}="${node.testId}"]`;
  }
  const id = node.attrs.id;
  if (id !== undefined && id !== '') return `#${id}`;
  return node.path;
}

interface SimpleSelector {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
}

const SIMPLE = /^(?:[a-zA-Z][\w-]*)?(?:[#.][\w-]+|\[[^\]]+\])*$/;

export function isSupportedSelector(selector: string): boolean {
  const s = selector.trim();
  if (s === '') return false;
  return s.split(',').every((part) => SIMPLE.test(part.trim()) && part.trim() !== '');
}

/** The entries of a selector list this matcher cannot evaluate, in order, de-duplicated. */
export function unsupportedSelectors(selectors: readonly string[]): string[] {
  const out: string[] = [];
  for (const selector of selectors) {
    if (isSupportedSelector(selector)) continue;
    if (out.includes(selector)) continue;
    out.push(selector);
  }
  return out;
}

const IGNORE_HINT =
  'only simple compound selectors are evaluated (tag, #id, .class, [attr=value], ' +
  'and comma-separated lists of those) — combinators such as ">", "+", "~" and descendant ' +
  'spaces are not';

/**
 * Human-readable warnings for `diff.ignore` entries that match nothing because this matcher
 * cannot evaluate them. Silence here is the worst outcome: the user believes a noisy element is
 * covered and reads the resulting findings as real regressions.
 */
export function ignoreSelectorWarnings(selectors: readonly string[]): string[] {
  return unsupportedSelectors(selectors).map(
    (selector) =>
      `diff.ignore selector ${JSON.stringify(selector)} is not supported and matches nothing: ${IGNORE_HINT}`,
  );
}

function parseSimple(part: string): SimpleSelector | null {
  const sel: SimpleSelector = { classes: [], attrs: [] };
  let i = 0;
  const s = part.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(s);
  if (tag !== null) {
    sel.tag = tag[0].toLowerCase();
    i = tag[0].length;
  }
  while (i < s.length) {
    const c = s[i];
    if (c === '#' || c === '.') {
      const m = /^[\w-]+/.exec(s.slice(i + 1));
      if (m === null) return null;
      if (c === '#') sel.id = m[0];
      else sel.classes.push(m[0]);
      i += 1 + m[0].length;
      continue;
    }
    if (c === '[') {
      const end = s.indexOf(']', i);
      if (end === -1) return null;
      const body = s.slice(i + 1, end);
      const eq = body.indexOf('=');
      if (eq === -1) {
        sel.attrs.push({ name: body.trim() });
      } else {
        let value = body.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        sel.attrs.push({ name: body.slice(0, eq).trim().replace(/[~|^$*]$/, ''), value });
      }
      i = end + 1;
      continue;
    }
    return null;
  }
  return sel;
}

function attrValue(node: DomNode, name: string): string | undefined {
  const direct = (node.attrs as Record<string, string | undefined>)[name];
  if (direct !== undefined) return direct;
  if (name === 'role' && node.role !== undefined) return node.role;
  return undefined;
}

function matchesSimple(node: DomNode, sel: SimpleSelector): boolean {
  if (sel.tag !== undefined && node.tag.toLowerCase() !== sel.tag) return false;
  if (sel.id !== undefined && node.attrs.id !== sel.id) return false;
  if (sel.classes.length > 0) {
    const classes = (node.attrs.class ?? '').split(/\s+/).filter((c) => c !== '');
    if (!sel.classes.every((c) => classes.includes(c))) return false;
  }
  for (const a of sel.attrs) {
    const actual = attrValue(node, a.name);
    if (actual === undefined) return false;
    if (a.value !== undefined && actual !== a.value) return false;
  }
  return true;
}

/** Matches a captured node against a comma-separated list of simple compound selectors. */
export function matchesSelector(node: DomNode, selector: string): boolean {
  for (const part of selector.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const parsed = parseSimple(trimmed);
    if (parsed === null) continue;
    if (matchesSimple(node, parsed)) return true;
  }
  return false;
}

export function matchesAny(node: DomNode, selectors: readonly string[]): boolean {
  return selectors.some((s) => matchesSelector(node, s));
}
