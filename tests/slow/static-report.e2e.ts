/**
 * The exported bundle's page, opened the way a reviewer opens it: from a file, in a real browser
 * (CI spec D38). The fast suite pins the snapshot contract and the client; what only a browser can
 * prove is that the inlined app actually mounts over the embedded data — filmstrip, focus pane,
 * images resolving relative to the file — with no server anywhere.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportBundle } from '../../src/ci/export.js';
import { resolveAppScript } from '../../src/ci/app-script.js';
import {
  makeDiff,
  makeFinding,
  makeStepDiff,
  makeSummary,
  makeViewportDiff,
} from '../../src/report/ui/test-fixtures.js';
import { TINY_PNG } from '../../src/store/fixtures.js';
import { launchChromium } from '../../src/runner/browser.js';

let root: string;
let out: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vdiff-static-report-'));
  out = join(root, 'bundle');
  const store = join(root, '.visual-diff');
  const shot = (runId: string) =>
    join(store, 'runs/checkout', runId, 'steps/pay-form/1280x800/screenshot.png');
  for (const runId of ['0003', '0007']) {
    await mkdir(join(store, 'runs/checkout', runId, 'steps/pay-form/1280x800'), {
      recursive: true,
    });
    await writeFile(shot(runId), TINY_PNG);
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the exported report page in a real browser', () => {
  it('mounts the app over the embedded snapshot from file://', async () => {
    const appScript = await resolveAppScript();
    expect(appScript, 'run `pnpm build:ui` before the slow suite').not.toBeNull();

    const result = makeDiff({
      // The filmstrip is built from `flowDiff`, so the fixture needs the alignment entry too.
      flowDiff: [{ id: 'pay-form', status: 'matched', baseIndex: 0, headIndex: 0 }],
      steps: [
        makeStepDiff('pay-form', 'matched', {
          viewports: {
            '1280x800': makeViewportDiff('1280x800', {
              pixelChangedRatio: 0.12,
              findings: [makeFinding('f1')],
            }),
          },
        }),
      ],
      summary: makeSummary({
        totalFindings: 1,
        bySeverity: { high: 0, med: 1, low: 0 },
        stepsCompared: 1,
        stepsChanged: 1,
        maxPixelChangedRatio: 0.12,
      }),
    });

    await exportBundle({
      root,
      result,
      outDir: out,
      images: 'changed',
      appScript,
      version: '0.7.0',
      generatedAt: '2026-08-31T00:00:00.000Z',
    });

    const browser = await launchChromium();
    try {
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(String(error)));
      page.on('request', (request) => {
        if (!request.url().startsWith('file://')) failures.push(`external: ${request.url()}`);
      });

      await page.goto(pathToFileURL(join(out, 'report.html')).href);

      // The app mounted: the filmstrip exists and the exported step is selectable.
      await page.waitForSelector('.filmstrip', { timeout: 15_000 });
      await expect(page.textContent('body')).resolves.toContain('pay-form');
      // The snapshot banner names the pair, so a reader knows this is an export.
      await expect(page.textContent('.snapshot-banner')).resolves.toContain('0003..0007');
      // Images resolved through the map: at least one <img> points into images/ and rendered.
      const shot = await page.waitForSelector('img[src*="images/"]', { timeout: 15_000 });
      expect(await shot.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

      expect(failures).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
