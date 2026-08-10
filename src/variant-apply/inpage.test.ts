/**
 * Properties of the in-page functions themselves (variants spec §9).
 *
 * Two of them are load-bearing and invisible in the golden tests:
 *
 * 1. **They close over nothing.** Playwright serializes a function to source and evaluates it in
 *    the page, so a reference to anything outside the function — a module constant, an imported
 *    helper, a shared regex — is a `ReferenceError` at run time, in the browser, in the middle of a
 *    capture. The test re-evaluates each function from its own source in an empty scope, which is
 *    what `page.evaluate` does, and then uses it.
 * 2. **Everything they exchange is JSON.** The argument goes in over a process boundary and the
 *    report comes back over it.
 */

import { describe, expect, it } from 'vitest';

import { applyVariantInPage, extractCloneSourceInPage } from './inpage.js';
import { buildVariantApplyArgs, cloneExtractArgs } from './plan.js';
import { asDocument, parseDocument } from './testdom.js';
import {
  VARIANT_ATTRS,
  VARIANT_CLONE_ATTR,
  VARIANT_STYLE_ATTR,
  type CloneExtractArgs,
  type CloneExtractResult,
  type ExtractedClone,
  type VariantApplyArgs,
  type VariantApplyReport,
} from './types.js';

const PAGE = `<html>
  <head><style id="app">.card { padding: 16px; }</style></head>
  <body>
    <main data-test="dashboard">
      <section data-test="forecast-card" class="card">Mon</section>
      <div id="chart-host"><p>a</p><p>b</p></div>
    </main>
    <aside data-test="sidebar"></aside>
  </body>
</html>`;

/** Re-evaluate a function from its own source, in an empty scope, exactly as the page does. */
function serialized<T extends (...args: never[]) => unknown>(fn: T): T {
  return new Function(`return (${fn.toString()});`)() as T;
}

describe('serialization into the page', () => {
  it('applies a variant after a round trip through its own source', () => {
    const inPage = serialized(applyVariantInPage) as (
      args: VariantApplyArgs,
      doc: Document,
    ) => VariantApplyReport;
    const doc = parseDocument(PAGE);
    const args = buildVariantApplyArgs({
      variant: 'denser-forecast',
      rules: [
        { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
        { id: 'hide-chart', match: '#chart-host', hide: true },
      ],
    });

    const report = inPage(args, asDocument(doc));

    expect(report.rules.map((rule) => rule.outcome)).toEqual(['applied', 'applied']);
    expect(doc.querySelector('[data-test=forecast-card]')?.getAttribute('style')).toBe(
      'padding: 8px !important;',
    );
  });

  it('extracts a clone source after the same round trip', () => {
    const inPage = serialized(extractCloneSourceInPage) as (
      args: CloneExtractArgs,
      doc: Document,
    ) => CloneExtractResult;
    const doc = parseDocument(PAGE);

    const result = inPage(
      cloneExtractArgs('denser-forecast', {
        id: 'repeat-card',
        clone: { from: { step: 'dashboard', match: '[data-test=forecast-card]' }, into: '[data-test=sidebar]' },
      }),
      asDocument(doc),
    );

    expect(result.found).toBe(true);
    expect(result.html).toBe('<section data-test="forecast-card" class="card">Mon</section>');
    expect(result.computed.padding).toBe('16px');
  });

  it('spells the attribution attributes exactly as types.ts declares them', () => {
    const source = applyVariantInPage.toString();
    for (const attribute of [
      VARIANT_ATTRS.variant,
      VARIANT_ATTRS.rule,
      VARIANT_ATTRS.verb,
      VARIANT_STYLE_ATTR,
      VARIANT_CLONE_ATTR,
    ]) {
      // The literal, not the quoting: a bundler is free to re-quote the source it emits.
      expect(source).toContain(attribute);
    }
  });

  it('hands back a report that survives being JSON', () => {
    const doc = parseDocument(PAGE);
    const source: ExtractedClone = {
      origin: "step 'pricing'",
      match: '.plan',
      html: '<li class="plan">Pro</li>',
      styles: ['.plan { padding: 24px; }'],
      computed: { padding: '24px' },
    };
    const report = applyVariantInPage(
      buildVariantApplyArgs({
        variant: 'denser-forecast',
        rules: [
          { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
          {
            id: 'promote-upsell',
            clone: { from: { step: 'pricing', match: '.plan' }, into: '[data-test=sidebar]' },
          },
        ],
        cloneSources: new Map([['promote-upsell', source]]),
      }),
      asDocument(doc),
    );
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe('attribution targets', () => {
  function targets(match: string): string[] {
    const doc = parseDocument(PAGE);
    const report = applyVariantInPage(
      buildVariantApplyArgs({
        variant: 'denser-forecast',
        rules: [{ id: 'r', match, hide: true }],
      }),
      asDocument(doc),
    );
    return report.attributions.map((attribution) => attribution.target);
  }

  it('prefers the test id, as the diff engine does', () => {
    expect(targets('[data-test=forecast-card]')).toEqual(['[data-test="forecast-card"]']);
  });

  it('falls back to the id', () => {
    expect(targets('#chart-host')).toEqual(['#chart-host']);
  });

  it('falls back to a structural path, disambiguated by type', () => {
    expect(targets('#chart-host p')).toEqual([
      'html>body>main>div>p:nth-of-type(1)',
      'html>body>main>div>p:nth-of-type(2)',
    ]);
  });
});

describe('a selector the browser cannot evaluate', () => {
  it('says so rather than reporting a silent no-match', () => {
    const doc = parseDocument(PAGE);
    const report = applyVariantInPage(
      buildVariantApplyArgs({
        variant: 'denser-forecast',
        rules: [{ id: 'clever', match: 'section:has(> .card)', hide: true }],
      }),
      asDocument(doc),
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'unmatched', matched: 0, changed: 0 });
    expect(report.rules[0]?.detail).toBe(
      "the browser could not evaluate the selector 'section:has(> .card)'",
    );
  });
});
