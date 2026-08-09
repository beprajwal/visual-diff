/**
 * URL glob compilation (mocking spec §5 matching, §8 "unparseable glob", §11).
 *
 * §11 says to reuse "the same implementation as the existing `ignore` selectors where possible".
 * It is not possible: `diff/selector.ts` matches CSS compound selectors against captured DOM nodes
 * and has no glob in it at all. §11's fallback therefore applies — picomatch-style semantics, with
 * `**` crossing path separators — implemented here rather than taken as a dependency, for the same
 * reason merge patch and JSON Patch are (§11: every runtime dependency is downloaded by every
 * `npx` user).
 *
 * The supported vocabulary, deliberately small:
 *
 *   `*`        any run of characters except `/`
 *   `**`       any run of characters, `/` included
 *   `?`        exactly one character except `/`
 *   `[abc]`    one character from a set; `[a-z]` ranges; `[!abc]` / `[^abc]` negates
 *   `{a,b}`    alternation, nestable
 *   `\x`       the literal character `x`
 *
 * A glob is anchored: it must match the **whole** URL, query string included, which is why the
 * spec's examples are written `**​/v1/forecast**` rather than `/v1/forecast`. Matching is
 * case-sensitive; a URL path is.
 *
 * Failure is data, never an exception: {@link parseGlob} returns a message written for the person
 * who typed the glob, which `validate.ts` turns into the `invalid-glob` issue.
 */

/** Why a glob could not be compiled, and where. */
export interface GlobFailure {
  ok: false;
  /** Reads as the tail of "invalid url glob '…': <reason>". */
  reason: string;
  /** 0-based index into the glob of the character that could not be understood. */
  index: number;
}

export interface GlobSuccess {
  ok: true;
  /** The compiled, anchored regular expression. */
  regex: RegExp;
  /** Its source, without anchors — exported so tests can assert the translation directly. */
  source: string;
}

export type GlobParseResult = GlobSuccess | GlobFailure;

/** Characters that must be escaped to appear literally in a regular expression. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(text: string): string {
  return text.replace(REGEX_SPECIAL, '\\$&');
}

/**
 * Escapes a character for use inside a `[...]` regular-expression class. `-` is deliberately not
 * escaped: it is how a glob writes a range, which is the whole point of the class.
 */
function escapeClassChar(ch: string): string {
  return /[\\\]^]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Escapes a character that arrived **backslash-escaped** inside a class. Unlike
 * {@link escapeClassChar} this also escapes `-`, because `[a\-c]` is how a glob asks for a literal
 * hyphen; leaving it bare would silently turn it back into the `a`-to-`c` range the author escaped
 * it to avoid. `src/mocking/glob.ts` makes the same distinction, and `glob.conformance.test.ts`
 * holds the two to it.
 */
function escapeEscapedClassChar(ch: string): string {
  return ch === '-' ? '\\-' : escapeClassChar(ch);
}

/**
 * Translate a glob into an anchored regular expression, or explain why it cannot be translated.
 *
 * Only four things make a glob unparseable, and each names the character that caused it: an
 * unterminated `[`, an unterminated `{`, a `}` with no `{`, and a trailing `\` with nothing to
 * escape. Everything else is either a metacharacter or a literal.
 */
export function parseGlob(glob: string): GlobParseResult {
  if (glob === '') {
    return { ok: false, reason: 'it is empty, so it matches nothing', index: 0 };
  }

  let source = '';
  /** Open `{` positions, so an unterminated group can point at the one that opened it. */
  const groups: number[] = [];

  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;

    if (ch === '\\') {
      const next = glob[i + 1];
      if (next === undefined) {
        return {
          ok: false,
          reason:
            "it ends in a backslash: a backslash escapes the character after it, so it cannot be " +
            "the last character. Write '\\\\' for a literal backslash",
          index: i,
        };
      }
      source += escapeRegex(next);
      i += 1;
      continue;
    }

    if (ch === '*') {
      let end = i;
      while (glob[end + 1] === '*') end += 1;
      // `**` crosses path separators (§11); a single `*` stops at one.
      source += end > i ? '[\\s\\S]*' : '[^/]*';
      i = end;
      continue;
    }

    if (ch === '?') {
      source += '[^/]';
      continue;
    }

    if (ch === '[') {
      const parsed = parseCharClass(glob, i);
      if (!parsed.ok) return parsed;
      source += parsed.source;
      i = parsed.end;
      continue;
    }

    if (ch === '{') {
      groups.push(i);
      source += '(?:';
      continue;
    }

    if (ch === '}') {
      if (groups.length === 0) {
        return {
          ok: false,
          reason: "there is a '}' with no matching '{'. Escape it as '\\}' to match one literally",
          index: i,
        };
      }
      groups.pop();
      source += ')';
      continue;
    }

    // A comma only means alternation inside a `{…}` group; elsewhere it is an ordinary character,
    // which matters because commas are common in query strings.
    if (ch === ',' && groups.length > 0) {
      source += '|';
      continue;
    }

    source += escapeRegex(ch);
  }

  const unclosed = groups[groups.length - 1];
  if (unclosed !== undefined) {
    return {
      ok: false,
      reason: "there is a '{' with no matching '}'. Escape it as '\\{' to match one literally",
      index: unclosed,
    };
  }

  return { ok: true, source, regex: new RegExp(`^(?:${source})$`) };
}

interface ClassResult {
  ok: true;
  source: string;
  /** Index of the closing `]`. */
  end: number;
}

function parseCharClass(glob: string, start: number): ClassResult | GlobFailure {
  let i = start + 1;
  let negated = false;
  if (glob[i] === '!' || glob[i] === '^') {
    negated = true;
    i += 1;
  }

  // A `]` immediately after the opening bracket is a literal, as in POSIX and picomatch — which
  // is also why an empty class is not a case: `[]` opens a class whose first member is `]`.
  let body = '';
  if (glob[i] === ']') {
    body += '\\]';
    i += 1;
  }

  for (; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '\\') {
      const next = glob[i + 1];
      if (next === undefined) {
        return {
          ok: false,
          reason:
            "it ends in a backslash: a backslash escapes the character after it, so it cannot be " +
            "the last character. Write '\\\\' for a literal backslash",
          index: i,
        };
      }
      body += escapeEscapedClassChar(next);
      i += 1;
      continue;
    }
    if (ch === ']') {
      return { ok: true, source: `[${negated ? '^' : ''}${body}]`, end: i };
    }
    body += escapeClassChar(ch);
  }

  return {
    ok: false,
    reason: "there is a '[' with no matching ']'. Escape it as '\\[' to match one literally",
    index: start,
  };
}

/** Thrown by {@link compileGlob}; `parseGlob` is the non-throwing form the validator uses. */
export class GlobError extends Error {
  readonly glob: string;
  readonly index: number;

  constructor(glob: string, failure: GlobFailure) {
    super(`invalid glob ${JSON.stringify(glob)}: ${failure.reason}`);
    this.name = 'GlobError';
    this.glob = glob;
    this.index = failure.index;
  }
}

/**
 * Compile a glob that has already passed validation. Throws `GlobError` if it has not, which is a
 * programming error rather than a user one — every glob reaching the matcher came through
 * `validateScenarioSpec`.
 */
export function compileGlob(glob: string): RegExp {
  const parsed = parseGlob(glob);
  if (!parsed.ok) throw new GlobError(glob, parsed);
  return parsed.regex;
}

/** True when `value` matches `glob` in full. Returns false for a glob that does not compile. */
export function globMatches(glob: string, value: string): boolean {
  const parsed = parseGlob(glob);
  return parsed.ok && parsed.regex.test(value);
}
