import { describe, expect, it } from 'vitest';

import { compileGlob, globMatcher, matchesGlob, urlGlobError, GlobSyntaxError } from './glob.js';

const FORECAST =
  'https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.13&hourly=temperature_2m';

describe('url glob semantics', () => {
  it("matches the spec's own rule patterns against full urls including the query string", () => {
    expect(matchesGlob('**/v1/forecast**', FORECAST)).toBe(true);
    expect(matchesGlob('**/v1/search**', 'https://geocoding-api.open-meteo.com/v1/search?name=lisbon')).toBe(
      true,
    );
    expect(matchesGlob('**/analytics/**', 'https://x.test/analytics/collect')).toBe(true);
    expect(matchesGlob('**/v1/forecast**', 'https://api.open-meteo.com/v1/air-quality')).toBe(false);
  });

  it('anchors: a pattern must match the whole url, not a substring of it', () => {
    expect(matchesGlob('/v1/forecast', 'https://api.open-meteo.com/v1/forecast')).toBe(false);
    expect(matchesGlob('**/v1/forecast', 'https://api.open-meteo.com/v1/forecast')).toBe(true);
    expect(matchesGlob('**/v1/forecast', `${FORECAST}`)).toBe(false);
  });

  it('crosses path separators with ** and refuses to with *', () => {
    expect(matchesGlob('https://x.test/**', 'https://x.test/a/b/c')).toBe(true);
    expect(matchesGlob('https://x.test/*', 'https://x.test/a/b/c')).toBe(false);
    expect(matchesGlob('https://x.test/*', 'https://x.test/a')).toBe(true);
    // A query string is not a path, so `*` happily crosses `?`, `&` and `=`.
    expect(matchesGlob('https://x.test/v1/forecast*', 'https://x.test/v1/forecast?a=1&b=2')).toBe(true);
  });

  it('matches exactly one non-separator character with ?', () => {
    expect(matchesGlob('https://x.test/v?/forecast', 'https://x.test/v1/forecast')).toBe(true);
    expect(matchesGlob('https://x.test/v?/forecast', 'https://x.test/v12/forecast')).toBe(false);
    expect(matchesGlob('https://x.test/a?c', 'https://x.test/a/c')).toBe(false);
  });

  it('supports character classes, negation and ranges', () => {
    expect(matchesGlob('**/v[0-9]/forecast', 'https://x.test/v3/forecast')).toBe(true);
    expect(matchesGlob('**/v[0-9]/forecast', 'https://x.test/vx/forecast')).toBe(false);
    expect(matchesGlob('**/v[!0-9]/forecast', 'https://x.test/vx/forecast')).toBe(true);
    expect(matchesGlob('**/v[^0-9]/forecast', 'https://x.test/v3/forecast')).toBe(false);
  });

  it('supports brace alternation, including nesting', () => {
    const pattern = '**/v1/{forecast,air-quality}**';
    expect(matchesGlob(pattern, 'https://x.test/v1/forecast?a=1')).toBe(true);
    expect(matchesGlob(pattern, 'https://x.test/v1/air-quality')).toBe(true);
    expect(matchesGlob(pattern, 'https://x.test/v1/search')).toBe(false);
    expect(matchesGlob('**/{v1/{a,b},v2/c}', 'https://x.test/v1/b')).toBe(true);
    expect(matchesGlob('**/{v1/{a,b},v2/c}', 'https://x.test/v2/c')).toBe(true);
    expect(matchesGlob('**/{v1/{a,b},v2/c}', 'https://x.test/v2/a')).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literals', () => {
    expect(matchesGlob('https://x.test/a.b', 'https://x.test/a.b')).toBe(true);
    expect(matchesGlob('https://x.test/a.b', 'https://x.test/axb')).toBe(false);
    expect(matchesGlob('https://x.test/(a)+', 'https://x.test/(a)+')).toBe(true);
    expect(matchesGlob('**?q=a|b', 'https://x.test/s?q=a|b')).toBe(true);
  });

  it('escapes a glob metacharacter with a backslash', () => {
    expect(matchesGlob('https://x.test/\\*', 'https://x.test/*')).toBe(true);
    expect(matchesGlob('https://x.test/\\*', 'https://x.test/anything')).toBe(false);
    expect(matchesGlob('https://x.test/\\{a\\}', 'https://x.test/{a}')).toBe(true);
    expect(matchesGlob('**/[a\\-c]', 'https://x.test/-')).toBe(true);
    expect(matchesGlob('**/[a\\-c]', 'https://x.test/b')).toBe(false);
  });

  it('is case sensitive, because a url path is', () => {
    expect(matchesGlob('**/Forecast', 'https://x.test/v1/Forecast')).toBe(true);
    expect(matchesGlob('**/Forecast', 'https://x.test/v1/forecast')).toBe(false);
  });
});

