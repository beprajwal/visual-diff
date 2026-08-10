/**
 * Resolving a variant spec into the argument the page receives (variants spec §4, §7).
 *
 * The error messages are the feature's user interface, so they are asserted verbatim, exactly as
 * mocking §10.4 asserts the scenario validator's. "Two verbs on one rule" and "times below 1" are
 * §7 rejections that validation should catch first; these tests pin what happens when one gets
 * through, because the alternative — inventing a precedence, or silently cloning zero times — is a
 * variant that quietly is not the variant the user wrote.
 */

import { describe, expect, it } from 'vitest';

import { STYLE_PROPS } from '../types.js';
import { VariantError } from './errors.js';
import {
  CLONE_STYLE_PROPS,
  DEFAULT_CLONE_POSITION,
  DEFAULT_CLONE_TIMES,
  appliedRule,
  buildVariantApplyArgs,
  cloneExtractArgs,
  cloneOrigin,
  clonePlacement,
  cloneRuleIds,
  cssPropertyName,
  orderPlacement,
  styleDeclarations,
  variantVerbOf,
  verbsOf,
} from './plan.js';
import type { CloneSource } from '../variant/index.js';
import type { ExtractedClone, ApplicableRule } from './types.js';

const VARIANT = 'denser-forecast';

const SOURCE: ExtractedClone = {
  origin: "step 'pricing'",
  match: '[data-test=plan-card]',
  html: '<li data-test="plan-card">Pro</li>',
  styles: [],
  computed: {},
};

function resolve(rule: ApplicableRule, sources = new Map<string, ExtractedClone>()): unknown {
  return appliedRule(VARIANT, rule, sources);
}

function failure(rule: ApplicableRule, sources = new Map<string, ExtractedClone>()): VariantError {
  try {
    appliedRule(VARIANT, rule, sources);
  } catch (thrown) {
    if (VariantError.is(thrown)) return thrown;
    throw thrown;
  }
  throw new Error('expected the rule to be rejected');
}

describe('cssPropertyName', () => {
  it('translates camelCase to the dashed form setProperty takes', () => {
    expect(cssPropertyName('backgroundColor')).toBe('background-color');
    expect(cssPropertyName('borderTopWidth')).toBe('border-top-width');
  });

  it('leaves an already-dashed property alone', () => {
    expect(cssPropertyName(' padding ')).toBe('padding');
    expect(cssPropertyName('text-decoration-line')).toBe('text-decoration-line');
  });

  it('leaves a custom property exactly as written, because its case is meaningful', () => {
    expect(cssPropertyName('--Brand-Fg')).toBe('--Brand-Fg');
  });
});

describe('CLONE_STYLE_PROPS', () => {
  it('is the capture style subset, dashed, minus the layout-context properties', () => {
    expect(CLONE_STYLE_PROPS).toContain('background-color');
    expect(CLONE_STYLE_PROPS).toContain('font-family');
    expect(CLONE_STYLE_PROPS.length).toBe(STYLE_PROPS.length - 2);
  });

  it('leaves out position and z-index, which moving an element is expected to change', () => {
    expect(CLONE_STYLE_PROPS).not.toContain('position');
    expect(CLONE_STYLE_PROPS).not.toContain('z-index');
  });
});

