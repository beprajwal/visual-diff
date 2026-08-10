/**
 * The report's half of the variant axis: folding a run's `variant.json` into the rows the page
 * annotates a step with, and recognising the three run warnings that say a capture is not the
 * proposal it is labelled as (variants spec §7).
 *
 * The fold is asserted rather than eyeballed because the file it reads is per *element*: one `style`
 * rule can touch forty cards, and the difference between "one row saying 40 elements" and "forty
 * identical rows" is the difference between a readable annotation and a wall.
 *
 * The tolerant reads are asserted against rows shaped like the ones on disk *before* this slice,
 * because that is the population most likely to be misread — and reading a pre-variant run as
 * anything but `none` would badge the entire regression history as proposals.
 */

import { describe, expect, it } from 'vitest';

import type { VariantReport } from '../runner/variant.js';
import {
  describeVariantHit,
  hasVariantAttribution,
  isEphemeralVariantRun,
  isKept,
  isVariantWarningKind,
  isVariantRun,
  summarizeVariantRun,
  VARIANT_NONE,
  VARIANT_WARNING_KINDS,
  variantOf,
  type VariantReportFile,
} from './variant.js';

function report(patch: Partial<VariantReportFile> = {}): VariantReportFile {
  return {
    variant: 'denser-forecast',
    file: '.visual-diff/variants/denser-forecast.yaml',
    rules: [],
    elements: [],
    ...patch,
  };
}

describe('summarizeVariantRun', () => {
  it('folds one rule’s forty elements into one row that counts them', () => {
    const elements = Array.from({ length: 40 }, (_, index) => ({
      step: 'forecast',
      viewport: '1280x800',
      target: `[data-test=forecast-card]:nth-child(${index + 1})`,
      ruleId: 'tighter-cards',
      verb: 'style' as const,
    }));

    const attribution = summarizeVariantRun(
      'forecast',
      '0007',
      'denser-forecast',
      report({ elements }),
    );

    expect(attribution.steps).toHaveLength(1);
    expect(attribution.steps[0]?.rules).toEqual([
      {
        variant: 'denser-forecast',
        ruleId: 'tighter-cards',
        verb: 'style',
        elements: 40,
        viewports: ['1280x800'],
      },
    ]);
    expect(describeVariantHit(attribution.steps[0]?.rules[0]!)).toBe(
      '40 elements modified by denser-forecast rule tighter-cards',
    );
  });

  it('keeps one row per rule *and* verb, so no row claims a change it did not make', () => {
    const attribution = summarizeVariantRun(
      'forecast',
      '0007',
      'denser-forecast',
      report({
        elements: [
          { step: 'home', viewport: '1280x800', target: 'a', ruleId: 'r', verb: 'style' },
          { step: 'home', viewport: '1280x800', target: 'a', ruleId: 'r', verb: 'hide' },
        ],
      }),
    );

    expect(attribution.steps[0]?.rules.map((hit) => hit.verb)).toEqual(['style', 'hide']);
  });

  it('groups by step in the order the elements appear, and lists the viewports each was seen in', () => {
    const attribution = summarizeVariantRun(
      'forecast',
      '0007',
      'denser-forecast',
      report({
        elements: [
          { step: 'forecast', viewport: '1280x800', target: 'a', ruleId: 'tighter', verb: 'style' },
          { step: 'home', viewport: '1280x800', target: 'b', ruleId: 'tighter', verb: 'style' },
          { step: 'forecast', viewport: '390x844', target: 'a', ruleId: 'tighter', verb: 'style' },
        ],
      }),
    );

    expect(attribution.steps.map((step) => step.step)).toEqual(['forecast', 'home']);
    expect(attribution.steps[0]?.rules[0]?.viewports).toEqual(['1280x800', '390x844']);
    expect(attribution.steps[0]?.rules[0]?.elements).toBe(2);
  });

  /**
   * The two silent failures, carried separately so the page can say *which* happened. A rule that
   * matched nothing has no step to annotate, and a reverted one annotated a step it no longer
   * changes — neither may appear as a step row claiming a modification that is not in the picture.
   */
  it('separates rules that matched nothing from rules reverted before capture (D22)', () => {
    const attribution = summarizeVariantRun(
      'forecast',
      '0007',
      'denser-forecast',
      report({
        rules: [
          { ruleId: 'tighter-cards', verb: 'style', outcome: 'applied', matched: 12, changed: 12, verified: 12 },
          { ruleId: 'hide-air-quality', verb: 'hide', outcome: 'unmatched', matched: 0, changed: 0, verified: 0 },
          { ruleId: 'chart-first', verb: 'order', outcome: 'reverted', matched: 1, changed: 1, verified: 0 },
        ],
      }),
    );

    expect(attribution.unmatchedRules).toEqual(['hide-air-quality']);
    expect(attribution.revertedRules).toEqual(['chart-first']);
    expect(attribution.steps).toEqual([]);
  });

  it('reads a run with no variant.json as having nothing to attribute, not as an error', () => {
    const attribution = summarizeVariantRun('forecast', '0003', VARIANT_NONE, null);
    expect(attribution).toEqual({
      flow: 'forecast',
      runId: '0003',
      variant: VARIANT_NONE,
      steps: [],
      unmatchedRules: [],
      revertedRules: [],
    });
    expect(hasVariantAttribution(attribution)).toBe(false);
    expect(hasVariantAttribution(null)).toBe(false);
  });

  /** A wrong attribution is worse than a missing one: an element with no rule id names nobody. */
  it('drops a malformed element record rather than attributing it to something', () => {
    const attribution = summarizeVariantRun(
      'forecast',
      '0007',
      'denser-forecast',
      report({
        elements: [
          { step: 'home', viewport: '1280x800', target: 'a', ruleId: 'real', verb: 'hide' },
          { viewport: '1280x800', target: 'b', verb: 'hide' },
          null,
        ] as unknown as VariantReportFile['elements'],
      }),
    );

    expect(attribution.steps).toHaveLength(1);
    expect(attribution.steps[0]?.rules.map((hit) => hit.ruleId)).toEqual(['real']);
  });

  it('survives a truncated variant.json whose arrays are not arrays', () => {
    const attribution = summarizeVariantRun('forecast', '0007', 'denser-forecast', {
      variant: 'denser-forecast',
      file: 'variants/denser-forecast.yaml',
      rules: undefined,
      elements: undefined,
    } as unknown as VariantReportFile);

    expect(attribution.steps).toEqual([]);
    expect(attribution.unmatchedRules).toEqual([]);
    expect(hasVariantAttribution(attribution)).toBe(true);
  });
});

