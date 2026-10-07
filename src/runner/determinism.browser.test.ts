/**
 * The determinism layer against a real Chromium: an inner scroller styled `scroll-behavior: smooth`
 * — the shape of a chat transcript — must land a programmatic scroll at once, or a capture taken
 * right after it photographs the page mid-animation at a different offset on every run.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Browser } from 'playwright-core';

import { launchChromium, newContext } from './browser.js';

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

const PAGE = `<!doctype html><html><body style="margin:0">
<div id="viewport" style="height:200px;overflow:auto;scroll-behavior:smooth">
  <div style="height:5000px"></div>
</div>
</body></html>`;

let browser: Browser;

beforeAll(async () => {
  if (!chromiumAvailable()) return;
  browser = await launchChromium();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describeIfBrowser('determinism in the browser', () => {
  it.each([
    ['inherits the element style', 'auto'],
    ['asks for smooth outright', 'smooth'],
  ])('lands an inner scroll that %s in the same frame', async (_label, behavior) => {
    const context = await newContext(browser, {
      viewport: { id: '400x300', width: 400, height: 300 },
      network: 'off',
    });
    try {
      const page = await context.newPage();
      await page.goto(`data:text/html,${encodeURIComponent(PAGE)}`);
      const top = await page.evaluate((how) => {
        const viewport = document.getElementById('viewport') as HTMLElement;
        viewport.scrollTo({ top: 3000, behavior: how as ScrollBehavior });
        return viewport.scrollTop;
      }, behavior);
      expect(top).toBe(3000);
    } finally {
      await context.close();
    }
  });
});