describe('verbs', () => {
  it('reads the one verb a rule carries', () => {
    expect(variantVerbOf(VARIANT, { id: 'a', match: '.x', style: { padding: '8px' } })).toBe('style');
    expect(variantVerbOf(VARIANT, { id: 'a', match: '.x', text: 'hi' })).toBe('text');
    expect(variantVerbOf(VARIANT, { id: 'a', match: '.x', hide: true })).toBe('hide');
    expect(variantVerbOf(VARIANT, { id: 'a', match: '.x', order: 'first' })).toBe('order');
  });

  it('treats hide: false as no verb at all rather than as a hide that does nothing', () => {
    expect(verbsOf({ id: 'a', match: '.x', hide: false })).toEqual([]);
  });

  it('refuses a rule carrying no verb', () => {
    const error = failure({ id: 'quiet', match: '.x' });
    expect(error.message).toBe(
      "variant 'denser-forecast' rule 'quiet' carries no verb: exactly one of style, text, hide, " +
        'order, clone is required',
    );
    expect(error.code).toBe('variant-rule-no-verb');
    expect(error.exitCode).toBe(2);
    expect(error.kind).toBe('variant-invalid');
  });

  it('refuses a rule carrying two verbs rather than inventing a precedence', () => {
    const error = failure({ id: 'both', match: '.x', style: { padding: '8px' }, hide: true });
    expect(error.message).toBe(
      "variant 'denser-forecast' rule 'both' carries two verbs (style, hide): exactly one of " +
        'style, text, hide, order, clone is allowed',
    );
    expect(error.hint).toBe(
      'split the rule in two, each with its own id, rather than relying on an order of application',
    );
    expect(error.code).toBe('variant-rule-two-verbs');
  });

  it('refuses an element rule with no selector to apply to', () => {
    const error = failure({ id: 'nowhere', text: 'hi' });
    expect(error.message).toBe(
      "variant 'denser-forecast' rule 'nowhere' has no 'match': a text rule needs a selector " +
        'saying which elements it applies to',
    );
    expect(error.code).toBe('variant-rule-no-match');
  });
});

describe('style declarations', () => {
  it('dashes the names and stringifies the values, in author order', () => {
    expect(styleDeclarations({ paddingTop: '8px', opacity: 0.5 })).toEqual([
      { name: 'padding-top', value: '8px' },
      { name: 'opacity', value: '0.5' },
    ]);
  });
});

describe('placements', () => {
  it('reads every order form §4 allows', () => {
    expect(orderPlacement('first')).toEqual({ at: 'first' });
    expect(orderPlacement('last')).toEqual({ at: 'last' });
    expect(orderPlacement({ before: '.x' })).toEqual({ at: 'before', selector: '.x' });
    expect(orderPlacement({ after: '.x' })).toEqual({ at: 'after', selector: '.x' });
  });

  it('reads every clone position form, and appends when the rule does not say', () => {
    expect(clonePlacement('prepend')).toEqual({ at: 'prepend' });
    expect(clonePlacement({ after: '.x' })).toEqual({ at: 'after', selector: '.x' });
    expect(clonePlacement(undefined)).toEqual(DEFAULT_CLONE_POSITION);
    expect(DEFAULT_CLONE_POSITION).toEqual({ at: 'append' });
  });
});

