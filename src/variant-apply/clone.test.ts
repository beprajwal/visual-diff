/**
 * Cross-page cloning (variants spec §8.4): extraction at the source, insertion at the target, and
 * the check that the clone still looks like itself once it gets there.
 *
 * The property under test is §4's: **an unstyled clone is a misleading preview, not a failed one.**
 * It renders. It looks like something a decision can be made from. And a component whose CSS-in-JS
 * rules were injected when it mounted on the pricing page has none of them on the dashboard, so
 * what is shown is the component's markup wearing the wrong clothes. Carrying the source page's
 * injected `<style>` elements is the fix; comparing computed styles at both ends is how the tool
 * finds out whether the fix worked this time.
 */

import { describe, expect, it } from 'vitest';

import { VariantError } from './errors.js';
import { applyVariantInPage, extractCloneSourceInPage } from './inpage.js';
import { CLONE_STYLE_PROPS, buildVariantApplyArgs, cloneExtractArgs, cloneSourceFrom } from './plan.js';
import { asDocument, parseDocument, type TestDocument } from './testdom.js';
import { cloneStyleWarnings } from './warnings.js';
import type { ExtractedClone, VariantApplyReport, ApplicableRule } from './types.js';

const VARIANT = 'promote-plans';

/** The source route: a pricing page whose plan cards are styled by an injected stylesheet. */
const PRICING = `<html>
  <head>
    <style id="vdiff-determinism">*{animation:none!important}</style>
    <style data-emotion="css">.plan { padding: 24px; font-family: Inter; color: rgb(20, 20, 20); }</style>
  </head>
  <body>
    <ul data-test="plans">
      <li data-test="plan-card" class="plan">Pro</li>
      <li data-test="plan-card" class="plan">Team</li>
    </ul>
  </body>
</html>`;

/** The target route: the dashboard, which knows nothing about `.plan`. */
const DASHBOARD = `<html>
  <head><style id="app">.aside { font-family: Georgia; }</style></head>
  <body>
    <main data-test="dashboard"><section data-test="forecast-card">Mon</section></main>
    <aside data-test="sidebar" class="aside"><h3>Nearby</h3></aside>
  </body>
</html>`;

const CLONE_RULE: ApplicableRule = {
  id: 'promote-upsell',
  clone: {
    from: { step: 'pricing', match: '[data-test=plan-card]:first-child' },
    into: '[data-test=sidebar]',
    position: 'prepend',
  },
};

function extract(page: string, match = '[data-test=plan-card]:first-child'): ExtractedClone {
  const source = parseDocument(page);
  const extracted = extractCloneSourceInPage(
    cloneExtractArgs(VARIANT, {
      id: 'promote-upsell',
      clone: { from: { step: 'pricing', match }, into: '[data-test=sidebar]' },
    }),
    asDocument(source),
  );
  return cloneSourceFrom(VARIANT, extracted);
}

function insert(source: ExtractedClone): { doc: TestDocument; report: VariantApplyReport } {
  const doc = parseDocument(DASHBOARD);
  const args = buildVariantApplyArgs({
    variant: VARIANT,
    rules: [CLONE_RULE],
    cloneSources: new Map([['promote-upsell', source]]),
  });
  return { doc, report: applyVariantInPage(args, asDocument(doc)) };
}

