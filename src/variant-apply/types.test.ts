/**
 * The seam between the variant *language* (`variant/`) and its *application* (here).
 *
 * Two modules own the two halves of one feature, so the contract between them is asserted rather
 * than assumed: a spec the parser accepts must be a spec this module can apply, and the defaults
 * the parser materializes must be the defaults this module falls back on. A drift between them
 * would not fail a type check anywhere — `plan.ts` deliberately takes a structural rule so a
 * hand-built one works — and would surface as a variant that renders differently depending on
 * whether it came from a file.
 */

import { describe, expect, it } from 'vitest';

import {
  CLONE_DEFAULTS,
  parseVariantSource,
  type VariantRule,
  type VariantSpec,
} from '../variant/index.js';
import { applyVariantInPage } from './inpage.js';
import {
  DEFAULT_CLONE_POSITION,
  DEFAULT_CLONE_TIMES,
  buildVariantApplyArgs,
  clonePlacement,
  variantVerbOf,
} from './plan.js';
import { asDocument, parseDocument } from './testdom.js';
import type { ApplicableRule, ExtractedClone } from './types.js';

/**
 * Compile-time contract: the parser's rule type is an applicable rule, and its spec's rule list is
 * what `buildVariantApplyArgs` takes. Without this, the two shapes could drift apart and only fail
 * at the one call site in the runner that joins them.
 */
const ruleIsApplicable: (rule: VariantRule) => ApplicableRule = (rule) => rule;
const specRulesAreApplicable: (spec: VariantSpec) => readonly ApplicableRule[] = (spec) => spec.rules;

const VARIANT_YAML = `version: 1
variant: denser-forecast
description: Tighter cards, air quality hidden, the chart promoted
rules:
  - id: tighter-cards
    match: "[data-test=forecast-card]"
    style: { padding: 8px, gap: 4px }

  - id: cta-copy
    match: "[data-test=save-cta]"
    text: Save this location

  - id: hide-air-quality
    match: "[data-test=air-quality]"
    hide: true

  - id: chart-first
    match: "[data-test=forecast-chart]"
    order: first

  - id: promote-upsell
    clone:
      from: { step: pricing, match: "[data-test=plan-card]" }
      into: "[data-test=sidebar]"
      position: prepend
      times: 2
`;

const PAGE = `<html>
  <body>
    <main data-test="dashboard">
      <section data-test="forecast-card" class="card">Mon</section>
      <section data-test="forecast-chart">chart</section>
      <section data-test="air-quality">AQI 42</section>
      <button data-test="save-cta">Save</button>
    </main>
    <aside data-test="sidebar"><h3>Nearby</h3></aside>
  </body>
</html>`;

const PLAN_CARD: ExtractedClone = {
  origin: "step 'pricing'",
  match: '[data-test=plan-card]',
  html: '<li data-test="plan-card">Pro</li>',
  styles: [],
  computed: {},
};

describe('the parser and the applier agree', () => {
  it('accepts a parsed spec as-is, with no translation layer between them', () => {
    expect(typeof ruleIsApplicable).toBe('function');
    expect(typeof specRulesAreApplicable).toBe('function');

    const parsed = parseVariantSource(VARIANT_YAML, { expectVariantName: 'denser-forecast' });
    expect(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.issues, null, 2)).toBe(true);
    if (!parsed.ok) return;

    const doc = parseDocument(PAGE);
    const report = applyVariantInPage(
      buildVariantApplyArgs({
        variant: parsed.value.variant,
        rules: parsed.value.rules,
        cloneSources: new Map([['promote-upsell', PLAN_CARD]]),
      }),
      asDocument(doc),
    );

    expect(report.rules.map((rule) => [rule.ruleId, rule.verb, rule.outcome])).toEqual([
      ['tighter-cards', 'style', 'applied'],
      ['cta-copy', 'text', 'applied'],
      ['hide-air-quality', 'hide', 'applied'],
      ['chart-first', 'order', 'applied'],
      ['promote-upsell', 'clone', 'applied'],
    ]);
    // Every verb of §4, over one document, straight out of the YAML of §4.
    expect(doc.querySelector('[data-test=forecast-card]')?.getAttribute('style')).toBe(
      'padding: 8px !important; gap: 4px !important;',
    );
    expect(doc.querySelector('[data-test=save-cta]')?.textContent).toBe('Save this location');
    expect(doc.querySelector('[data-test=air-quality]')?.getAttribute('style')).toBe(
      'display: none !important;',
    );
    expect(doc.querySelector('[data-test=dashboard]')?.firstElementChild?.getAttribute('data-test')).toBe(
      'forecast-chart',
    );
    expect(doc.querySelectorAll('[data-test=plan-card]').length).toBe(2);
  });

  it('reads the same verb out of a rule that the language does', () => {
    const parsed = parseVariantSource(VARIANT_YAML, { expectVariantName: 'denser-forecast' });
    if (!parsed.ok) throw new Error('fixture spec must parse');
    expect(parsed.value.rules.map((rule) => variantVerbOf(parsed.value.variant, rule))).toEqual([
      'style',
      'text',
      'hide',
      'order',
      'clone',
    ]);
  });

  it('falls back on exactly the clone defaults the parser materializes', () => {
    expect(DEFAULT_CLONE_TIMES).toBe(CLONE_DEFAULTS.times);
    expect(clonePlacement(CLONE_DEFAULTS.position)).toEqual(DEFAULT_CLONE_POSITION);
  });
});
