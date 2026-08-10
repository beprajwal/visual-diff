/**
 * CSS selector syntax validation (variants spec §7 "unparseable selector", §9).
 *
 * §9 says selector matching "reuses the diff engine's selector support; anything it cannot
 * evaluate is a validation error, not a silent no-match (the failure mode already fixed once for
 * `diff.ignore`)". The *rule* is what matters there — never let a selector fail silently — and it
 * is applied here against the evaluator variants actually use. That evaluator is not
 * `diff/selector.ts`: rules are applied in-page, after the settle gate and before capture (§9), so
 * the thing that resolves `match` is the page's own `querySelectorAll`. `diff/selector.ts` matches
 * *captured* nodes offline and understands only simple compound selectors — it cannot evaluate
 * `[data-test=plan-card]:first-child`, which is the selector the spec's own §4 example clones with.
 *
 * So this file validates what a browser would accept, and rejects what it would throw on. It is a
 * syntax checker rather than a matcher: there is no DOM here, and there does not need to be.
 *
 * Failure is data, never an exception — {@link parseSelector} returns a reason written for the
 * person who typed the selector, which `validate.ts` turns into the `invalid-selector` issue, the
 * way `parseGlob` feeds `invalid-glob` in the scenario layer.
 */

/** Why a selector could not be parsed, and where. */
export interface SelectorFailure {
  ok: false;
  /** Reads as the tail of "invalid selector '…': <reason>". */
  reason: string;
  /** 0-based index into the selector of the character that could not be understood. */
  index: number;
}

export interface SelectorSuccess {
  ok: true;
  /** How many comma-separated selectors the list holds. */
  count: number;
  /**
   * Pseudo-elements found anywhere in the selector, e.g. `::before`, in source order and
   * de-duplicated. A pseudo-element is not an element: `querySelectorAll` can never return one, so
   * a rule whose selector names one is statically guaranteed to match nothing. Syntax is fine, so
   * this is reported rather than refused here, and `validate.ts` turns it into an error.
   */
  pseudoElements: string[];
}

export type SelectorParseResult = SelectorSuccess | SelectorFailure;

/** The combinators `querySelectorAll` understands, besides the descendant space. */
const COMBINATORS = new Set(['>', '+', '~']);

/** Functional pseudo-classes whose argument is itself a selector list. */
const SELECTOR_LIST_PSEUDOS = new Set(['not', 'is', 'where', 'matches', '-webkit-any', '-moz-any']);

/** Functional pseudo-classes whose argument is a selector list *relative* to the subject. */
const RELATIVE_PSEUDOS = new Set(['has']);

/** Functional pseudo-classes taking An+B, optionally followed by `of <selector list>`. */
const NTH_PSEUDOS = new Set([
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
  'nth-col',
  'nth-last-col',
]);

/** `2n + 1`, `odd`, `even`, `-3`, `n`, `+2n-1`. */
const NTH_RE = /^\s*(?:odd|even|[+-]?(?:\d+|\d*n(?:\s*[+-]\s*\d+)?))\s*$/i;

/** Written `::x` in modern CSS; these four are also legal with one colon, and mean the same. */
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/** The attribute operators CSS defines, longest first so `~=` is not read as `=`. */
const ATTR_OPERATORS = ['~=', '|=', '^=', '$=', '*=', '='];

/** Parse a CSS selector list, or explain why a browser would refuse it. */
export function parseSelector(selector: string): SelectorParseResult {
  return parseList(selector, 0, selector.length, false, true);
}

/** True when `querySelectorAll` would accept the selector. */
export function isValidSelector(selector: string): boolean {
  return parseSelector(selector).ok;
}

/* ------------------------------------------------------------------ list */

interface Context {
  text: string;
  pseudoElements: string[];
}

function parseList(
  text: string,
  start: number,
  end: number,
  relative: boolean,
  top: boolean,
): SelectorParseResult {
  const ctx: Context = { text, pseudoElements: [] };
  const result = parseListIn(ctx, start, end, relative, top);
  if (!result.ok) return result;
  return { ok: true, count: result.count, pseudoElements: ctx.pseudoElements };
}

interface ListOk {
  ok: true;
  count: number;
}