describe('unparseable globs (§8)', () => {
  it('names the pattern, the offending index and the fix for an unterminated class', () => {
    expect(urlGlobError('**/v1/[forecast')).toBe(
      "invalid url glob '**/v1/[forecast': unterminated character class starting at index 6 — " +
        "add a closing ']' or escape it as '\\['",
    );
  });

  it('reports an unterminated alternation', () => {
    expect(urlGlobError('**/{a,b')).toBe(
      "invalid url glob '**/{a,b': unterminated '{' alternation — add a closing '}' or escape it as '\\{'",
    );
    expect(urlGlobError('**/{a,{b,c}')).toBe(
      "invalid url glob '**/{a,{b,c}': unterminated '{' alternation — add a closing '}' or escape it as '\\{'",
    );
  });

  it('reports an unmatched closing brace', () => {
    expect(urlGlobError('**/forecast}')).toBe(
      "invalid url glob '**/forecast}': unmatched '}' at index 11 — open an alternation with '{' " +
        "or escape it as '\\}'",
    );
  });

  it('reports a trailing backslash', () => {
    expect(urlGlobError('**/forecast\\')).toBe(
      "invalid url glob '**/forecast\\': trailing backslash at index 11 — a backslash escapes the " +
        "character after it, so it cannot be last; write '\\\\' for a literal backslash",
    );
  });

  it('refuses an empty glob rather than compiling one that matches nothing', () => {
    expect(urlGlobError('')).toBe(
      "invalid url glob '': a url glob must not be empty — use '**' to match every request",
    );
  });

  it('accepts every pattern the spec uses', () => {
    for (const pattern of [
      '**/v1/forecast**',
      '**/v1/search**',
      '**/v1/air-quality**',
      '**/analytics/**',
      '**',
    ]) {
      expect(urlGlobError(pattern)).toBeNull();
    }
  });

  it('matches nothing rather than throwing when an invalid pattern reaches matchesGlob', () => {
    expect(matchesGlob('**/[unterminated', 'https://x.test/anything')).toBe(false);
  });

  it('throws a GlobSyntaxError from globMatcher, carrying the pattern and index', () => {
    expect(() => globMatcher('**/{a,b')).toThrow(GlobSyntaxError);
    try {
      globMatcher('**/{a,b');
      expect.unreachable('globMatcher should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(GlobSyntaxError);
      const glob = error as GlobSyntaxError;
      expect(glob.pattern).toBe('**/{a,b');
      expect(glob.index).toBe(3);
      expect(glob.message).toBe(urlGlobError('**/{a,b'));
    }
  });

  it('compiles a matcher once and reuses it', () => {
    const match = globMatcher('**/v1/forecast**');
    expect(match(FORECAST)).toBe(true);
    expect(match('https://x.test/v1/search')).toBe(false);
  });

  it('exposes the compiled regexp for callers that want to inspect it', () => {
    const compiled = compileGlob('a*b');
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.regex.source).toBe('^a[^/]*b$');
  });
});
