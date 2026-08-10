/**
 * Golden tests on rule application (variants spec §8.3): "a fixture DOM plus a variant in,
 * resulting DOM out, for every verb including `order` and `clone` positioning".
 *
 * Both sides are written as ordinary HTML and compared after normalization, so what a test asserts
 * is the resulting *document* — where every element ended up, what it carries, and the attribution
 * stamped on it — rather than a serialization detail.
 *
 * The fixture is shaped after the dashboard in `fixtures/app`: repeated forecast cards, a chart, an
 * air-quality panel, a call to action, and a sidebar, because those are the elements the proposals
 * in §1 are actually about ("tighter cards, a section moved, the upsell promoted to the sidebar").
 */

import { describe, expect, it } from 'vitest';

import { applyVariantInPage, extractCloneSourceInPage } from './inpage.js';
import { CLONE_STYLE_PROPS, buildVariantApplyArgs, cloneExtractArgs, cloneSourceFrom } from './plan.js';
import { asDocument, parseDocument, prettyPrint, type TestDocument } from './testdom.js';
import {
  VARIANT_ATTRS,
  type ExtractedClone,
  type VariantApplyReport,
  type ApplicableRule,
} from './types.js';

const VARIANT = 'denser-forecast';

const PAGE = `<html>
  <head>
    <style id="app">.card { padding: 16px; gap: 12px; font-family: Inter; } .aside { font-family: Georgia; }</style>
  </head>
  <body>
    <main data-test="dashboard">
      <section data-test="forecast-card" class="card">Mon</section>
      <section data-test="forecast-card" class="card">Tue</section>
      <section data-test="forecast-chart">chart</section>
      <section data-test="air-quality">AQI 42</section>
      <button data-test="save-cta"><span>Save</span></button>
    </main>
    <aside data-test="sidebar" class="aside"><h3>Nearby</h3></aside>
  </body>
</html>`;

/** The pricing page a clone source comes from: a different route of the same application (D23). */
const PRICING_PAGE = `<html>
  <head>
    <style id="app">.plan { padding: 24px; font-family: Inter; color: rgb(20, 20, 20); }</style>
  </head>
  <body>
    <ul data-test="plans">
      <li data-test="plan-card" class="plan">Pro</li>
      <li data-test="plan-card" class="plan">Team</li>
    </ul>
  </body>
</html>`;

interface Applied {
  doc: TestDocument;
  report: VariantApplyReport;
}

function apply(
  rules: ApplicableRule[],
  options: { page?: string; cloneSources?: Map<string, ExtractedClone> } = {},
): Applied {
  const doc = parseDocument(options.page ?? PAGE);
  const args = buildVariantApplyArgs({
    variant: VARIANT,
    rules,
    cloneSources: options.cloneSources ?? new Map<string, ExtractedClone>(),
  });
  const report = applyVariantInPage(args, asDocument(doc));
  return { doc, report };
}

/** Compare two documents by structure, not by how their markup happens to be indented. */
function expectDocument(doc: TestDocument, expected: string): void {
  expect(prettyPrint(doc.body)).toBe(prettyPrint(parseDocument(`<html>${expected}</html>`).body));
}

/** Attribution as it appears on an element, so a golden expectation can spell it out once. */
function marks(ruleId: string, verb: string): string {
  return (
    `${VARIANT_ATTRS.variant}="${VARIANT}" ${VARIANT_ATTRS.rule}="${ruleId}" ` +
    `${VARIANT_ATTRS.verb}="${verb}"`
  );
}