function parseListIn(
  ctx: Context,
  start: number,
  end: number,
  relative: boolean,
  top: boolean,
): ListOk | SelectorFailure {
  if (trimmedIsEmpty(ctx.text, start, end)) {
    return top
      ? { ok: false, reason: 'it is empty, so it matches nothing', index: start }
      : { ok: false, reason: 'it has an empty argument', index: start };
  }

  let i = start;
  let count = 0;
  for (;;) {
    const emptyAt = skipSpace(ctx.text, i, end);
    if (emptyAt < end && ctx.text[emptyAt] === ',') return emptyEntry(emptyAt);

    const complex = parseComplex(ctx, i, end, relative);
    if (!complex.ok) return complex;
    count += 1;
    i = complex.index;
    if (i >= end) return { ok: true, count };
    // parseComplex only ever stops at a top-level comma or at `end`.
    i += 1;
    if (trimmedIsEmpty(ctx.text, i, end)) return emptyEntry(i - 1);
  }
}

function emptyEntry(index: number): SelectorFailure {
  return {
    ok: false,
    reason:
      'a comma-separated selector list has an empty entry, so one of its selectors is missing',
    index,
  };
}

interface Cursor {
  ok: true;
  index: number;
}

/** One complex selector: compound (combinator compound)*, stopping at a top-level comma. */
function parseComplex(
  ctx: Context,
  start: number,
  end: number,
  relative: boolean,
): Cursor | SelectorFailure {
  let i = skipSpace(ctx.text, start, end);

  if (i < end && COMBINATORS.has(ctx.text[i] as string)) {
    const combinator = ctx.text[i] as string;
    if (!relative) {
      return {
        ok: false,
        reason: `it starts with the combinator '${combinator}', which has nothing on its left`,
        index: i,
      };
    }
    i = skipSpace(ctx.text, i + 1, end);
  }

  const first = parseCompound(ctx, i, end);
  if (!first.ok) return first;
  i = first.index;

  for (;;) {
    const afterSpace = skipSpace(ctx.text, i, end);
    const sawSpace = afterSpace > i;
    i = afterSpace;

    if (i >= end) return { ok: true, index: i };
    const ch = ctx.text[i] as string;
    if (ch === ',') return { ok: true, index: i };

    if (COMBINATORS.has(ch)) {
      const next = skipSpace(ctx.text, i + 1, end);
      if (next >= end || ctx.text[next] === ',') {
        return {
          ok: false,
          reason: `the combinator '${ch}' has nothing on its right`,
          index: i,
        };
      }
      const compound = parseCompound(ctx, next, end);
      if (!compound.ok) return compound;
      i = compound.index;
      continue;
    }

    if (!sawSpace) {
      return { ok: false, reason: unexpected(ch), index: i };
    }
    const compound = parseCompound(ctx, i, end);
    if (!compound.ok) return compound;
    i = compound.index;
  }
}

/* ------------------------------------------------------------------ compound */

/** `div`, `*`, `.card`, `[data-test=x]:first-child`, `#total.big`. */
function parseCompound(ctx: Context, start: number, end: number): Cursor | SelectorFailure {
  let i = start;
  let parsed = false;

  if (i < end && ctx.text[i] === '*') {
    i += 1;
    parsed = true;
  } else if (i < end && isIdentStart(ctx.text, i, end)) {
    i = readIdent(ctx.text, i, end);
    parsed = true;
  }

  if (i < end && ctx.text[i] === '|') {
    return {
      ok: false,
      reason:
        "namespaced selectors such as 'svg|circle' are not supported: write the local name on " +
        'its own',
      index: i,
    };
  }

  for (;;) {
    if (i >= end) break;
    const ch = ctx.text[i] as string;

    if (ch === '#' || ch === '.') {
      const nameStart = i + 1;
      if (nameStart >= end || !isIdentStart(ctx.text, nameStart, end)) {
        return {
          ok: false,
          reason:
            ch === '#'
              ? "'#' must be followed by an id, as in '#total'"
              : "'.' must be followed by a class name, as in '.card'",
          index: i,
        };
      }
      i = readIdent(ctx.text, nameStart, end);
      parsed = true;
      continue;
    }

    if (ch === '[') {
      const attr = parseAttribute(ctx.text, i, end);
      if (!attr.ok) return attr;
      i = attr.index;
      parsed = true;
      continue;
    }

    if (ch === ':') {
      const pseudo = parsePseudo(ctx, i, end);
      if (!pseudo.ok) return pseudo;
      i = pseudo.index;
      parsed = true;
      continue;
    }

    break;
  }

  if (!parsed) {
    const ch = start < end ? (ctx.text[start] as string) : undefined;
    return {
      ok: false,
      reason: ch === undefined ? 'it ends where a selector was expected' : unexpected(ch),
      index: start,
    };
  }
  return { ok: true, index: i };
}

