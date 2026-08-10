/**
 * The pure half of the variant axis: how a run's variant is read off `meta.json`, and what a
 * selected pair *is* once variants are in play (variants spec §5, D24).
 *
 * The sentences are asserted verbatim. They are printed by the CLI and by the report, and the whole
 * point of the proposal wording is that it does not read as a warning — a change to it that made it
 * sound like one would pass a test that only checked "some string came back".
 */

import { describe, expect, it } from 'vitest';

import type { Revision } from '../types.js';
import {
  classifyVariantPair,
  describeVariantPair,
  identitySuffix,
  isEphemeralVariantRun,
  isKept,
  isVariantRun,
  sameRevision,
  showVariant,
  toVariantSummary,
  variantOf,
  verbOf,
  VARIANT_NONE,
} from './variant.js';

const clean: Revision = { sha: 'abc1234', ref: 'main', dirty: false };
const dirty = (dirtyHash: string): Revision => ({ ...clean, dirty: true, dirtyHash });

describe('variantOf', () => {
  it('reads a run written before this slice as having no variant', () => {
    expect(variantOf({ runId: '0001' })).toBe(VARIANT_NONE);
    expect(variantOf(null)).toBe(VARIANT_NONE);
    expect(variantOf(undefined)).toBe(VARIANT_NONE);
  });

  it('treats blank and non-string values as absence rather than as a variant', () => {
    expect(variantOf({ variant: '' })).toBe(VARIANT_NONE);
    expect(variantOf({ variant: '   ' })).toBe(VARIANT_NONE);
    expect(variantOf({ variant: 7 })).toBe(VARIANT_NONE);
  });

  it('returns the recorded name, trimmed', () => {
    expect(variantOf({ variant: 'denser-forecast' })).toBe('denser-forecast');
    expect(isVariantRun({ variant: 'denser-forecast' })).toBe(true);
    expect(isVariantRun({})).toBe(false);
  });
});

/**
 * `--keep` is the only thing that moves a proposal into the permanent timeline, so "is this run
 * hidden from `vdiff runs`" is a question about `kept`, not about `variant`.
 */
describe('isEphemeralVariantRun', () => {
  it('is true only for a variant run nobody promoted', () => {
    expect(isEphemeralVariantRun({ variant: 'denser-forecast' })).toBe(true);
    expect(isEphemeralVariantRun({ variant: 'denser-forecast', kept: true })).toBe(false);
    expect(isEphemeralVariantRun({ kept: true })).toBe(false);
    expect(isEphemeralVariantRun({})).toBe(false);
  });

  it('reads a missing `kept` as unpromoted', () => {
    expect(isKept({ variant: 'x' })).toBe(false);
    expect(isKept({ variant: 'x', kept: false })).toBe(false);
  });
});

describe('sameRevision', () => {
  it('is true for the same commit reached from two refs', () => {
    expect(sameRevision(clean, { ...clean, ref: 'feat/pay' })).toBe(true);
  });

  it('is false across commits', () => {
    expect(sameRevision(clean, { ...clean, sha: 'defc456' })).toBe(false);
  });

  /**
   * The point of the rule: "variant versus none at the same revision" only answers the proposal
   * question when both sides saw the same working tree. Two dirty runs whose trees differ are two
   * revisions wearing one sha.
   */
  it('is false for two dirty runs whose working trees differ', () => {
    expect(sameRevision(dirty('sha256:1111'), dirty('sha256:2222'))).toBe(false);
    expect(sameRevision(dirty('sha256:1111'), dirty('sha256:1111'))).toBe(true);
    expect(sameRevision(clean, dirty('sha256:1111'))).toBe(false);
  });
});

