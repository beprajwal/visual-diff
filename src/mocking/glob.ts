/**
 * URL glob matching for scenario rule `match.url` (mocking spec §5, §11).
 *
 * The `ignore` selector matcher in `diff/selector.ts` is a CSS matcher, not a glob, so it cannot be
 * reused here; §11 falls through to "picomatch-style semantics with `**` crossing path separators".
 * That is what this file implements, deliberately small:
 *
 * | token | matches |
 * |---|---|
 * | `**` (two or more `*`) | any characters, including `/` |
 * | `*` | any characters except `/` |
 * | `?` | exactly one character other than `/` |
 * | `[abc]`, `[a-z]`, `[!abc]` | one character from a class |
 * | `{a,b}` | one of the alternatives, nestable |
 * | `\x` | the literal `x` |
 *
 * Matching is anchored (the whole URL must match), case-sensitive, and applied to the **full URL
 * including the query string** — `**\/v1/forecast**` is written with a trailing `**` precisely so it
 * survives `?latitude=…`. A pattern this compiler rejects is the "unparseable glob" of §8: the
 * message is user-facing, so it names the pattern, the offending index and the fix.
 */

/** Where a pattern stopped making sense, and what to do about it. */
export interface GlobCompileError {
  /** Sentence fragment: "unterminated character class starting at index 8 — …". */
  detail: string;
  /** 0-based index into the pattern. */
  index: number;
}

export type GlobCompileResult =
  | { ok: true; regex: RegExp }
  | { ok: false; error: GlobCompileError };

export class GlobSyntaxError extends Error {
  readonly pattern: string;
  readonly index: number;

  constructor(pattern: string, error: GlobCompileError) {
    super(globErrorMessage(pattern, error));
    this.name = 'GlobSyntaxError';
    this.pattern = pattern;
    this.index = error.index;
  }
}

/** `invalid url glob '…': unterminated character class starting at index 8 — …` */
export function globErrorMessage(pattern: string, error: GlobCompileError): string {
  return `invalid url glob '${pattern}': ${error.detail}`;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(text: string): string {
  return text.replace(REGEX_SPECIAL, '\\$&');
}

function fail(detail: string, index: number): GlobCompileResult {
  return { ok: false, error: { detail, index } };
}

/**
 * Compile a glob to an anchored regular expression, or explain why it cannot be compiled.
 *
 * `**` is treated as "any characters" wherever it appears rather than only as a whole path segment.
 * `**\/v1/forecast**` is the shape every scenario in the spec uses, and segment-only semantics would
 * make the trailing `**` (which must cross `?`, `=` and `&`) mean something different from the
 * leading one.
 */
export function compileGlob(pattern: string): GlobCompileResult {
  if (pattern === '') {
    return fail("a url glob must not be empty — use '**' to match every request", 0);
  }

  let out = '';
  let depth = 0;
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i] as string;

    if (char === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) {
        return fail(
          `trailing backslash at index ${i} — a backslash escapes the character after it, so it ` +
            "cannot be last; write '\\\\' for a literal backslash",
          i,
        );
      }
      out += escapeLiteral(next);
      i += 2;
      continue;
    }

    if (char === '*') {
      let stars = 0;
      while (pattern[i + stars] === '*') stars += 1;
      out += stars >= 2 ? '[\\s\\S]*' : '[^/]*';
      i += stars;
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (char === '[') {
      const compiled = compileClass(pattern, i);
      if (!compiled.ok) return compiled;
      out += compiled.source;
      i = compiled.next;
      continue;
    }

    if (char === '{') {
      out += '(?:';
      depth += 1;
      i += 1;
      continue;
    }

    if (char === ',' && depth > 0) {
      out += '|';
      i += 1;
      continue;
    }

    if (char === '}') {
      if (depth === 0) {
        return fail(
          `unmatched '}' at index ${i} — open an alternation with '{' or escape it as '\\}'`,
          i,
        );
      }
      out += ')';
      depth -= 1;
      i += 1;
      continue;
    }

    out += escapeLiteral(char);
    i += 1;
  }

  if (depth > 0) {
    return fail(
      `unterminated '{' alternation — add ${depth === 1 ? "a closing '}'" : `${depth} closing '}'`}` +
        " or escape it as '\\{'",
      pattern.lastIndexOf('{'),
    );
  }

  return { ok: true, regex: new RegExp(`^${out}$`) };
}

type ClassResult = { ok: true; source: string; next: number } | { ok: false; error: GlobCompileError };

function compileClass(pattern: string, start: number): ClassResult {
  let i = start + 1;
  let negated = false;
  if (pattern[i] === '!' || pattern[i] === '^') {
    negated = true;
    i += 1;
  }

  let body = '';
  // A ']' immediately after the (optional) negation is a literal, per POSIX bracket rules.
  if (pattern[i] === ']') {
    body += '\\]';
    i += 1;
  }

  while (i < pattern.length && pattern[i] !== ']') {
    const char = pattern[i] as string;
    if (char === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) break;
      // An escaped character is always literal, including '-', ']' and '^'.
      body += classLiteral(next);
      i += 2;
      continue;
    }
    body += classEscape(char);
    i += 1;
  }

  if (pattern[i] !== ']') {
    return {
      ok: false,
      error: {
        detail:
          `unterminated character class starting at index ${start} — add a closing ']' or escape ` +
          "it as '\\['",
        index: start,
      },
    };
  }

  return { ok: true, source: `[${negated ? '^' : ''}${body}]`, next: i + 1 };
}

/** Escapes a character for use inside a regex character class, leaving `-` free to form ranges. */
function classEscape(char: string): string {
  if (char === '\\' || char === ']' || char === '^') return `\\${char}`;
  return char;
}

/** Escapes a backslash-escaped character, which is literal even when it would form a range. */
function classLiteral(char: string): string {
  if (char === '-') return '\\-';
  return classEscape(char);
}

const cache = new Map<string, RegExp | null>();

function cached(pattern: string): RegExp | null {
  const hit = cache.get(pattern);
  if (hit !== undefined) return hit;
  const compiled = compileGlob(pattern);
  const regex = compiled.ok ? compiled.regex : null;
  cache.set(pattern, regex);
  return regex;
}

/** Compile once and reuse. Throws {@link GlobSyntaxError} for a pattern §8 would reject. */
export function globMatcher(pattern: string): (value: string) => boolean {
  const compiled = compileGlob(pattern);
  if (!compiled.ok) throw new GlobSyntaxError(pattern, compiled.error);
  const { regex } = compiled;
  return (value: string) => regex.test(value);
}

/** True when `value` matches. An uncompilable pattern matches nothing (it is rejected at §8). */
export function matchesGlob(pattern: string, value: string): boolean {
  const regex = cached(pattern);
  return regex !== null && regex.test(value);
}

/**
 * The user-facing message for an unparseable glob, or `null` when the pattern is fine. Exposed so
 * scenario validation (§8) and the engine report the same sentence.
 */
export function urlGlobError(pattern: string): string | null {
  const compiled = compileGlob(pattern);
  return compiled.ok ? null : globErrorMessage(pattern, compiled.error);
}
