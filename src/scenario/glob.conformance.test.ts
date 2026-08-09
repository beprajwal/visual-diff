/**
 * The scenario layer and the overlay engine each carry a URL-glob compiler:
 * `src/scenario/glob.ts` (validation — failure is data, with a message written for the author) and
 * `src/mocking/glob.ts` (matching — failure is an exception, with a message written for a run that
 * has already been validated). They were built concurrently, and they are kept apart because their
 * *messages* serve different readers.
 *
 * Their *semantics* must not differ by so much as one character. A glob that validates but matches
 * differently is the worst failure this feature has: mocking spec §8 is explicit that a user
 * looking at a screen they believe is the empty state, when a glob matched nothing, has been
 * actively misled. A glob that matched something *else* than the validator promised is the same
 * lie with more steps.
 *
 * So this file is the seam. Every pattern below goes through both compilers and both must agree on
 * whether it is legal, and — for a legal one — on every URL it does and does not match. Adding a
 * token to one compiler and not the other fails here, by name, with the pattern that diverged.
 *
 * The two error *messages* are deliberately not compared; only whether each compiler rejects.
 */

import { describe, expect, it } from 'vitest';

import { globMatches, parseGlob } from './glob.js';
import { matchesGlob, urlGlobError } from '../mocking/glob.js';

/** Every pattern shape either compiler understands, and the ones §8 says must be rejected. */
const PATTERNS = [
  // the spec's own rules (mocking spec §5)
  '**/v1/forecast**',
  '**/v1/search**',
  '**/v1/air-quality**',
  '**/analytics/**',
  '**',
  // wildcards
  '*',
  '?',
  'https://x.test/*',
  'https://x.test/**',
  'https://x.test/v?/forecast',
  'https://x.test/a?c',
  '**/v1/forecast',
  '/v1/forecast',
  'a*b',
  'a**b',
  'a***b',
  // classes
  '**/v[0-9]/forecast',
  '**/v[!0-9]/forecast',
  '**/v[^0-9]/forecast',
  '**/[]]',
  '**/[!]]',
  '**/[a\\-c]',
  '**/[a-c]',
  '**/[a\\]c]',
  '**/[\\^]',
  // alternation
  '**/v1/{forecast,air-quality}**',
  '**/{v1/{a,b},v2/c}',
  '**/a,b',
  '**/{a}',
  // escapes and regex metacharacters taken literally
  'https://x.test/\\*',
  'https://x.test/\\{a\\}',
  'https://x.test/a.b',
  'https://x.test/(a)+',
  '**?q=a|b',
  '**/Forecast',
  '**/$^+()|',
  // rejected by §8
  '',
  '**/v1/[forecast',
  '**/{a,b',
  '**/{a,{b,c}',
  '**/forecast}',
  '**/forecast\\',
  '**/[abc\\',
] as const;

/** URLs chosen to straddle every boundary the tokens above can draw. */
const URLS = [
  'https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.13&hourly=temperature_2m',
  'https://api.open-meteo.com/v1/forecast',
  'https://api.open-meteo.com/v1/air-quality',
  'https://geocoding-api.open-meteo.com/v1/search?name=lisbon',
  'https://x.test/analytics/collect',
  'https://x.test/a',
  'https://x.test/a/b/c',
  'https://x.test/a.b',
  'https://x.test/axb',
  'https://x.test/(a)+',
  'https://x.test/s?q=a|b',
  'https://x.test/*',
  'https://x.test/{a}',
  'https://x.test/v1/forecast?a=1',
  'https://x.test/v1/b',
  'https://x.test/v2/c',
  'https://x.test/v2/a',
  'https://x.test/v3/forecast',
  'https://x.test/vx/forecast',
  'https://x.test/v12/forecast',
  'https://x.test/-',
  'https://x.test/b',
  'https://x.test/]',
  'https://x.test/^',
  'https://x.test/a,b',
  'https://x.test/v1/Forecast',
  'https://x.test/v1/forecast',
  '',
  '/',
] as const;

describe('the two url-glob compilers agree (mocking spec §5, §8, §11)', () => {
  it.each(PATTERNS)('accepts or rejects %j identically', (pattern) => {
    const scenarioRejected = !parseGlob(pattern).ok;
    const mockingRejected = urlGlobError(pattern) !== null;
    expect(
      mockingRejected,
      `scenario/glob ${scenarioRejected ? 'rejects' : 'accepts'} ${JSON.stringify(pattern)}, ` +
        `mocking/glob ${mockingRejected ? 'rejects' : 'accepts'} it`,
    ).toBe(scenarioRejected);
  });

  it.each(PATTERNS)('matches the same urls with %j', (pattern) => {
    if (!parseGlob(pattern).ok) return;
    for (const url of URLS) {
      const byScenario = globMatches(pattern, url);
      const byMocking = matchesGlob(pattern, url);
      expect(
        byMocking,
        `${JSON.stringify(pattern)} vs ${JSON.stringify(url)}: scenario/glob says ` +
          `${byScenario}, mocking/glob says ${byMocking}`,
      ).toBe(byScenario);
    }
  });

  /**
   * The divergence this file was written after finding. `[a\-c]` escapes the hyphen to ask for a
   * literal one; a compiler that drops the escape silently reinstates the `a`-to-`c` range, so the
   * rule matches `b` — a URL its author explicitly wrote it not to match.
   */
  it('reads an escaped hyphen inside a class as a literal in both, not as a range', () => {
    expect(globMatches('**/[a\\-c]', 'https://x.test/-')).toBe(true);
    expect(matchesGlob('**/[a\\-c]', 'https://x.test/-')).toBe(true);
    expect(globMatches('**/[a\\-c]', 'https://x.test/b')).toBe(false);
    expect(matchesGlob('**/[a\\-c]', 'https://x.test/b')).toBe(false);
    // …while an unescaped hyphen is still a range in both.
    expect(globMatches('**/[a-c]', 'https://x.test/b')).toBe(true);
    expect(matchesGlob('**/[a-c]', 'https://x.test/b')).toBe(true);
  });

  it('rejects every §8 unparseable glob in both, with a message from each', () => {
    for (const pattern of ['', '**/v1/[forecast', '**/{a,b', '**/forecast}', '**/forecast\\']) {
      const parsed = parseGlob(pattern);
      expect(parsed.ok, `scenario/glob should reject ${JSON.stringify(pattern)}`).toBe(false);
      if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(0);
      expect(urlGlobError(pattern), `mocking/glob should reject ${JSON.stringify(pattern)}`)
        .not.toBeNull();
    }
  });
});
