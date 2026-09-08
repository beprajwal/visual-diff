/**
 * The capture, in a real browser (CI spec D51). The fast suites pin the renderer and the flags;
 * only a browser can prove that the bundle's page is photographed at the viewport promised, in
 * both colour schemes, from a `file://` URL.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PREVIEW_FILES, PREVIEW_VIEWPORT, capturePreview } from './preview.js';

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

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let out: string;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'vdiff-preview-'));
  // A stand-in for the exported page: the class the capture waits for, and a colour that follows
  // the scheme, so the two captures can be told apart by their pixels.
  await writeFile(
    join(out, 'report.html'),
    `<!doctype html><meta charset="utf-8"><title>report</title>
<style>
  body { margin: 0; background: #ffffff; }
  @media (prefers-color-scheme: dark) { body { background: #000000; } }
</style>
<div class="filmstrip">pay-form</div>`,
  );
});

afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

describeIfBrowser('capturePreview', () => {
  it('writes a light and a dark capture of the page at the preview viewport', async () => {
    const report = await capturePreview({ outDir: out, timeoutMs: 5_000 });
    expect(report.files).toEqual([PREVIEW_FILES.light, PREVIEW_FILES.dark]);

    const light = await readFile(join(out, PREVIEW_FILES.light));
    const dark = await readFile(join(out, PREVIEW_FILES.dark));
    expect(pngSize(light)).toEqual({ ...PREVIEW_VIEWPORT });
    expect(pngSize(dark)).toEqual({ ...PREVIEW_VIEWPORT });
    // Different schemes, different pictures.
    expect(light.equals(dark)).toBe(false);
  });

  it('still captures a page that never shows the ready selector', async () => {
    const report = await capturePreview({
      outDir: out,
      readySelector: '.never-mounts',
      timeoutMs: 500,
    });
    expect(report.files).toHaveLength(2);
  });
});