describe('style', () => {
  it('sets the declarations on every matched element and stamps attribution', () => {
    const { doc, report } = apply([
      { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px', gap: '4px' } },
    ]);

    expectDocument(
      doc,
      `<body>
        <main data-test="dashboard">
          <section data-test="forecast-card" class="card" ${marks('tighter-cards', 'style')} style="padding: 8px !important; gap: 4px !important;">Mon</section>
          <section data-test="forecast-card" class="card" ${marks('tighter-cards', 'style')} style="padding: 8px !important; gap: 4px !important;">Tue</section>
          <section data-test="forecast-chart">chart</section>
          <section data-test="air-quality">AQI 42</section>
          <button data-test="save-cta"><span>Save</span></button>
        </main>
        <aside data-test="sidebar" class="aside"><h3>Nearby</h3></aside>
      </body>`,
    );
    expect(report.rules[0]).toMatchObject({
      ruleId: 'tighter-cards',
      verb: 'style',
      outcome: 'applied',
      matched: 2,
      changed: 2,
      verified: 2,
    });
  });

  it('translates a camelCase property to the dashed form the page understands', () => {
    const { doc } = apply([{ id: 'flat', match: '[data-test=sidebar]', style: { borderRadius: '0px' } }]);
    expect(doc.querySelector('[data-test=sidebar]')?.getAttribute('style')).toBe(
      'border-radius: 0px !important;',
    );
  });

  it('reports a declaration the browser rejected instead of claiming it applied', () => {
    const { report } = apply([
      { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8', gap: '4px' } },
    ]);
    expect(report.rules[0]?.outcome).toBe('applied');
    expect(report.rules[0]?.detail).toBe('the browser rejected 1 declaration (padding) as invalid');
  });

  it('reports a rule whose every declaration was rejected as having changed nothing', () => {
    const { report } = apply([
      { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8' } },
    ]);
    // Not `reverted`: nothing was ever applied, and `reverted` is reserved for the D22 case where
    // something was applied and then stopped being true.
    expect(report.rules[0]).toMatchObject({ outcome: 'unmatched', matched: 2, changed: 0 });
    expect(report.rules[0]?.detail).toBe('the browser rejected 1 declaration (padding) as invalid');
  });
});

describe('text', () => {
  it('replaces the text content of every matched element', () => {
    const { doc, report } = apply([
      { id: 'cta-copy', match: '[data-test=save-cta]', text: 'Save this location' },
    ]);

    expectDocument(
      doc,
      `<body>
        <main data-test="dashboard">
          <section data-test="forecast-card" class="card">Mon</section>
          <section data-test="forecast-card" class="card">Tue</section>
          <section data-test="forecast-chart">chart</section>
          <section data-test="air-quality">AQI 42</section>
          <button data-test="save-cta" ${marks('cta-copy', 'text')}>Save this location</button>
        </main>
        <aside data-test="sidebar" class="aside"><h3>Nearby</h3></aside>
      </body>`,
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'applied', matched: 1, changed: 1, verified: 1 });
  });
});

describe('hide', () => {
  it('takes the element out of the layout without removing it from the document', () => {
    const { doc, report } = apply([{ id: 'hide-air-quality', match: '[data-test=air-quality]', hide: true }]);

    expectDocument(
      doc,
      `<body>
        <main data-test="dashboard">
          <section data-test="forecast-card" class="card">Mon</section>
          <section data-test="forecast-card" class="card">Tue</section>
          <section data-test="forecast-chart">chart</section>
          <section data-test="air-quality" ${marks('hide-air-quality', 'hide')} style="display: none !important;">AQI 42</section>
          <button data-test="save-cta"><span>Save</span></button>
        </main>
        <aside data-test="sidebar" class="aside"><h3>Nearby</h3></aside>
      </body>`,
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'applied', matched: 1, changed: 1, verified: 1 });
  });
});

describe('order', () => {
  it('moves an element to the front of its siblings', () => {
    const { doc, report } = apply([
      { id: 'chart-first', match: '[data-test=forecast-chart]', order: 'first' },
    ]);

    expectDocument(
      doc,
      `<body>
        <main data-test="dashboard">
          <section data-test="forecast-chart" ${marks('chart-first', 'order')}>chart</section>
          <section data-test="forecast-card" class="card">Mon</section>
          <section data-test="forecast-card" class="card">Tue</section>
          <section data-test="air-quality">AQI 42</section>
          <button data-test="save-cta"><span>Save</span></button>
        </main>
        <aside data-test="sidebar" class="aside"><h3>Nearby</h3></aside>
      </body>`,
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'applied', matched: 1, changed: 1, verified: 1 });
  });

  it('moves an element to the end of its siblings', () => {
    const { doc } = apply([{ id: 'chart-last', match: '[data-test=forecast-chart]', order: 'last' }]);

    expectDocument(
      doc,
      `<body>
        <main data-test="dashboard">
          <section data-test="forecast-card" class="card">Mon</section>
          <section data-test="forecast-card" class="card">Tue</section>
          <section data-test="air-quality">AQI 42</section>
          <button data-test="save-cta"><span>Save</span></button>
          <section data-test="forecast-chart" ${marks('chart-last', 'order')}>chart</section>
        </main>
        <aside data-test="sidebar" class="aside"><h3>Nearby</h3></aside>
      </body>`,
    );
  });

  it('places an element before a named sibling', () => {
    const { doc } = apply([
      {
        id: 'cta-before-chart',
        match: '[data-test=save-cta]',
        order: { before: '[data-test=forecast-chart]' },
      },
    ]);

    expectDocument(
      doc,
      `<body>
        <main data-test="dashboard">
          <section data-test="forecast-card" class="card">Mon</section>
          <section data-test="forecast-card" class="card">Tue</section>
          <button data-test="save-cta" ${marks('cta-before-chart', 'order')}><span>Save</span></button>
          <section data-test="forecast-chart">chart</section>
          <section data-test="air-quality">AQI 42</section>
        </main>
        <aside data-test="sidebar" class="aside"><h3>Nearby</h3></aside>
      </body>`,
    );
  });

  it('places an element after a named sibling', () => {
    const { doc } = apply([
      {
        id: 'chart-after-aq',
        match: '[data-test=forecast-chart]',
        order: { after: '[data-test=air-quality]' },
      },
    ]);

    expectDocument(
      doc,
      `<body>
        <main data-test="dashboard">
          <section data-test="forecast-card" class="card">Mon</section>
          <section data-test="forecast-card" class="card">Tue</section>
          <section data-test="air-quality">AQI 42</section>
          <section data-test="forecast-chart" ${marks('chart-after-aq', 'order')}>chart</section>
          <button data-test="save-cta"><span>Save</span></button>
        </main>
        <aside data-test="sidebar" class="aside"><h3>Nearby</h3></aside>
      </body>`,
    );
  });

  it('moves an element into another container when the reference lives there', () => {
    const { doc, report } = apply([
      {
        id: 'chart-to-sidebar',
        match: '[data-test=forecast-chart]',
        order: { after: '[data-test=sidebar] h3' },
      },
    ]);

    expectDocument(
      doc,
      `<body>
        <main data-test="dashboard">
          <section data-test="forecast-card" class="card">Mon</section>
          <section data-test="forecast-card" class="card">Tue</section>
          <section data-test="air-quality">AQI 42</section>
          <button data-test="save-cta"><span>Save</span></button>
        </main>
        <aside data-test="sidebar" class="aside">
          <h3>Nearby</h3>
          <section data-test="forecast-chart" ${marks('chart-to-sidebar', 'order')}>chart</section>
        </aside>
      </body>`,
    );
    expect(report.rules[0]?.outcome).toBe('applied');
  });

  it('leaves the document alone when the reference matches nothing, and says so', () => {
    const { doc, report } = apply([
      {
        id: 'chart-before-nothing',
        match: '[data-test=forecast-chart]',
        order: { before: '[data-test=nope]' },
      },
    ]);

    expectDocument(doc, `<body>${parseDocument(PAGE).body.innerHTML}</body>`);
    expect(report.rules[0]).toMatchObject({ outcome: 'unmatched', matched: 1, changed: 0 });
    expect(report.rules[0]?.detail).toBe(
      "before: '[data-test=nope]' matched no element this one could be moved next to",
    );
  });
});

