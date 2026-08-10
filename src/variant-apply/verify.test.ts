/**
 * The verification pass (variants spec §8.2, D22) — the test the whole slice rests on.
 *
 * > "A fixture screen that deliberately re-renders after the settle gate must produce the D22
 * > warning rather than a silently unvaried screenshot. This test is the entire justification for
 * > choosing apply-once, and without it that decision is unguarded."
 *
 * Rules are applied once and the page is then photographed. If the application re-renders in
 * between, the variant is gone and the screenshot shows the *unvaried* UI while carrying the
 * variant's name — a wrong answer indistinguishable, in the image, from a right one. Every test
 * here drives a real revert through the `onApplied` hook, which runs at exactly the point in
 * `applyVariantInPage` where a reconciler would, and asserts the rule comes back `reverted`.
 *
 * The two shapes a re-render takes are both covered, because they fail differently:
 *
 * - the framework **replaces the node** (React, Preact, most list reconciliation) — the element the
 *   rule mutated is detached, and every verb notices;
 * - the framework **keeps the node and resets its properties** (attribute-level reconciliation) —
 *   only the value comparison notices.
 */

import { describe, expect, it } from 'vitest';

import { applyVariantInPage } from './inpage.js';
import { buildVariantApplyArgs } from './plan.js';
import { asDocument, parseDocument, parseNodes, type TestDocument, type TestElement } from './testdom.js';
import type { ExtractedClone, VariantApplyReport, ApplicableRule } from './types.js';

const VARIANT = 'denser-forecast';

const PAGE = `<html>
  <head><style id="app">.card { padding: 16px; }</style></head>
  <body>
    <main data-test="dashboard">
      <section data-test="forecast-card" class="card">Mon</section>
      <section data-test="forecast-card" class="card">Tue</section>
      <section data-test="forecast-chart">chart</section>
      <button data-test="save-cta">Save</button>
    </main>
    <aside data-test="sidebar"><h3>Nearby</h3></aside>
  </body>
</html>`;

interface Run {
  doc: TestDocument;
  report: VariantApplyReport;
}

function run(
  rules: ApplicableRule[],
  reRender?: (doc: TestDocument) => void,
  cloneSources?: Map<string, ExtractedClone>,
): Run {
  const doc = parseDocument(PAGE);
  const args = buildVariantApplyArgs({
    variant: VARIANT,
    rules,
    cloneSources: cloneSources ?? new Map<string, ExtractedClone>(),
  });
  const report = applyVariantInPage(
    args,
    asDocument(doc),
    reRender === undefined ? undefined : () => reRender(doc),
  );
  return { doc, report };
}

/** A framework re-render that replaces the node: the new element carries none of the mutation. */
function replaceNode(doc: TestDocument, selector: string, markup: string): void {
  const element = doc.querySelector(selector);
  if (element === null) throw new Error(`fixture: nothing matched ${selector}`);
  const fresh = parseNodes(markup, doc)[0] as TestElement;
  element.replaceWith(fresh);
}

describe('a rule that holds', () => {
  it('is applied when nothing touches the page between application and capture', () => {
    const { report } = run([
      { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
    ]);
    expect(report.rules[0]).toMatchObject({
      outcome: 'applied',
      matched: 2,
      changed: 2,
      verified: 2,
    });
    expect(report.rules[0]?.detail).toBeUndefined();
  });
});

describe('style', () => {
  it('reports reverted when the framework replaces the node it styled', () => {
    const { doc, report } = run(
      [{ id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } }],
      (page) => {
        replaceNode(
          page,
          '[data-test=forecast-card]',
          '<section data-test="forecast-card" class="card">Mon</section>',
        );
      },
    );

    expect(report.rules[0]).toMatchObject({ outcome: 'reverted', changed: 2, verified: 1 });
    expect(report.rules[0]?.detail).toBe(
      '1 of 2 changed elements no longer carried the change when the page was captured',
    );
    // And the page really is the unvaried UI for that element — which is the whole danger.
    expect(doc.querySelector('[data-test=forecast-card]')?.getAttribute('style')).toBeNull();
  });

  it('reports reverted when the reconciler keeps the node and resets its inline style', () => {
    const { report } = run(
      [{ id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } }],
      (page) => {
        for (const card of page.querySelectorAll('[data-test=forecast-card]')) {
          card.style.removeProperty('padding');
        }
      },
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'reverted', changed: 2, verified: 0 });
    expect(report.rules[0]?.detail).toBe(
      '2 of 2 changed elements no longer carried the change when the page was captured',
    );
  });

  it('reports reverted when the reconciler overwrites the value with its own', () => {
    const { report } = run(
      [{ id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } }],
      (page) => {
        for (const card of page.querySelectorAll('[data-test=forecast-card]')) {
          card.style.setProperty('padding', '16px', 'important');
        }
      },
    );
    expect(report.rules[0]?.outcome).toBe('reverted');
    expect(report.rules[0]?.verified).toBe(0);
  });
});