describe('clone rules', () => {
  const rule: ApplicableRule = {
    id: 'promote-upsell',
    clone: { from: { step: 'pricing', match: '.plan' }, into: '[data-test=sidebar]' },
  };

  it('defaults to one copy, appended', () => {
    expect(resolve(rule, new Map([['promote-upsell', SOURCE]]))).toEqual({
      id: 'promote-upsell',
      verb: 'clone',
      clone: {
        into: '[data-test=sidebar]',
        position: { at: 'append' },
        times: DEFAULT_CLONE_TIMES,
        source: SOURCE,
      },
    });
  });

  it('refuses times below 1, which would be a rule that clones nothing', () => {
    const error = failure(
      { id: 'promote-upsell', clone: { ...rule.clone, times: 0 } as never },
      new Map([['promote-upsell', SOURCE]]),
    );
    expect(error.message).toBe(
      "variant 'denser-forecast' rule 'promote-upsell' has times: 0, which must be a whole number of 1 or more",
    );
    expect(error.code).toBe('variant-clone-times');
    expect(error.exitCode).toBe(2);
  });

  it('refuses a fractional times with the same message', () => {
    const error = failure(
      { id: 'promote-upsell', clone: { ...rule.clone, times: 1.5 } as never },
      new Map([['promote-upsell', SOURCE]]),
    );
    expect(error.message).toContain('has times: 1.5, which must be a whole number of 1 or more');
  });

  it('refuses to apply a clone whose source was never extracted (D23)', () => {
    const error = failure(rule);
    expect(error.message).toBe(
      "variant 'denser-forecast' rule 'promote-upsell' was applied before its clone source from " +
        "step 'pricing' had been extracted",
    );
    expect(error.hint).toBe(
      'clone sources are resolved before capture so a missing one fails fast rather than mid-run',
    );
    expect(error.exitCode).toBe(1);
  });

  it('names its source the way every message about it does', () => {
    expect(cloneOrigin({ step: 'pricing', match: '.plan' })).toBe("step 'pricing'");
    expect(cloneOrigin({ url: 'http://localhost:5173/pricing', match: '.plan' })).toBe(
      "url 'http://localhost:5173/pricing'",
    );
    // Neither `step` nor `url` is a validation error (§7); the fallback exists so a message about
    // a rule that got past validation still reads as a sentence.
    expect(cloneOrigin({ match: '.plan' } as CloneSource)).toBe('an unspecified source');
  });

  it('lists the rules whose sources have to be extracted before the run', () => {
    expect(
      cloneRuleIds([{ id: 'a', match: '.x', hide: true }, rule, { id: 'b', match: '.y', text: 'z' }]),
    ).toEqual(['promote-upsell']);
  });

  it('builds the extraction argument the source page is handed', () => {
    expect(cloneExtractArgs(VARIANT, rule)).toEqual({
      ruleId: 'promote-upsell',
      origin: "step 'pricing'",
      match: '.plan',
      styleProps: CLONE_STYLE_PROPS,
      excludeStyleIds: ['vdiff-determinism'],
    });
  });

  it('refuses to build an extraction argument for a rule that is not a clone', () => {
    let error: unknown;
    try {
      cloneExtractArgs(VARIANT, { id: 'tighter', match: '.x', style: { padding: '8px' } });
    } catch (thrown) {
      error = thrown;
    }
    expect((error as VariantError).message).toBe(
      "variant 'denser-forecast' rule 'tighter' is not a clone rule, so it has no source to extract",
    );
  });
});

describe('buildVariantApplyArgs', () => {
  it('resolves the whole spec into one JSON argument, rules in file order', () => {
    const args = buildVariantApplyArgs({
      variant: VARIANT,
      rules: [
        { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
        { id: 'chart-first', match: '[data-test=forecast-chart]', order: 'first' },
        {
          id: 'promote-upsell',
          clone: { from: { step: 'pricing', match: '.plan' }, into: '[data-test=sidebar]', times: 2 },
        },
      ],
      cloneSources: new Map([['promote-upsell', SOURCE]]),
    });

    expect(args.variant).toBe(VARIANT);
    expect(args.cloneStyleProps).toEqual(CLONE_STYLE_PROPS);
    expect(args.rules).toEqual([
      {
        id: 'tighter-cards',
        verb: 'style',
        match: '[data-test=forecast-card]',
        style: [{ name: 'padding', value: '8px' }],
      },
      { id: 'chart-first', verb: 'order', match: '[data-test=forecast-chart]', order: { at: 'first' } },
      {
        id: 'promote-upsell',
        verb: 'clone',
        clone: {
          into: '[data-test=sidebar]',
          position: { at: 'append' },
          times: 2,
          source: SOURCE,
        },
      },
    ]);
  });

  it('survives a JSON round trip, because that is what crossing into the page is', () => {
    const args = buildVariantApplyArgs({
      variant: VARIANT,
      rules: [{ id: 'hide-aq', match: '[data-test=air-quality]', hide: true }],
    });
    expect(JSON.parse(JSON.stringify(args))).toEqual(args);
  });
});