describe('clone', () => {
  /** Extract a plan card from the pricing page exactly as the runner does (D23). */
  function planCardSource(match = '[data-test=plan-card]:first-child'): ExtractedClone {
    const source = parseDocument(PRICING_PAGE);
    const extracted = extractCloneSourceInPage(
      cloneExtractArgs(VARIANT, { id: 'promote-upsell', clone: { from: { step: 'pricing', match }, into: '' } }),
      asDocument(source),
    );
    return cloneSourceFrom(VARIANT, extracted);
  }

  it('inserts a copy of an element rendered on another page, with its styles', () => {
    const { doc, report } = apply(
      [
        {
          id: 'promote-upsell',
          clone: {
            from: { step: 'pricing', match: '[data-test=plan-card]:first-child' },
            into: '[data-test=sidebar]',
            position: 'prepend',
            times: 1,
          },
        },
      ],
      { cloneSources: new Map([['promote-upsell', planCardSource()]]) },
    );

    expectDocument(
      doc,
      `<body>
        <main data-test="dashboard">
          <section data-test="forecast-card" class="card">Mon</section>
          <section data-test="forecast-card" class="card">Tue</section>
          <section data-test="forecast-chart">chart</section>
          <section data-test="air-quality">AQI 42</section>
          <button data-test="save-cta"><span>Save</span></button>
        </main>
        <aside data-test="sidebar" class="aside">
          <li data-test="plan-card" class="plan" data-vdiff-clone="promote-upsell" ${marks('promote-upsell', 'clone')}>Pro</li>
          <h3>Nearby</h3>
        </aside>
      </body>`,
    );
    expect(report.rules[0]).toMatchObject({ outcome: 'applied', matched: 1, changed: 1, verified: 1 });
    // The source page's stylesheet came along, because a component cloned onto a page where it
    // never mounted would otherwise render unstyled (§4).
    expect(doc.querySelector('head style[data-vdiff-variant-style]')?.textContent).toContain('.plan');
    expect(report.stylesInjected).toBe(1);
  });

  it('appends by default and keeps repeated copies in the order they were made', () => {
    const { doc } = apply(
      [
        {
          id: 'three-plans',
          clone: {
            from: { step: 'pricing', match: '[data-test=plan-card]:first-child' },
            into: '[data-test=sidebar]',
            times: 3,
          },
        },
      ],
      { cloneSources: new Map([['three-plans', planCardSource()]]) },
    );

    const sidebar = doc.querySelector('[data-test=sidebar]');
    expect(sidebar?.children.map((child) => child.tagName)).toEqual(['H3', 'LI', 'LI', 'LI']);
    expect(doc.querySelectorAll('[data-vdiff-clone=three-plans]').length).toBe(3);
  });

  it('places copies before a reference inside the target', () => {
    const { doc } = apply(
      [
        {
          id: 'plans-first',
          clone: {
            from: { step: 'pricing', match: '[data-test=plan-card]:first-child' },
            into: '[data-test=sidebar]',
            position: { before: 'h3' },
            times: 2,
          },
        },
      ],
      { cloneSources: new Map([['plans-first', planCardSource()]]) },
    );

    const sidebar = doc.querySelector('[data-test=sidebar]');
    expect(sidebar?.children.map((child) => child.textContent)).toEqual(['Pro', 'Pro', 'Nearby']);
  });

  it('places copies after a reference inside the target', () => {
    const { doc } = apply(
      [
        {
          id: 'plans-after',
          clone: {
            from: { step: 'pricing', match: '[data-test=plan-card]:first-child' },
            into: '[data-test=sidebar]',
            position: { after: 'h3' },
            times: 2,
          },
        },
      ],
      { cloneSources: new Map([['plans-after', planCardSource()]]) },
    );

    const sidebar = doc.querySelector('[data-test=sidebar]');
    expect(sidebar?.children.map((child) => child.textContent)).toEqual(['Nearby', 'Pro', 'Pro']);
  });

  it('inserts nothing when the position reference is not in the target', () => {
    const { doc, report } = apply(
      [
        {
          id: 'plans-nowhere',
          clone: {
            from: { step: 'pricing', match: '[data-test=plan-card]:first-child' },
            into: '[data-test=sidebar]',
            position: { before: '[data-test=missing]' },
          },
        },
      ],
      { cloneSources: new Map([['plans-nowhere', planCardSource()]]) },
    );

    expect(doc.querySelectorAll('[data-test=plan-card]').length).toBe(0);
    expect(report.rules[0]).toMatchObject({ outcome: 'unmatched', changed: 0 });
    expect(report.rules[0]?.detail).toBe(
      "position before: '[data-test=missing]' matched no element inside '[data-test=sidebar]', so nothing was inserted",
    );
  });

  it('extracts the second element when the source selector names it', () => {
    const source = planCardSource('[data-test=plan-card]:nth-child(2)');
    expect(source.html).toBe('<li data-test="plan-card" class="plan">Team</li>');
    expect(source.computed['font-family']).toBe('Inter');
    expect(source.styles).toEqual([
      '.plan { padding: 24px; font-family: Inter; color: rgb(20, 20, 20); }',
    ]);
  });

  it('compares the clone against its source and reports a clean copy as clean', () => {
    const { report } = apply(
      [
        {
          id: 'promote-upsell',
          clone: {
            from: { step: 'pricing', match: '[data-test=plan-card]:first-child' },
            into: '[data-test=sidebar]',
            position: 'prepend',
          },
        },
      ],
      { cloneSources: new Map([['promote-upsell', planCardSource()]]) },
    );
    expect(report.rules[0]?.clone).toMatchObject({ origin: "step 'pricing'", material: false });
    expect(report.rules[0]?.clone?.compared).toBe(CLONE_STYLE_PROPS.length);
  });
});