describe('extraction at the source', () => {
  it('takes the element and the page styles that make it look like itself', () => {
    const source = extract(PRICING);
    expect(source.origin).toBe("step 'pricing'");
    expect(source.html).toBe('<li data-test="plan-card" class="plan">Pro</li>');
    expect(source.styles).toEqual([
      '.plan { padding: 24px; font-family: Inter; color: rgb(20, 20, 20); }',
    ]);
    expect(source.computed).toMatchObject({
      padding: '24px',
      'font-family': 'Inter',
      color: 'rgb(20, 20, 20)',
    });
    expect(Object.keys(source.computed)).toEqual([...CLONE_STYLE_PROPS]);
  });

  it("leaves the runner's own determinism stylesheet behind rather than doubling it", () => {
    const source = extract(PRICING);
    expect(source.styles.join('')).not.toContain('animation:none');
  });

  it('de-duplicates identical stylesheets, which a bundler happily emits twice', () => {
    const doubled = PRICING.replace(
      '</head>',
      '<style data-emotion="css">.plan { padding: 24px; font-family: Inter; color: rgb(20, 20, 20); }</style></head>',
    );
    expect(extract(doubled).styles.length).toBe(1);
  });

  it('fails the run naming the rule when the source matched nothing', () => {
    let error: unknown;
    try {
      extract(PRICING, '[data-test=enterprise-card]');
    } catch (thrown) {
      error = thrown;
    }
    expect(VariantError.is(error)).toBe(true);
    expect((error as VariantError).message).toBe(
      "variant 'promote-plans' rule 'promote-upsell' could not extract its clone source from " +
        "step 'pricing': no element matched '[data-test=enterprise-card]'",
    );
    expect((error as VariantError).hint).toBe(
      'a clone can only copy an element the application already rendered — check the source ' +
        'selector and that the step renders it',
    );
    expect((error as VariantError).code).toBe('variant-clone-source-empty');
    expect((error as VariantError).exitCode).toBe(1);
  });

  it('says the selector could not be evaluated rather than reporting a silent no-match', () => {
    const source = parseDocument(PRICING);
    const extracted = extractCloneSourceInPage(
      cloneExtractArgs(VARIANT, {
        id: 'promote-upsell',
        clone: { from: { url: 'http://localhost:5173/pricing', match: 'li:has(> .plan)' }, into: 'x' },
      }),
      asDocument(source),
    );
    expect(extracted.found).toBe(false);
    expect(extracted.origin).toBe("url 'http://localhost:5173/pricing'");
    expect(extracted.detail).toBe(
      "the browser could not evaluate the selector 'li:has(> .plan)'",
    );
  });
});

describe('insertion at the target', () => {
  it('carries the source styles over, and the clone then matches its source', () => {
    const { doc, report } = insert(extract(PRICING));
    const clone = doc.querySelector('[data-vdiff-clone=promote-upsell]');
    expect(clone?.textContent).toBe('Pro');
    expect(doc.querySelectorAll('style[data-vdiff-variant-style]').length).toBe(1);
    expect(report.rules[0]?.clone).toMatchObject({ material: false, differences: [] });
    expect(cloneStyleWarnings(report)).toEqual([]);
  });

  it('flags the unstyled clone that the carried styles exist to prevent', () => {
    // The same element, extracted from a page whose stylesheet was left behind: exactly what
    // happens when a component's rules were injected at mount time somewhere else.
    const unstyled: ExtractedClone = { ...extract(PRICING), styles: [] };
    const { report } = insert(unstyled);

    const check = report.rules[0]?.clone;
    expect(check?.material).toBe(true);
    expect(check?.origin).toBe("step 'pricing'");
    expect(check?.differences).toEqual(
      expect.arrayContaining([
        { property: 'padding', source: '24px', target: '0px' },
        { property: 'font-family', source: 'Inter', target: 'Georgia' },
        { property: 'color', source: 'rgb(20, 20, 20)', target: 'rgb(0, 0, 0)' },
      ]),
    );
    // Still `applied`: the clone is there, it rendered, and it is misleading rather than missing.
    expect(report.rules[0]?.outcome).toBe('applied');
  });

  it('names the rule and the source in the warning it raises', () => {
    const unstyled: ExtractedClone = { ...extract(PRICING), styles: [] };
    const { report } = insert(unstyled);
    const warnings = cloneStyleWarnings(report);

    expect(warnings.length).toBe(1);
    expect(warnings[0]?.kind).toBe('variant-clone-unstyled');
    expect(warnings[0]?.rules).toEqual(['promote-upsell']);
    expect(warnings[0]?.message).toContain(
      "variant 'promote-plans' rule 'promote-upsell': the element cloned from step 'pricing' " +
        'renders differently here than at its source',
    );
    expect(warnings[0]?.message).toContain(
      'An unstyled clone is a misleading preview, not a failed one',
    );
  });

  it('notices a destination that restyles the clone even when the styles did arrive', () => {
    // The sidebar sets its own font, which wins over the carried rule for an inherited property.
    // The clone renders — in the wrong typeface — and the preview is misleading in the same way.
    const source = extract(PRICING);
    const withoutFont: ExtractedClone = {
      ...source,
      styles: ['.plan { padding: 24px; color: rgb(20, 20, 20); }'],
    };
    const { report } = insert(withoutFont);
    expect(report.rules[0]?.clone?.differences).toEqual([
      { property: 'font-family', source: 'Inter', target: 'Georgia' },
    ]);
  });
});
