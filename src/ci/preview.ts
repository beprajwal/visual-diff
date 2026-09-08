/**
 * The comment's picture of the report (CI spec D51).
 *
 * A pull-request comment that opens with a screenshot of the report page — the filmstrip, the
 * verdict, the first changed step with its pixel diff — is read; one that opens with a table is
 * skimmed. So the bundle carries two captures of its own `report.html`, one per colour scheme, and
 * the comment shows whichever matches the reader's GitHub theme, the whole picture linking to the
 * hosted page.
 *
 * Two decisions:
 *
 *  1. **The bundle's own page is what is photographed.** Not a purpose-built card: the picture has
 *     to be what the reader lands on when they click it, or the click is a disappointment. The page
 *     is opened from the file the bundle wrote, so the capture proves the export is self-sufficient
 *     as a side effect.
 *  2. **A missing browser is a warning, never a failure.** The evidence is the bundle; the picture
 *     is a courtesy. `vdiff export --preview` on a machine with no Chromium exports and says so.
 */

import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Browser } from 'playwright-core';

import { launchChromium } from '../runner/browser.js';

/** Bundle-relative paths of the two captures. Under `images/` so a publish step ships them. */
export const PREVIEW_FILES = {
  light: 'images/preview.png',
  dark: 'images/preview-dark.png',
} as const;

export type PreviewScheme = keyof typeof PREVIEW_FILES;

/**
 * The viewport the page is photographed at. Wide enough for the filmstrip and the focus pane to sit
 * side by side, as they do for a reviewer; tall enough for the verdict and the first changed step.
 * Not a full-page capture: a report with forty steps is a very long picture and a very small one
 * once GitHub scales it to the comment column.
 */
export const PREVIEW_VIEWPORT = { width: 1280, height: 800 } as const;

export interface PreviewRequest {
  /** Bundle directory holding `report.html` (and `images/`, which the page addresses relatively). */
  outDir: string;
  /** `report.html` by default; `report.inline.html` when the bundle was written with `--html inline`. */
  page?: string;
  /** Selector that says the app has mounted over the snapshot. */
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

const DEFAULT_READY_SELECTOR = '.filmstrip';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function capturePreview(request: PreviewRequest): Promise<PreviewReport> {
  const pageFile = path.join(request.outDir, request.page ?? 'report.html');
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
        // The page is data plus an app that mounts over it; the capture waits for the mount. A page
        // exported without the app bundle (no `dist/ui`) never shows the selector, and is
        // photographed as it is once the wait runs out — the data is still on it.
        await page
          .waitForSelector(request.readySelector ?? DEFAULT_READY_SELECTOR, {
            timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          })
          .catch(() => undefined);
        // Images are what the picture is for; give the ones in view a moment to decode.
        await page
          .waitForFunction(
            () =>
              Array.from(document.images)
                .filter((img) => img.getBoundingClientRect().top < window.innerHeight)
                .every((img) => img.complete),
            undefined,
            { timeout: 5_000 },
          )
          .catch(() => undefined);
        const relative = PREVIEW_FILES[scheme];
        await page.screenshot({ path: path.join(request.outDir, relative), fullPage: false });
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