describe('several rules over one document', () => {
  it('applies them in file order and attributes every element it touched', () => {
    const { doc, report } = apply([
      { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
      { id: 'hide-air-quality', match: '[data-test=air-quality]', hide: true },
      { id: 'chart-first', match: '[data-test=forecast-chart]', order: 'first' },
      { id: 'cta-copy', match: '[data-test=save-cta]', text: 'Save this location' },
    ]);

    expectDocument(
      doc,
      `<body>
        <main data-test="dashboard">
          <section data-test="forecast-chart" ${marks('chart-first', 'order')}>chart</section>
          <section data-test="forecast-card" class="card" ${marks('tighter-cards', 'style')} style="padding: 8px !important;">Mon</section>
          <section data-test="forecast-card" class="card" ${marks('tighter-cards', 'style')} style="padding: 8px !important;">Tue</section>
          <section data-test="air-quality" ${marks('hide-air-quality', 'hide')} style="display: none !important;">AQI 42</section>
          <button data-test="save-cta" ${marks('cta-copy', 'text')}>Save this location</button>
        </main>
        <aside data-test="sidebar" class="aside"><h3>Nearby</h3></aside>
      </body>`,
    );
    expect(report.attributions).toEqual([
      { variant: VARIANT, ruleId: 'tighter-cards', verb: 'style', target: '[data-test="forecast-card"]' },
      { variant: VARIANT, ruleId: 'tighter-cards', verb: 'style', target: '[data-test="forecast-card"]' },
      { variant: VARIANT, ruleId: 'hide-air-quality', verb: 'hide', target: '[data-test="air-quality"]' },
      { variant: VARIANT, ruleId: 'chart-first', verb: 'order', target: '[data-test="forecast-chart"]' },
      { variant: VARIANT, ruleId: 'cta-copy', verb: 'text', target: '[data-test="save-cta"]' },
    ]);
    expect(report.rules.map((rule) => rule.outcome)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
  });

  it('keeps both attributions when two rules touch one element', () => {
    const { doc } = apply([
      { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
      { id: 'first-card-last', match: '[data-test=forecast-card]', order: 'last' },
    ]);
    const card = doc.querySelector('[data-test=forecast-card]');
    expect(card?.getAttribute(VARIANT_ATTRS.rule)).toBe('tighter-cards,first-card-last');
    expect(card?.getAttribute(VARIANT_ATTRS.verb)).toBe('style,order');
    expect(card?.getAttribute(VARIANT_ATTRS.variant)).toBe(VARIANT);
  });
});
