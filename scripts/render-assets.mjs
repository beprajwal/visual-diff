// Rasterise assets/*.svg to the PNGs the README embeds.
//
// The SVGs are the source; the README points at PNGs because npm rewrites relative image paths to
// raw.githubusercontent.com, which serves SVG as text/plain and so renders it as a broken image.
//
// Run: node scripts/render-assets.mjs   (needs the Chromium `vdiff install-browser` fetches)
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const assets = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const targets = [
  { svg: 'logo.svg', out: 'logo.png', width: 512, height: 512 },
  { svg: 'logo.svg', out: 'logo-128.png', width: 128, height: 128 },
  { svg: 'cover.svg', out: 'cover.png', width: 1280, height: 400, scale: 2 },
];

const browser = await chromium.launch();
try {
  for (const target of targets) {
    const svg = readFileSync(resolve(assets, target.svg), 'utf8');
    const page = await browser.newPage({
      viewport: { width: target.width, height: target.height },
      deviceScaleFactor: target.scale ?? 1,
    });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0;background:transparent}` +
        `svg{display:block;width:${target.width}px;height:${target.height}px}</style>${svg}`,
      { waitUntil: 'load' },
    );
    const png = await page.screenshot({ omitBackground: true, type: 'png' });
    writeFileSync(resolve(assets, target.out), png);
    console.log(`${target.out} — ${target.width}x${target.height}@${target.scale ?? 1}, ${png.length} bytes`);
    await page.close();
  }
} finally {
  await browser.close();
}
