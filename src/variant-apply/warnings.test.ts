/**
 * The warnings (variants spec §7).
 *
 * These messages are what stands between a user and a screenshot that is not what its label says.
 * They are asserted verbatim for the same reason mocking's never-matched warning is: the sentence
 * *is* the feature. A warning that says "1 rule had a problem" and stops has not warned anybody.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_REPORTED_STYLE_DIFFERENCES,
  appliedRuleIds,
  cloneStyleWarnings,
  revertedRuleIds,
  revertedRulesWarning,
  unmatchedRuleIds,
  unmatchedRulesWarning,
  variantHeld,
  variantWarnings,
} from './warnings.js';
import type { CloneStyleDifference, RuleResult, VariantApplyReport } from './types.js';

function report(rules: Array<Partial<RuleResult> & Pick<RuleResult, 'ruleId'>>): VariantApplyReport {
  return {
    variant: 'denser-forecast',
    stylesInjected: 0,
    attributions: [],
    rules: rules.map((rule) => ({
      verb: 'style',
      outcome: 'applied',
      matched: 1,
      changed: 1,
      verified: 1,
      ...rule,
    })),
  };
}

describe('rules that changed nothing', () => {
  it('is silent when every rule did something', () => {
    expect(unmatchedRulesWarning(report([{ ruleId: 'tighter-cards' }]))).toBeNull();
  });

  it('names the rule and says what the user is actually looking at', () => {
    const warning = unmatchedRulesWarning(
      report([
        {
          ruleId: 'tighter-cards',
          outcome: 'unmatched',
          matched: 0,
          changed: 0,
          verified: 0,
          detail: 'the selector matched no element',
        },
      ]),
    );
    expect(warning).toEqual({
      kind: 'variant-rule-unmatched',
      message:
        "variant 'denser-forecast': rule 'tighter-cards' (the selector matched no element) changed " +
        'nothing during this run — those parts of the page are the unmodified UI, so what was ' +
        'captured is not the proposal it is labelled as.',
      rules: ['tighter-cards'],
    });
  });

  it('lists every silent rule with its own reason when there are several', () => {
    const warning = unmatchedRulesWarning(
      report([
        { ruleId: 'tighter-cards', outcome: 'unmatched', detail: 'the selector matched no element' },
        {
          ruleId: 'chart-first',
          outcome: 'unmatched',
          detail: "before: '[data-test=nope]' matched no element this one could be moved next to",
        },
      ]),
    );
    expect(warning?.message).toBe(
      "variant 'denser-forecast': 2 rules changed nothing ('tighter-cards' (the selector matched " +
        "no element); 'chart-first' (before: '[data-test=nope]' matched no element this one could " +
        'be moved next to)) during this run — those parts of the page are the unmodified UI, so ' +
        'what was captured is not the proposal it is labelled as.',
    );
    expect(warning?.rules).toEqual(['tighter-cards', 'chart-first']);
  });
});

describe('the D22 reverted warning', () => {
  it('is silent when every rule was still holding at capture time', () => {
    expect(revertedRulesWarning(report([{ ruleId: 'tighter-cards' }]))).toBeNull();
  });

  it('says the change was made, that it was gone by capture, and why that matters', () => {
    const warning = revertedRulesWarning(
      report([
        {
          ruleId: 'tighter-cards',
          outcome: 'reverted',
          changed: 2,
          verified: 0,
          detail: '2 of 2 changed elements no longer carried the change when the page was captured',
        },
      ]),
    );
    expect(warning).toEqual({
      kind: 'variant-rule-reverted',
      message:
        "variant 'denser-forecast': rule 'tighter-cards' (2 of 2 changed elements no longer " +
        'carried the change when the page was captured) was applied but had been reverted before ' +
        'capture — the application re-rendered after the variant was applied, so the screenshot ' +
        'shows the unmodified UI for those elements. Rules are applied once, after the settle ' +
        'gate; a screen that keeps re-rendering past it cannot be varied this way.',
      rules: ['tighter-cards'],
    });
  });

  it('counts and names them when several rules were reverted', () => {
    const warning = revertedRulesWarning(
      report([
        { ruleId: 'tighter-cards', outcome: 'reverted', detail: '1 of 2 changed elements no longer carried the change when the page was captured' },
        { ruleId: 'cta-copy', outcome: 'reverted', detail: '1 of 1 changed elements no longer carried the change when the page was captured' },
      ]),
    );
    expect(warning?.message).toContain('2 rules were applied but had been reverted before capture');
    expect(warning?.rules).toEqual(['tighter-cards', 'cta-copy']);
  });
});

describe('the unstyled-clone warning', () => {
  function withDifferences(differences: CloneStyleDifference[]): VariantApplyReport {
    return report([
      {
        ruleId: 'promote-upsell',
        verb: 'clone',
        clone: {
          origin: "step 'pricing'",
          compared: 25,
          differences,
          material: differences.length > 0,
        },
      },
    ]);
  }

  it('is silent for a clone that renders the same at both ends', () => {
    expect(cloneStyleWarnings(withDifferences([]))).toEqual([]);
  });

  it('names the properties that differ and both their values', () => {
    const warnings = cloneStyleWarnings(
      withDifferences([{ property: 'font-family', source: 'Inter', target: 'Times' }]),
    );
    expect(warnings[0]?.message).toBe(
      "variant 'denser-forecast' rule 'promote-upsell': the element cloned from step 'pricing' " +
        'renders differently here than at its source — 1 of 25 compared style properties differ ' +
        "(font-family 'Inter' → 'Times'). An unstyled clone is a misleading preview, not a failed " +
        "one: check that the source page's injected styles reached this page.",
    );
  });

  it('counts the rest once it has named a few', () => {
    const differences: CloneStyleDifference[] = [
      { property: 'font-family', source: 'Inter', target: 'Times' },
      { property: 'padding', source: '24px', target: '0px' },
      { property: 'color', source: 'rgb(20, 20, 20)', target: 'rgb(0, 0, 0)' },
      { property: 'border-radius', source: '8px', target: '0px' },
      { property: 'box-shadow', source: '0 1px 2px #0002', target: 'none' },
    ];
    const warnings = cloneStyleWarnings(withDifferences(differences));
    expect(MAX_REPORTED_STYLE_DIFFERENCES).toBe(3);
    expect(warnings[0]?.message).toContain('5 of 25 compared style properties differ');
    expect(warnings[0]?.message).toContain(
      "font-family 'Inter' → 'Times', padding '24px' → '0px', color 'rgb(20, 20, 20)' → " +
        "'rgb(0, 0, 0)', and 2 more",
    );
  });

  it('raises one warning per clone rule, each naming its own rule', () => {
    const two = report([
      {
        ruleId: 'promote-upsell',
        verb: 'clone',
        clone: {
          origin: "step 'pricing'",
          compared: 25,
          differences: [{ property: 'padding', source: '24px', target: '0px' }],
          material: true,
        },
      },
      {
        ruleId: 'repeat-card',
        verb: 'clone',
        clone: {
          origin: "url 'http://localhost:5173/plans'",
          compared: 25,
          differences: [{ property: 'color', source: 'red', target: 'blue' }],
          material: true,
        },
      },
    ]);
    expect(cloneStyleWarnings(two).map((warning) => warning.rules)).toEqual([
      ['promote-upsell'],
      ['repeat-card'],
    ]);
  });
});

describe('the whole report', () => {
  const mixed = report([
    { ruleId: 'tighter-cards' },
    { ruleId: 'cta-copy', outcome: 'reverted', detail: 'gone' },
    { ruleId: 'chart-first', outcome: 'unmatched', detail: 'the selector matched no element' },
    {
      ruleId: 'promote-upsell',
      verb: 'clone',
      clone: {
        origin: "step 'pricing'",
        compared: 25,
        differences: [{ property: 'padding', source: '24px', target: '0px' }],
        material: true,
      },
    },
  ]);

  it('reports the three kinds in the order a reader should meet them', () => {
    expect(variantWarnings(mixed).map((warning) => warning.kind)).toEqual([
      'variant-rule-unmatched',
      'variant-rule-reverted',
      'variant-clone-unstyled',
    ]);
  });

  it('sorts the rules into the three outcomes', () => {
    expect(unmatchedRuleIds(mixed)).toEqual(['chart-first']);
    expect(revertedRuleIds(mixed)).toEqual(['cta-copy']);
    expect(appliedRuleIds(mixed)).toEqual(['tighter-cards', 'promote-upsell']);
  });

  it('says a variant held only when every rule of it did', () => {
    expect(variantHeld(mixed)).toBe(false);
    expect(variantHeld(report([{ ruleId: 'tighter-cards' }]))).toBe(true);
    expect(variantWarnings(report([{ ruleId: 'tighter-cards' }]))).toEqual([]);
  });
});
