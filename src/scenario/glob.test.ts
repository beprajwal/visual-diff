import { describe, expect, it } from 'vitest';
import { GlobError, compileGlob, globMatches, parseGlob } from './glob.js';

function reason(glob: string): string {
  const parsed = parseGlob(glob);
  if (parsed.ok) throw new Error(`expected ${JSON.stringify(glob)} to be rejected`);
  return parsed.reason;
}

function index(glob: string): number {
  const parsed = parseGlob(glob);
  if (parsed.ok) throw new Error(`expected ${JSON.stringify(glob)} to be rejected`);
  return parsed.index;
}

describe('parseGlob — semantics (mocking spec §11)', () => {
  it('anchors: a glob must match the whole URL, not a substring', () => {
    expect(globMatches('/v1/forecast', 'https://api.open-meteo.com/v1/forecast')).toBe(false);
    expect(globMatches('**/v1/forecast', 'https://api.open-meteo.com/v1/forecast')).toBe(true);
  });

  it('crosses path separators with ** and stops at them with *', () => {
    expect(globMatches('**/v1/forecast**', 'https://api.open-meteo.com/v1/forecast?lat=51.5')).toBe(
      true,
    );
    expect(globMatches('https://api.open-meteo.com/*', 'https://api.open-meteo.com/v1')).toBe(true);
    expect(globMatches('https://api.open-meteo.com/*', 'https://api.open-meteo.com/v1/forecast')).toBe(
      false,
    );
    expect(globMatches('https://api.open-meteo.com/**', 'https://api.open-meteo.com/v1/forecast')).toBe(
      true,
    );
  });

  it('applies to the full URL including the query string', () => {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=51.5&hourly=temperature_2m';
    expect(globMatches('https://api.open-meteo.com/v1/forecast?*latitude*', url)).toBe(true);
    expect(globMatches('https://api.open-meteo.com/v1/forecast?*longitude*', url)).toBe(false);
    expect(globMatches('**/v1/forecast', url)).toBe(false);
  });

  it('matches a single character with ?, but never a separator', () => {
    expect(globMatches('/v?/forecast', '/v1/forecast')).toBe(true);
    expect(globMatches('/v?/forecast', '/v12/forecast')).toBe(false);
    expect(globMatches('/a?c', '/a/c')).toBe(false);
  });

  it('supports character classes, ranges and negation', () => {
    expect(globMatches('/v[123]/x', '/v2/x')).toBe(true);
    expect(globMatches('/v[123]/x', '/v4/x')).toBe(false);
    expect(globMatches('/v[0-9]/x', '/v7/x')).toBe(true);
    expect(globMatches('/v[!0-9]/x', '/va/x')).toBe(true);
    expect(globMatches('/v[!0-9]/x', '/v7/x')).toBe(false);
    expect(globMatches('/v[^0-9]/x', '/v7/x')).toBe(false);
  });

  it('supports nested brace alternation, and treats a bare comma as a literal', () => {
    expect(globMatches('**/v1/{forecast,search}', 'https://x/v1/search')).toBe(true);
    expect(globMatches('**/v1/{forecast,search}', 'https://x/v1/air')).toBe(false);
    expect(globMatches('**/{v1,v2/{a,b}}/x', 'https://q/v2/b/x')).toBe(true);
    expect(globMatches('**?a,b', 'https://q?a,b')).toBe(true);
  });

  it('takes a backslash as an escape, so a metacharacter can be matched literally', () => {
    expect(globMatches('/a\\*b', '/a*b')).toBe(true);
    expect(globMatches('/a\\*b', '/axb')).toBe(false);
    expect(globMatches('/a\\{b\\}', '/a{b}')).toBe(true);
    expect(globMatches('/a\\[b', '/a[b')).toBe(true);
  });

  it('treats regex metacharacters in the URL as ordinary text', () => {
    expect(globMatches('/a.b', '/a.b')).toBe(true);
    expect(globMatches('/a.b', '/axb')).toBe(false);
    expect(globMatches('/price(1)+2', '/price(1)+2')).toBe(true);
    expect(globMatches('**/analytics/**', 'https://x/analytics/collect')).toBe(true);
  });

  it('matches case-sensitively, because a URL path is', () => {
    expect(globMatches('**/Forecast', 'https://x/Forecast')).toBe(true);
    expect(globMatches('**/Forecast', 'https://x/forecast')).toBe(false);
  });
});

describe('parseGlob — rejections (mocking spec §8, "unparseable glob")', () => {
  it('rejects an empty glob', () => {
    expect(reason('')).toBe('it is empty, so it matches nothing');
    expect(index('')).toBe(0);
  });

  it('names an unterminated character class and how to escape it', () => {
    expect(reason('**/v1/[abc')).toBe(
      "there is a '[' with no matching ']'. Escape it as '\\[' to match one literally",
    );
    expect(index('**/v1/[abc')).toBe(6);
  });

  it("treats a ']' straight after '[' as a literal, so '/a[]b' has no closing bracket", () => {
    expect(globMatches('/a[]x]b', '/a]b')).toBe(true);
    expect(reason('/a[]b')).toBe(
      "there is a '[' with no matching ']'. Escape it as '\\[' to match one literally",
    );
    expect(index('/a[]b')).toBe(2);
  });

  it('names an unterminated brace group and points at the brace that opened it', () => {
    expect(reason('**/{a,b')).toBe(
      "there is a '{' with no matching '}'. Escape it as '\\{' to match one literally",
    );
    expect(index('**/{a,b')).toBe(3);
    expect(index('**/{a,{b}')).toBe(3);
  });

  it('names a closing brace with nothing to close', () => {
    expect(reason('**/a}')).toBe(
      "there is a '}' with no matching '{'. Escape it as '\\}' to match one literally",
    );
    expect(index('**/a}')).toBe(4);
  });

  it('rejects a trailing backslash, inside a class or out of one', () => {
    const expected =
      'it ends in a backslash: a backslash escapes the character after it, so it cannot be the ' +
      "last character. Write '\\\\' for a literal backslash";
    expect(reason('**/a\\')).toBe(expected);
    expect(reason('**/[a\\')).toBe(expected);
  });

  it('never matches through a glob it could not compile', () => {
    expect(globMatches('[abc', '[abc')).toBe(false);
  });
});

describe('compileGlob', () => {
  it('returns an anchored regular expression', () => {
    const regex = compileGlob('**/v1/forecast**');
    expect(regex.source.startsWith('^')).toBe(true);
    expect(regex.source.endsWith('$')).toBe(true);
    expect(regex.test('https://x/v1/forecast?a=1')).toBe(true);
  });

  it('throws GlobError for a glob that validation would have rejected first', () => {
    expect(() => compileGlob('[abc')).toThrow(GlobError);
    expect(() => compileGlob('[abc')).toThrow(
      /^invalid glob "\[abc": there is a '\[' with no matching '\]'/,
    );
    try {
      compileGlob('a{b');
    } catch (error) {
      expect(error).toBeInstanceOf(GlobError);
      expect((error as GlobError).index).toBe(1);
      expect((error as GlobError).glob).toBe('a{b');
    }
  });
});
