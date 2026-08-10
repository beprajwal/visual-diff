/**
 * Variants against real Chromium, through the runner's own wiring (variants spec §8.1, §8.2, §8.4).
 *
 * `variant-apply/` proves what each rule does to a DOM, and `variant.test.ts` proves what the runner
 * decides. What neither can prove is the part that only exists when a browser is involved, and three
 * of those are load-bearing:
 *
 *  1. **Verification catches a revert** (§8.2) — "this test is the entire justification for choosing
 *     apply-once, and without it that decision is unguarded". The fixture below is a component that
 *     owns its own content and restores it the moment anything else touches it: a reconciler in
 *     miniature, re-rendering inside the window D22 names.
 *  2. **Cross-page cloning** (§8.4), both `url:` and `step:` sources, resolved through the real
 *     context-creation path so the source page carries the same determinism knobs as the target, and
 *     including the unstyled-clone warning.
 *  3. **Determinism under variants** (§8.1) — same page, same variant, twice, byte for byte the same
 *     screenshot, clone extraction and all.
 */

import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Browser, Page } from 'playwright-core';

import type { FlowSpec, Viewport } from '../types.js';
import type { VariantSpec } from '../variant/index.js';
import { variantWarnings, type ExtractedClone } from '../variant-apply/index.js';
import { launchChromium, newContext } from './browser.js';
import { RunnerError } from './errors.js';
import { applyVariantForCapture, performStep } from './replay.js';
import { extractCloneSources } from './variant-clone.js';
import { aggregateReport, buildVariantRuntime, type VariantPlan, type VariantRuntime } from './variant.js';

const require_ = createRequire(import.meta.url);

