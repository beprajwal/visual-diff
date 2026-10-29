/**
 * Reading a registry by its changed lines (selection spec D65, D66).
 *
 * A file every page imports — a feature-flag map, a stylesheet of component classes — would make
 * any edit to it replay every flow. Most edits add, rename or restyle a few names, and only the
 * files using those names can render differently. These functions find the names; when a changed
 * line cannot be pinned to one, they answer null and the file is handled whole.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import type { SelectRegistryRule } from '../types.js';

/** One added or removed line. `line` is its line number in the head file; a removed line takes the line it was removed before. */
export interface ChangedLine {
  text: string;
  line: number;
  /** `+` for an added line, `-` for a removed one. */
  side: '+' | '-';
}

const isQuiet = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed === '' || /^(\/\/|\/\*|\*)/.test(trimmed);
};

/**
 * The names a list edit touches, or null when a changed line is code the pattern does not describe.
 *
 * A match written identically on both sides is cancelled: a list kept on one line, rewritten
 * whole to add one key, touches that key and not the others on the line. A match that differs —
 * `ORDERS_V2: 'orders-v2'` becoming `ORDERS_V2: 'orders-next'` — contributes every capture, since
 * whatever reads `ORDERS_V2` now reads another value.
 */
export function registryNames(lines: readonly ChangedLine[], keys: string): string[] | null {
  const pattern = new RegExp(keys, 'g');
  const found: Array<{ side: '+' | '-'; text: string; names: string[] }> = [];
  for (const line of lines) {
    if (isQuiet(line.text)) continue;
    const matches = [...line.text.trim().matchAll(pattern)];
    if (matches.length === 0) return null;
    for (const match of matches) {
      const names = match.slice(1).filter((group): group is string => group !== undefined && group !== '');
      found.push({ side: line.side, text: match[0], names });
    }
  }
  const unmatched = [...found];
  for (const removed of found.filter((entry) => entry.side === '-')) {
    const twin = unmatched.findIndex((entry) => entry.side === '+' && entry.text === removed.text);
    if (twin === -1) continue;
    unmatched.splice(twin, 1);
    unmatched.splice(unmatched.indexOf(removed), 1);
  }
  return [...new Set(unmatched.flatMap((entry) => entry.names))].sort();
}

const CLASS = /\.(-?[_a-zA-Z][\w-]*)/g;

/**
 * The classes a selector names, each with its BEM block and element: a rule for
 * `.menu__item--active` can be written by code that only ever names `menu` — a library's class
 * prefix — so the shorter names are mentions too.
 */
const classesOf = (selector: string): string[] =>
  [...selector.matchAll(CLASS)].flatMap((match) => {
    const name = match[1] as string;
    const element = name.split('--')[0] as string;
    const block = element.split('__')[0] as string;
    return [...new Set([name, element, block])];
  });

/**
 * Whether an added line is code. Its line in the head file, with comments blanked, is empty when
 * it sits inside one. A removed line has no head line of its own, so it is code when it ends the
 * way a declaration or a selector does.
 */
const isCode = (changed: ChangedLine, blanked: readonly string[]): boolean => {
  if (isQuiet(changed.text)) return false;
  if (changed.side === '+') return (blanked[changed.line - 1] ?? changed.text).trim() !== '';
  return /[;{},]\s*$/.test(changed.text.trim());
};

/**
 * The name an at-rule defines for markup or other rules to use: `@keyframes pulse`,
 * Tailwind's `@custom-variant cell-active` and `@utility h-shell-*`. A `-*` utility is a family, so
 * its name keeps the trailing dash and is matched as a prefix (`h-shell-4`).
 */
const AT_NAME = /^@(?:keyframes|custom-variant|utility)\s+([\w-]+?)(-\*)?(?=[\s{(;]|$)/;

const atNameOf = (text: string): string[] => {
  const match = AT_NAME.exec(text.trim());
  if (match === null) return [];
  return [match[2] === undefined ? (match[1] as string) : `${match[1] as string}-`];
};

/** A selector or at-rule line written in the diff itself: `.badge,`, `.badge:hover {`, `@keyframes x {`. */
const isSelectorLine = (text: string): boolean => /\{\s*$|,\s*$/.test(text.trim()) && !/^@/.test(text.trim());

const namesOfScope = (selector: string): string[] => [...classesOf(selector), ...atNameOf(selector)];

/**
 * For each line of a stylesheet, the selectors of the rules it sits in, outermost first. Comments
 * are blanked first so a brace inside one does not open a rule.
 */
const blankComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));

export function enclosingSelectors(source: string): string[][] {
  const text = blankComments(source);
  const lines: string[][] = [[]];
  const stack: string[] = [];
  let pending = '';
  for (const character of text) {
    if (character === '\n') {
      lines.push([...stack]);
      pending += ' ';
      continue;
    }
    if (character === '{') {
      stack.push(pending.trim());
      pending = '';
      lines[lines.length - 1] = [...stack];
    } else if (character === '}') {
      stack.pop();
      pending = '';
    } else if (character === ';') {
      pending = '';
    } else {
      pending += character;
    }
  }
  return lines;
}

/**
 * The classes a stylesheet edit restyles, or null when a changed line sits only under rules with
 * no class — an element, `:root`, `@font-face` — which style every page that loads the sheet.
 */
export function cssNames(source: string, lines: readonly ChangedLine[]): string[] | null {
  const selectors = enclosingSelectors(source);
  const blanked = blankComments(source).split('\n');
  const names = new Set<string>();
  for (const changed of lines) {
    if (!isCode(changed, blanked)) continue;
    const own = [...(isSelectorLine(changed.text) ? classesOf(changed.text) : []), ...atNameOf(changed.text)];
    const around = (selectors[changed.line - 1] ?? []).flatMap(namesOfScope);
    if (own.length === 0 && around.length === 0) return null;
    for (const name of [...own, ...around]) names.add(name);
  }
  return [...names].sort();
}

/** The names an edit to a registry touches, or null to handle the file whole. */
export function resolveRegistry(
  root: string,
  file: string,
  rule: SelectRegistryRule,
  lines: readonly ChangedLine[],
): string[] | null {
  if (rule.css === true) {
    let source = '';
    try {
      source = readFileSync(path.join(root, file), 'utf8');
    } catch {
      // A deleted stylesheet: only the selectors the diff itself removed can name anything.
    }
    return cssNames(source, lines);
  }
  if (rule.keys === undefined) return null;
  return registryNames(lines, rule.keys);
}