describe('text', () => {
  it('reports reverted when a re-render puts the original copy back', () => {
    const { doc, report } = run(
      [{ id: 'cta-copy', match: '[data-test=save-cta]', text: 'Save this location' }],
      (page) => {
        const cta = page.querySelector('[data-test=save-cta]');
        if (cta !== null) cta.textContent = 'Save';
      },
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'reverted', changed: 1, verified: 0 });
    expect(doc.querySelector('[data-test=save-cta]')?.textContent).toBe('Save');
  });
});

describe('hide', () => {
  it('reports reverted when the element is shown again before capture', () => {
    const { report } = run(
      [{ id: 'hide-chart', match: '[data-test=forecast-chart]', hide: true }],
      (page) => {
        page.querySelector('[data-test=forecast-chart]')?.style.removeProperty('display');
      },
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'reverted', changed: 1, verified: 0 });
  });
});

describe('order', () => {
  it('reports reverted when a re-render restores the original arrangement', () => {
    const { report } = run(
      [{ id: 'chart-first', match: '[data-test=forecast-chart]', order: 'first' }],
      (page) => {
        const main = page.querySelector('[data-test=dashboard]') as TestElement;
        const chart = page.querySelector('[data-test=forecast-chart]') as TestElement;
        const cta = page.querySelector('[data-test=save-cta]') as TestElement;
        main.insertBefore(chart, cta);
      },
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'reverted', changed: 1, verified: 0 });
  });

  it('reports reverted when the reordered node is replaced wholesale', () => {
    const { report } = run(
      [{ id: 'chart-first', match: '[data-test=forecast-chart]', order: 'first' }],
      (page) => {
        replaceNode(
          page,
          '[data-test=forecast-chart]',
          '<section data-test="forecast-chart">chart</section>',
        );
      },
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'reverted', verified: 0 });
  });

  it('still holds when something unrelated is inserted between the element and its reference', () => {
    const { report } = run(
      [
        {
          id: 'cta-before-chart',
          match: '[data-test=save-cta]',
          order: { before: '[data-test=forecast-chart]' },
        },
      ],
      (page) => {
        const main = page.querySelector('[data-test=dashboard]') as TestElement;
        const chart = page.querySelector('[data-test=forecast-chart]') as TestElement;
        const banner = page.createElement('div');
        banner.setAttribute('data-test', 'banner');
        main.insertBefore(banner, chart);
      },
    );
    // The rule said "before the chart", and it still is before the chart. Reporting this as a
    // revert would cry wolf on the warning that has to be believed when it fires.
    expect(report.rules[0]?.outcome).toBe('applied');
  });
});

describe('clone', () => {
  const source: ExtractedClone = {
    origin: "step 'pricing'",
    match: '[data-test=plan-card]',
    html: '<li data-test="plan-card" class="plan">Pro</li>',
    styles: ['.plan { padding: 24px; }'],
    computed: {},
  };

  const rule: ApplicableRule = {
    id: 'promote-upsell',
    clone: {
      from: { step: 'pricing', match: '[data-test=plan-card]' },
      into: '[data-test=sidebar]',
      position: 'prepend',
      times: 2,
    },
  };

  it('reports reverted when a re-render removes the inserted copies', () => {
    const { doc, report } = run(
      [rule],
      (page) => {
        for (const copy of page.querySelectorAll('[data-vdiff-clone=promote-upsell]')) copy.remove();
      },
      new Map([['promote-upsell', source]]),
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'reverted', changed: 2, verified: 0 });
    expect(doc.querySelectorAll('[data-test=plan-card]').length).toBe(0);
  });

  it('reports reverted when only some copies survive', () => {
    const { report } = run(
      [rule],
      (page) => {
        page.querySelector('[data-vdiff-clone=promote-upsell]')?.remove();
      },
      new Map([['promote-upsell', source]]),
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'reverted', changed: 2, verified: 1 });
    expect(report.rules[0]?.detail).toBe(
      '1 of 2 changed elements no longer carried the change when the page was captured',
    );
  });

  it('reports reverted when the copies are moved out of the container they were put in', () => {
    const { report } = run(
      [rule],
      (page) => {
        const main = page.querySelector('[data-test=dashboard]') as TestElement;
        for (const copy of page.querySelectorAll('[data-vdiff-clone=promote-upsell]')) {
          main.appendChild(copy);
        }
      },
      new Map([['promote-upsell', source]]),
    );
    expect(report.rules[0]?.outcome).toBe('reverted');
  });
});

describe('a variant that is partly reverted', () => {
  it('reports each rule separately, so the report says which half of the proposal is real', () => {
    const { report } = run(
      [
        { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
        { id: 'cta-copy', match: '[data-test=save-cta]', text: 'Save this location' },
        { id: 'hide-chart', match: '[data-test=nothing-here]', hide: true },
      ],
      (page) => {
        const cta = page.querySelector('[data-test=save-cta]');
        if (cta !== null) cta.textContent = 'Save';
      },
    );
    expect(report.rules.map((entry) => [entry.ruleId, entry.outcome])).toEqual([
      ['tighter-cards', 'applied'],
      ['cta-copy', 'reverted'],
      ['hide-chart', 'unmatched'],
    ]);
  });
});