function chromiumAvailable(): boolean {
  try {
    const { chromium } = require_('playwright-core') as typeof import('playwright-core');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const describeIfBrowser = chromiumAvailable() ? describe : describe.skip;

const viewport: Viewport = { id: '600x400', width: 600, height: 400 };

/**
 * The target page: cards to tighten, a section to hide, a chart to promote, and two sidebars — one
 * plain, one whose own CSS outranks a clone's, which is how the drift warning is provoked without
 * inventing a failure mode.
 */
const TARGET_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>forecast</title>
<style>
  body { margin: 0; font: 16px/1.4 monospace; }
  .card { padding: 24px; }
  .biased .plan { color: rgb(0, 128, 0); }
</style></head>
<body>
  <main id="main">
    <div class="card" data-test="forecast-card">Mon</div>
    <div class="card" data-test="forecast-card">Tue</div>
    <div id="aqi" data-test="air-quality">Air quality</div>
    <div id="chart" data-test="forecast-chart">Chart</div>
    <button data-test="save-cta">Save</button>
  </main>
  <aside class="sidebar" data-test="sidebar"><p id="ad">Ad</p></aside>
  <aside class="biased" data-test="biased"><p id="ad2">Ad</p></aside>
</body></html>
`;

/**
 * The clone source: another page of the same application, at the same revision (D23). Its `<style>`
 * stands in for what a CSS-in-JS library injects at mount time — the target has never seen it.
 */
const PRICING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>pricing</title>
<style>
  body { margin: 0; font: 16px/1.4 monospace; }
  .plan { color: rgb(255, 0, 0); padding: 12px; font-weight: 700; }
</style></head>
<body>
  <div class="plan" data-test="plan-card">Pro</div>
  <div class="plan">Basic</div>
</body></html>
`;

/**
 * A screen that re-renders over the variant before the shutter falls (§8.2).
 *
 * `<owned-text>` owns its own content: any attribute written to it — including the attribution the
 * applier stamps — makes it put its text back, synchronously, inside `attributeChangedCallback`.
 * That is a real reconciler's behaviour in miniature, and it is exactly the D22 hazard: the rule was
 * applied, the screenshot shows the original, and without the verification pass nothing would say so.
 */
const REVERTING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>reverting</title></head>
<body>
  <owned-text data-test="save-cta">Original</owned-text>
  <script>
    class OwnedText extends HTMLElement {
      static get observedAttributes() {
        return ['data-vdiff-variant', 'data-vdiff-rule', 'data-vdiff-verb', 'style'];
      }
      attributeChangedCallback() {
        if (this.textContent !== 'Original') this.textContent = 'Original';
      }
    }
    customElements.define('owned-text', OwnedText);
  </script>
</body></html>
`;

const PAGES: Record<string, string> = {
  '/': TARGET_PAGE,
  '/pricing': PRICING_PAGE,
  '/reverting': REVERTING_PAGE,
};

function spec(rules: VariantSpec['rules'], name = 'denser-forecast'): VariantSpec {
  return { version: 1, variant: name, rules };
}

function plan(value: VariantSpec): VariantPlan {
  return { name: value.variant, spec: value, file: `${value.variant}.yaml` };
}

function flow(steps: FlowSpec['steps']): FlowSpec {
  return { version: 1, flow: 'forecast', viewports: [viewport.id], network: { mode: 'off' }, steps };
}

describeIfBrowser('variants in a real browser', () => {
  let browser: Browser;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    browser = await launchChromium();
    server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      const body = PAGES[path];
      if (body === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  /** Resolve clone sources exactly as a viewport replay does, through the real context path. */
  async function resolveSources(
    value: VariantSpec,
    steps: FlowSpec['steps'] = [{ id: 'home', goto: '/' }],
  ): Promise<Map<string, ExtractedClone>> {
    const runtime = buildVariantRuntime({ plan: plan(value), viewport: viewport.id });
    return await extractCloneSources({
      browser,
      variant: value.variant,
      rules: runtime.cloneRules(),
      flow: flow(steps),
      context: { viewport, network: 'off', baseUrl },
      perform: (page, step) => performStep(page, step, 15_000),
      timeoutMs: 15_000,
    });
  }

  /** Open the page and run the capture-time pass the runner runs, once, as it runs it. */
  async function applyOn(
    path: string,
    value: VariantSpec,
    sources: ReadonlyMap<string, ExtractedClone> = new Map(),
  ): Promise<{ page: Page; runtime: VariantRuntime; close: () => Promise<void> }> {
    const context = await newContext(browser, { viewport, network: 'off', baseUrl });
    const page = await context.newPage();
    await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });

    const runtime = buildVariantRuntime({ plan: plan(value), viewport: viewport.id });
    for (const [ruleId, source] of sources) runtime.attachCloneSource(ruleId, source);
    await applyVariantForCapture(page, 'shot', runtime);

    return { page, runtime, close: () => context.close().catch(() => undefined) };
  }

  /** The run-level verdict, built the way `run.ts` builds it. */
  function verdict(runtime: VariantRuntime): ReturnType<typeof aggregateReport> {
    return aggregateReport(
      runtime.variant,
      runtime.spec.rules.map((rule) => rule.id),
      runtime.reports().map((capture) => capture.report),
    );
  }

  /* -------------------------------------------------------------- §8.2 verification (D22) */

  it('catches a rule the application re-rendered over before the screenshot', async () => {
    const { page, runtime, close } = await applyOn(
      '/reverting',
      spec([{ id: 'cta-copy', match: '[data-test=save-cta]', text: 'Proposed' }]),
    );
    try {
      // This is the screenshot that would have shipped labelled as a variant. The only thing that
      // makes it visible is the verification pass, which is the whole of D22's bargain.
      expect(await page.locator('[data-test=save-cta]').textContent()).toBe('Original');

      const report = verdict(runtime);
      expect(report.rules[0]).toMatchObject({ ruleId: 'cta-copy', outcome: 'reverted' });
      const warning = variantWarnings(report).find((entry) => entry.kind === 'variant-rule-reverted');
      expect(warning?.message).toContain("rule 'cta-copy'");
      expect(warning?.message).toContain('the application re-rendered after the variant was applied');
    } finally {
      await close();
    }
  });

  it('reports no revert on a page that leaves the change alone', async () => {
    const { page, runtime, close } = await applyOn(
      '/',
      spec([
        { id: 'cta-copy', match: '[data-test=save-cta]', text: 'Save this location' },
        { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
        { id: 'hide-air-quality', match: '[data-test=air-quality]', hide: true },
        { id: 'chart-first', match: '[data-test=forecast-chart]', order: 'first' },
      ]),
    );
    try {
      expect(await page.locator('[data-test=save-cta]').textContent()).toBe('Save this location');
      expect(
        await page.evaluate(() => window.getComputedStyle(document.getElementById('aqi') as Element).display),
      ).toBe('none');
      expect(
        await page.evaluate(() => document.getElementById('main')?.firstElementChild?.id),
      ).toBe('chart');

      expect(verdict(runtime).rules.map((rule) => rule.outcome)).toEqual([
        'applied',
        'applied',
        'applied',
        'applied',
      ]);
      expect(variantWarnings(verdict(runtime))).toEqual([]);
    } finally {
      await close();
    }
  });

  it('says the screens are the unmodified UI when a selector matched nothing', async () => {
    const { runtime, close } = await applyOn(
      '/',
      spec([{ id: 'typo', match: '[data-test=forecast-crad]', hide: true }]),
    );
    try {
      const warning = variantWarnings(verdict(runtime))[0];
      expect(warning?.kind).toBe('variant-rule-unmatched');
      expect(warning?.message).toContain("rule 'typo'");
      expect(warning?.message).toContain('not the proposal it is labelled as');
    } finally {
      await close();
    }
  });

  /* -------------------------------------------------------------- §8.4 cross-page cloning */

  it('clones from a url source, carrying the source page styles with it', async () => {
    const value = spec([
      {
        id: 'promote-upsell',
        clone: {
          from: { url: '/pricing', match: '[data-test=plan-card]' },
          into: '[data-test=sidebar]',
          position: 'prepend',
          times: 2,
        },
      },
    ]);
    const sources = await resolveSources(value);
    const { page, runtime, close } = await applyOn('/', value, sources);
    try {
      expect(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-test=sidebar] > *')).map(
            (child) => `${child.tagName.toLowerCase()}:${child.textContent ?? ''}`,
          ),
        ),
      ).toEqual(['div:Pro', 'div:Pro', 'p:Ad']);

      // The source's own stylesheet travelled with it: without that injection the clone would render
      // in the target's default colour, and an unstyled clone is a misleading preview (§4).
      expect(
        await page.evaluate(
          () => window.getComputedStyle(document.querySelector('[data-test=sidebar] .plan') as Element).color,
        ),
      ).toBe('rgb(255, 0, 0)');
      expect(variantWarnings(verdict(runtime))).toEqual([]);
    } finally {
      await close();
    }
  });

  it('clones from a step source, replaying the flow to that step', async () => {
    const value = spec([
      {
        id: 'promote-upsell',
        clone: {
          from: { step: 'pricing', match: '[data-test=plan-card]' },
          into: '[data-test=sidebar]',
          position: 'append',
          times: 1,
        },
      },
    ]);
    const sources = await resolveSources(value, [
      { id: 'home', goto: '/' },
      { id: 'pricing', goto: '/pricing' },
    ]);
    expect(sources.get('promote-upsell')?.origin).toBe("step 'pricing'");

    const { page, close } = await applyOn('/', value, sources);
    try {
      expect(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-test=sidebar] > *')).map((child) => child.textContent),
        ),
      ).toEqual(['Ad', 'Pro']);
    } finally {
      await close();
    }
  });

  it('warns when the clone renders differently here than at its source', async () => {
    const value = spec([
      {
        id: 'promote-upsell',
        clone: {
          from: { url: '/pricing', match: '[data-test=plan-card]' },
          into: '[data-test=biased]',
          position: 'append',
          times: 1,
        },
      },
    ]);
    const sources = await resolveSources(value);
    const { runtime, close } = await applyOn('/', value, sources);
    try {
      const warning = variantWarnings(verdict(runtime)).find(
        (entry) => entry.kind === 'variant-clone-unstyled',
      );
      expect(warning?.message).toContain("rule 'promote-upsell'");
      expect(warning?.message).toContain("url '/pricing'");
      expect(warning?.message).toContain('color');
    } finally {
      await close();
    }
  });

  it('fails the run naming the rule and the url when the source cannot be loaded', async () => {
    const value = spec([
      {
        id: 'promote-upsell',
        clone: {
          from: { url: 'https://example.invalid/pricing', match: '.plan' },
          into: '[data-test=sidebar]',
          position: 'append',
          times: 1,
        },
      },
    ]);

    let thrown: unknown;
    await resolveSources(value).catch((error: unknown) => {
      thrown = error;
    });

    expect(RunnerError.is(thrown)).toBe(true);
    const error = thrown as RunnerError;
    expect(error.code).toBe('variant-clone-url-unreachable');
    expect(error.message).toContain("variant 'denser-forecast' rule 'promote-upsell'");
    expect(error.message).toContain("clone source url 'https://example.invalid/pricing'");
    expect(error.message).toContain("under network mode 'off'");
    expect(error.kind).toBe('variant-failed');
  });

  it('fails the run naming the rule when the source page has no such element', async () => {
    const value = spec([
      {
        id: 'promote-upsell',
        clone: {
          from: { url: '/pricing', match: '[data-test=no-such-card]' },
          into: '[data-test=sidebar]',
          position: 'append',
          times: 1,
        },
      },
    ]);

    let thrown: unknown;
    await resolveSources(value).catch((error: unknown) => {
      thrown = error;
    });

    expect(RunnerError.is(thrown)).toBe(true);
    const error = thrown as RunnerError;
    expect(error.message).toContain("rule 'promote-upsell'");
    expect(error.message).toContain("url '/pricing'");
    expect(error.message).toContain('[data-test=no-such-card]');
    expect(error.kind).toBe('variant-failed');
  });

  it('replays a shared source page once, however many rules read from it', async () => {
    const value = spec([
      {
        id: 'promote-pro',
        clone: {
          from: { url: '/pricing', match: '[data-test=plan-card]' },
          into: '[data-test=sidebar]',
          position: 'append',
          times: 1,
        },
      },
      {
        id: 'promote-basic',
        clone: {
          from: { url: '/pricing', match: '.plan:nth-of-type(2)' },
          into: '[data-test=sidebar]',
          position: 'append',
          times: 1,
        },
      },
    ]);

    const sources = await resolveSources(value);

    expect([...sources.keys()]).toEqual(['promote-pro', 'promote-basic']);
    expect(sources.get('promote-basic')?.html).toContain('Basic');
  });

  /* -------------------------------------------------------------- §8.1 determinism */

  it('produces the same screenshot twice for the same page and the same variant', async () => {
    const value = spec([
      { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
      { id: 'hide-air-quality', match: '[data-test=air-quality]', hide: true },
      { id: 'chart-first', match: '[data-test=forecast-chart]', order: 'first' },
      { id: 'cta-copy', match: '[data-test=save-cta]', text: 'Save this location' },
      {
        id: 'promote-upsell',
        clone: {
          from: { url: '/pricing', match: '[data-test=plan-card]' },
          into: '[data-test=sidebar]',
          position: 'prepend',
          times: 3,
        },
      },
    ]);

    const shots: Buffer[] = [];
    for (let pass = 0; pass < 2; pass += 1) {
      const sources = await resolveSources(value);
      const { page, runtime, close } = await applyOn('/', value, sources);
      try {
        expect(variantWarnings(verdict(runtime))).toEqual([]);
        shots.push(await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' }));
      } finally {
        await close();
      }
    }

    expect(shots[0]?.equals(shots[1] as Buffer)).toBe(true);
  });

  it('re-applying at the next capture rebuilds the same DOM instead of stacking a second clone', async () => {
    const value = spec([
      { id: 'tighter-cards', match: '[data-test=forecast-card]', style: { padding: '8px' } },
      {
        id: 'promote-upsell',
        clone: {
          from: { url: '/pricing', match: '[data-test=plan-card]' },
          into: '[data-test=sidebar]',
          position: 'prepend',
          times: 2,
        },
      },
    ]);
    const sources = await resolveSources(value);
    const { page, runtime, close } = await applyOn('/', value, sources);
    try {
      const afterFirst = await page.innerHTML('body');

      // A flow captures several steps against one page without navigating between them, so the pass
      // runs again on a DOM that already carries the last capture's clones.
      await applyVariantForCapture(page, 'shot-2', runtime);

      expect(await page.innerHTML('body')).toBe(afterFirst);
      expect(await page.locator('[data-test=sidebar] .plan').count()).toBe(2);
      expect(variantWarnings(verdict(runtime))).toEqual([]);
    } finally {
      await close();
    }
  });
});