describe('describeVariantHit', () => {
  /** Spec §7 fixes the wording, and it is the same sentence for every verb so it stays scannable. */
  it('prints the spec’s sentence, singular for one element', () => {
    expect(
      describeVariantHit({
        variant: 'denser-forecast',
        ruleId: 'tighter-cards',
        verb: 'style',
        elements: 1,
        viewports: ['1280x800'],
      }),
    ).toBe('element modified by denser-forecast rule tighter-cards');
  });
});

describe('variant run warnings', () => {
  it('recognises the three kinds a variant run can carry, and nothing else', () => {
    expect([...VARIANT_WARNING_KINDS]).toEqual([
      'variant-rule-unmatched',
      'variant-rule-reverted',
      'variant-clone-unstyled',
    ]);
    expect(isVariantWarningKind('variant-rule-reverted')).toBe(true);
    expect(isVariantWarningKind('scenario-rule-unmatched')).toBe(false);
    expect(isVariantWarningKind('har-miss')).toBe(false);
  });
});

describe('reading the variant axis off a timeline row', () => {
  it('reads a row written before this slice as having no variant and no promotion', () => {
    const legacy = { runId: '0003', scenario: 'none' };
    expect(variantOf(legacy)).toBe(VARIANT_NONE);
    expect(isVariantRun(legacy)).toBe(false);
    expect(isKept(legacy)).toBe(false);
    expect(isEphemeralVariantRun(legacy)).toBe(false);
  });

  it('distinguishes a promoted proposal from an exploratory one (D24)', () => {
    expect(isEphemeralVariantRun({ variant: 'denser-forecast' })).toBe(true);
    expect(isEphemeralVariantRun({ variant: 'denser-forecast', kept: true })).toBe(false);
  });
});

/* ------------------------------------------------------------------ the on-disk contract */

/**
 * `variant.json` is a *file format* shared by two modules that never call each other: the runner
 * writes it, the report reads it, and the store between them is the interface (spec §5). Nothing
 * else makes that checkable — a renamed field would compile on both sides and simply produce an
 * empty annotation, which looks exactly like a variant that changed nothing.
 *
 * So the runner's own type is imported (as a *type*, erased at runtime, so no report code depends
 * on the runner) and assigned to the shape this module reads. A rename, a narrowing or a dropped
 * field on either side stops the typecheck instead of silently emptying the report.
 */
describe('variant.json, as the runner writes it', () => {
  it('is readable by the shape this module declares', () => {
    const asRead: (written: VariantReport) => VariantReportFile = (written) => written;
    expect(typeof asRead).toBe('function');
  });

  /**
   * `unmatched` is a verdict, not a count. A rule whose selector matched forty cards and changed
   * none of them — a declaration the browser refused, a reference element that was not there —
   * still carries `matched: 40`, and reading the count would report it as having worked.
   */
  it('reads the verification verdict rather than inferring one from the counts', () => {
    const attribution = summarizeVariantRun(
      'forecast',
      '0007',
      'denser-forecast',
      report({
        rules: [
          {
            ruleId: 'tighter-cards',
            verb: 'style',
            outcome: 'unmatched',
            matched: 40,
            changed: 0,
            verified: 0,
            detail: 'the browser refused every declaration',
          },
          {
            ruleId: 'chart-first',
            verb: 'order',
            outcome: 'reverted',
            matched: 1,
            changed: 1,
            verified: 0,
          },
          {
            ruleId: 'hide-air-quality',
            verb: 'hide',
            outcome: 'applied',
            matched: 1,
            changed: 1,
            verified: 1,
          },
        ],
      }),
    );

    expect(attribution.unmatchedRules).toEqual(['tighter-cards']);
    expect(attribution.revertedRules).toEqual(['chart-first']);
  });
});