/* ------------------------------------------------------------------ [attr] */

function parseAttribute(text: string, start: number, end: number): Cursor | SelectorFailure {
  let i = skipSpace(text, start + 1, end);

  if (i >= end) return unterminatedAttribute(start);
  if (text[i] === '|') {
    return {
      ok: false,
      reason:
        "namespaced attribute selectors such as '[xlink|href]' are not supported: write the " +
        'local name on its own',
      index: i,
    };
  }
  if (!isIdentStart(text, i, end)) {
    return {
      ok: false,
      reason:
        'an attribute selector needs an attribute name, as in [data-test=forecast-card]',
      index: i,
    };
  }
  i = readIdent(text, i, end);
  i = skipSpace(text, i, end);
  if (i >= end) return unterminatedAttribute(start);

  if (text[i] === ']') return { ok: true, index: i + 1 };

  const operator = ATTR_OPERATORS.find((candidate) => text.startsWith(candidate, i));
  if (operator === undefined) {
    return {
      ok: false,
      reason: `unknown attribute operator ${JSON.stringify(
        text.slice(i, Math.min(i + 2, end)),
      )}: CSS has =, ~=, |=, ^=, $= and *=`,
      index: i,
    };
  }
  i = skipSpace(text, i + operator.length, end);
  if (i >= end) return unterminatedAttribute(start);

  const quote = text[i];
  if (quote === '"' || quote === "'") {
    const closed = readString(text, i, end);
    if (closed === null) {
      return {
        ok: false,
        reason: `a quoted attribute value opened with ${quote} is never closed`,
        index: i,
      };
    }
    i = closed;
  } else if (isIdentStart(text, i, end)) {
    i = readIdent(text, i, end);
  } else {
    const raw = text.slice(i, indexOfClose(text, i, end));
    return {
      ok: false,
      reason:
        `the attribute value ${JSON.stringify(raw)} is not a CSS identifier, so a browser reads ` +
        `it as a syntax error — quote it, as in [data-test="${raw}"]`,
      index: i,
    };
  }

  i = skipSpace(text, i, end);
  if (i < end && /^[isIS]$/.test(text[i] as string)) {
    const after = skipSpace(text, i + 1, end);
    if (after < end && text[after] === ']') return { ok: true, index: after + 1 };
    return {
      ok: false,
      reason: `the only attribute-matching flags are 'i' and 's', and they come last`,
      index: i,
    };
  }
  if (i < end && text[i] === ']') return { ok: true, index: i + 1 };
  if (i >= end) return unterminatedAttribute(start);
  return {
    ok: false,
    reason: `the attribute selector has ${JSON.stringify(
      text.slice(i, indexOfClose(text, i, end)),
    )} after its value, where ']' was expected`,
    index: i,
  };
}

function unterminatedAttribute(start: number): SelectorFailure {
  return {
    ok: false,
    reason: "an attribute selector opened with '[' is never closed",
    index: start,
  };
}

function indexOfClose(text: string, from: number, end: number): number {
  const close = text.indexOf(']', from);
  return close === -1 || close > end ? end : close;
}

/* ------------------------------------------------------------------ :pseudo */