describe('classifyVariantPair', () => {
  const side = (variant: string | undefined, revision: Revision = clean) =>
    variant === undefined ? { revision } : { revision, variant };

  it('classifies the default variant comparison as the proposal, in either direction', () => {
    expect(classifyVariantPair(side(undefined), side('denser-forecast'))).toEqual({
      base: VARIANT_NONE,
      head: 'denser-forecast',
      sameRevision: true,
      label: 'variant-proposal',
    });
    expect(classifyVariantPair(side('denser-forecast'), side(undefined)).label).toBe(
      'variant-proposal',
    );
  });

  it('classifies two different variants as cross-variant', () => {
    expect(classifyVariantPair(side('a'), side('b')).label).toBe('cross-variant');
  });

  it('leaves a same-variant pair across revisions unlabelled — it is an ordinary regression', () => {
    const pair = classifyVariantPair(
      side('denser-forecast'),
      side('denser-forecast', { ...clean, sha: 'defc456' }),
    );
    expect(pair.label).toBeNull();
    expect(describeVariantPair(pair)).toBeNull();
  });

  it('leaves a pair with no variant at all unlabelled', () => {
    expect(classifyVariantPair(side(undefined), side(undefined)).label).toBeNull();
  });

  it('flags a variant pair that also spans revisions', () => {
    const pair = classifyVariantPair(
      side(undefined),
      side('denser-forecast', { ...clean, sha: 'defc456' }),
    );
    expect(pair).toMatchObject({ label: 'variant-across-revisions', sameRevision: false });
  });
});

describe('describeVariantPair', () => {
  it('states the proposal without a caveat, because it is the question being asked', () => {
    const pair = classifyVariantPair(
      { revision: clean },
      { revision: clean, variant: 'denser-forecast' },
    );
    expect(describeVariantPair(pair)).toBe(
      "proposal: variant 'denser-forecast' against the unmodified page at the same revision",
    );
  });

  it('says what a cross-variant pair actually compares', () => {
    const pair = classifyVariantPair(
      { revision: clean, variant: 'denser-forecast' },
      { revision: clean, variant: 'sidebar-upsell' },
    );
    expect(describeVariantPair(pair)).toBe(
      "cross-variant: base ran 'denser-forecast', head ran 'sidebar-upsell' —" +
        ' this compares two proposals, not two revisions',
    );
  });

  it('names the confound when the pair spans revisions', () => {
    const pair = classifyVariantPair(
      { revision: clean },
      { revision: { ...clean, sha: 'defc456' }, variant: 'denser-forecast' },
    );
    expect(describeVariantPair(pair)).toBe(
      "variant 'denser-forecast' ran on one side only, and the two runs are at different" +
        ' revisions — this mixes the proposal with the code change between them',
    );
  });
});

describe('output helpers', () => {
  it('renders the reserved name as an absence', () => {
    expect(showVariant(VARIANT_NONE)).toBe('no variant');
    expect(showVariant('denser-forecast')).toBe('denser-forecast');
  });

  it('names only the axes a run actually used', () => {
    expect(identitySuffix('none', VARIANT_NONE)).toBe('');
    expect(identitySuffix('empty-forecast', VARIANT_NONE)).toBe('  scenario empty-forecast');
    expect(identitySuffix('none', 'denser')).toBe('  variant denser');
    expect(identitySuffix('empty-forecast', 'denser')).toBe(
      '  scenario empty-forecast  variant denser',
    );
  });
});

describe('verbOf', () => {
  it('names the single verb a rule carries', () => {
    expect(verbOf({ id: 'a', match: '.a', hide: true })).toBe('hide');
    expect(verbOf({ id: 'b', match: '.b', order: 'first' })).toBe('order');
    expect(
      verbOf({
        id: 'c',
        clone: { from: { step: 's', match: '.x' }, into: '.y', position: 'append', times: 1 },
      }),
    ).toBe('clone');
  });

  it('names the rule when a verbless rule reaches it, rather than guessing one', () => {
    expect(() =>
      verbOf({ id: 'broken' } as unknown as Parameters<typeof verbOf>[0]),
    ).toThrow("variant rule 'broken' carries no verb");
  });
});

describe('toVariantSummary', () => {
  it('reports the store-relative path, which is what a report link resolves against', () => {
    expect(toVariantSummary({ version: 1, variant: 'denser-forecast', rules: [] }).path).toBe(
      'variants/denser-forecast.yaml',
    );
  });
});
