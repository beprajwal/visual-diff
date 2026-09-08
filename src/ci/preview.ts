/**
 * The comment's picture (CI spec D51).
 *
 * A pull-request comment that opens with a picture of the changes is read; one that opens with a
 * table is skimmed. So the bundle carries two captures of its own card (`preview.html`, a numbered
 * list of what moved with base and head side by side — `preview-card.ts`), one per colour scheme,
 * and the comment shows whichever matches the reader's GitHub theme, the whole picture linking to
 * the hosted report.
 *
 * Two decisions:
 *
 *  1. **The card is photographed, not the report page.** The report is the tool — filmstrip, key
 *     bindings, panes; the card is the changes. The picture's job is to make the reader click, and
 *     what earns the click is the change itself. The card is opened from the file the bundle wrote.
 *  2. **A missing browser is a warning, never a failure.** The evidence is the bundle; the picture
 *     is a courtesy. `vdiff export --preview` on a machine with no Chromium exports and says so.
 */

import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Browser } from 'playwright-core';

import { launchChromium } from '../runner/browser.js';
import { PREVIEW_CARD_WIDTH, PREVIEW_PAGE } from './preview-card.js';

/** Bundle-relative paths of the two captures. Under `images/` so a publish step ships them. */
export const PREVIEW_FILES = {
  light: 'images/preview.png',
  dark: 'images/preview-dark.png',
} as const;

export type PreviewScheme = keyof typeof PREVIEW_FILES;

/**
 * The viewport the card is opened at. The width is the card's own; the height is a floor — the
 * capture is full-page, so a card with six changes is as tall as six changes, and the card caps
 * itself so the picture never becomes a ribbon once GitHub fits it to the comment column.
 */
export const PREVIEW_VIEWPORT = { width: PREVIEW_CARD_WIDTH, height: 600 } as const;

export interface PreviewRequest {
  /** Bundle directory holding the card (and `images/`, which it addresses relatively). */
  outDir: string;
  /** The page to photograph, bundle-relative. The card, `preview.html`, by default. */
  page?: string;
  /** Selector that says the page has rendered. */
  readySelector?: string;
  /** Milliseconds to wait for the selector before the capture proceeds regardless. */
  timeoutMs?: number;
  /** Injected by tests. */
  launch?: () => Promise<Browser>;
}

export interface PreviewReport {
  /** Bundle-relative paths written, light first. */
  files: string[];
}

const DEFAULT_READY_SELECTOR = '.preview-card';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function capturePreview(request: PreviewRequest): Promise<PreviewReport> {
  const pageFile = path.join(request.outDir, request.page ?? PREVIEW_PAGE);
  const launch = request.launch ?? launchChromium;
  const browser = await launch();
  const files: string[] = [];
  try {
    await mkdir(path.join(request.outDir, 'images'), { recursive: true });
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { ...PREVIEW_VIEWPORT },
        deviceScaleFactor: 1,
        colorScheme: scheme,
      });
      try {
        const page = await context.newPage();
        await page.goto(pathToFileURL(pageFile).href, { waitUntil: 'load' });
        // Waits for the page to say it has rendered, and photographs it as it is once the wait runs
        // out: a page that never shows the selector is still a page.
        await page
          .waitForSelector(request.readySelector ?? DEFAULT_READY_SELECTOR, {
            timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          })
          .catch(() => undefined);
        // The captures are what the picture is for; give every one of them a moment to decode.
        await page
          .waitForFunction(() => Array.from(document.images).every((img) => img.complete), undefined, {
            timeout: 5_000,
          })
          .catch(() => undefined);
        const relative = PREVIEW_FILES[scheme];
        await page.screenshot({ path: path.join(request.outDir, relative), fullPage: true });
        files.push(relative);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { files };
}