function parsePseudo(ctx: Context, start: number, end: number): Cursor | SelectorFailure {
  const { text } = ctx;
  let i = start + 1;
  let doubled = false;
  if (i < end && text[i] === ':') {
    doubled = true;
    i += 1;
  }
  if (i >= end || !isIdentStart(text, i, end)) {
    return {
      ok: false,
      reason: "':' must be followed by a pseudo-class name, as in ':first-child'",
      index: start,
    };
  }
  const nameStart = i;
  i = readIdent(text, i, end);
  const name = text.slice(nameStart, i).toLowerCase();

  if (doubled || LEGACY_PSEUDO_ELEMENTS.has(name)) {
    const spelling = `${doubled ? '::' : ':'}${name}`;
    if (!ctx.pseudoElements.includes(spelling)) ctx.pseudoElements.push(spelling);
  }

  if (i >= end || text[i] !== '(') return { ok: true, index: i };

  const close = matchParen(text, i, end);
  if (close === null) {
    return { ok: false, reason: `the argument of ':${name}(' is never closed`, index: i };
  }
  const argStart = i + 1;
  const argEnd = close;

  if (SELECTOR_LIST_PSEUDOS.has(name) || RELATIVE_PSEUDOS.has(name)) {
    const inner = parseListIn(ctx, argStart, argEnd, RELATIVE_PSEUDOS.has(name), false);
    if (!inner.ok) return prefixArgument(inner, name);
    return { ok: true, index: close + 1 };
  }

  if (NTH_PSEUDOS.has(name)) {
    const nth = parseNth(ctx, argStart, argEnd, name);
    if (!nth.ok) return nth;
    return { ok: true, index: close + 1 };
  }

  if (trimmedIsEmpty(text, argStart, argEnd)) {
    return { ok: false, reason: `':${name}()' has an empty argument`, index: i };
  }
  return { ok: true, index: close + 1 };
}

/** `2n + 1`, `odd`, and the `of <selector list>` form of `:nth-child`. */
function parseNth(
  ctx: Context,
  start: number,
  end: number,
  name: string,
): Cursor | SelectorFailure {
  const { text } = ctx;
  const arg = text.slice(start, end);
  const of = /\bof\b/i.exec(arg);

  if (of !== null) {
    const nth = arg.slice(0, of.index);
    if (!NTH_RE.test(nth)) return badNth(nth, name, start);
    const inner = parseListIn(ctx, start + of.index + of[0].length, end, false, false);
    if (!inner.ok) return prefixArgument(inner, name);
    return { ok: true, index: end };
  }

  if (!NTH_RE.test(arg)) return badNth(arg, name, start);
  return { ok: true, index: end };
}

function badNth(arg: string, name: string, index: number): SelectorFailure {
  return {
    ok: false,
    reason:
      `':${name}(${arg.trim()})' is not a valid position: it takes 'odd', 'even', a number, or ` +
      "an An+B expression such as '2n+1'",
    index,
  };
}

function prefixArgument(failure: SelectorFailure, name: string): SelectorFailure {
  return { ok: false, reason: `inside ':${name}(…)', ${failure.reason}`, index: failure.index };
}

/* ------------------------------------------------------------------ lexing */

function skipSpace(text: string, from: number, end: number): number {
  let i = from;
  while (i < end && /\s/.test(text[i] as string)) i += 1;
  return i;
}

function trimmedIsEmpty(text: string, from: number, end: number): boolean {
  return skipSpace(text, from, end) >= end;
}

/**
 * A CSS identifier starts with a letter, `_`, `-`, a non-ASCII character or a backslash escape —
 * the escape being how Tailwind-style class names such as `md\:flex` are written. A leading digit
 * is not an identifier, which is exactly why `[data-x=3]` has to be quoted.
 */
function isIdentStart(text: string, i: number, end: number): boolean {
  const ch = text[i];
  if (ch === undefined) return false;
  if (ch === '\\') return i + 1 < end;
  if (ch === '-') {
    const next = text[i + 1];
    if (next === undefined) return false;
    if (next === '-' || next === '\\') return true;
    return /[A-Za-z_\u00a0-\uffff]/.test(next);
  }
  return /[A-Za-z_\u00a0-\uffff]/.test(ch);
}

function readIdent(text: string, from: number, end: number): number {
  let i = from;
  while (i < end) {
    const ch = text[i] as string;
    if (ch === '\\') {
      if (i + 1 >= end) return i;
      i += 2;
      continue;
    }
    if (!/[A-Za-z0-9_\u002d\u00a0-\uffff]/.test(ch)) break;
    i += 1;
  }
  return i;
}

/** Index just past the closing quote, or null when the string is never closed. */
function readString(text: string, from: number, end: number): number | null {
  const quote = text[from];
  let i = from + 1;
  while (i < end) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return null;
}

/** Index of the `)` matching the `(` at `from`, honouring nesting and quotes. */
function matchParen(text: string, from: number, end: number): number | null {
  let depth = 0;
  let i = from;
  while (i < end) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const closed = readString(text, i, end);
      if (closed === null) return null;
      i = closed;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return null;
}

function unexpected(ch: string): string {
  return `the character ${JSON.stringify(ch)} cannot appear here`;
}
