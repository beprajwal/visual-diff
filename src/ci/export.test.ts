import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DiffResult } from '../types.js';
import {
  makeDiff,
  makeFinding,
  makeStepDiff,
  makeSummary,
  makeViewportDiff,
} from '../report/ui/test-fixtures.js';
import type { ReportSnapshot } from '../report/ui/snapshot.js';
import { TINY_PNG } from '../store/fixtures.js';
import { fakeReview } from '../cli/testing.js';
import { LOGO_URL } from './comment.js';
import { exportBundle } from './export.js';
import { evaluateGate } from './gate.js';
import type { BundleSummary } from './export.js';

const PIXEL_PATH = 'diffs/checkout/0003..0007/steps/pay-form/1280x800/pixel.png';
const CROP_PATH = 'diffs/checkout/0003..0007/crops/f1.png';

/** The snapshot the page embeds (D38), parsed back out of the rendered HTML. */
function snapshotOf(html: string): ReportSnapshot {
  const match = /<script type="application\/json" id="vdiff-snapshot">([\s\S]*?)<\/script>/.exec(
    html,
  );
  if (match === null) throw new Error('page carries no snapshot');
  return JSON.parse(match[1] as string) as ReportSnapshot;
}

function fixtureDiff(): DiffResult {
  return makeDiff({
    steps: [
      makeStepDiff('pay-form', 'matched', {
        viewports: {
          '1280x800': makeViewportDiff('1280x800', {
            pixelChangedRatio: 0.03,
            findings: [makeFinding('f1', { crop: CROP_PATH })],
            pixelPath: PIXEL_PATH,
          }),
        },
      }),
      makeStepDiff('cart', 'matched', {
        viewports: { '1280x800': makeViewportDiff('1280x800') },
      }),
    ],
    summary: makeSummary({
      totalFindings: 1,
      bySeverity: { high: 0, med: 1, low: 0 },
      stepsCompared: 2,
      stepsChanged: 1,
      maxPixelChangedRatio: 0.03,
    }),
  });
}

/** A store holding just the blobs a bundle copies: two captures, one pixel diff, one crop. */
async function seedStore(root: string): Promise<void> {
  const png = Buffer.from(TINY_PNG);
  for (const runId of ['0003', '0007']) {
    const dir = join(root, '.visual-diff', 'runs', 'checkout', runId, 'steps', 'pay-form', '1280x800');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'screenshot.png'), png);
  }
  await mkdir(join(root, '.visual-diff', 'diffs', 'checkout', '0003..0007', 'steps', 'pay-form', '1280x800'), {
    recursive: true,
  });
  await writeFile(join(root, '.visual-diff', PIXEL_PATH), png);
  await mkdir(join(root, '.visual-diff', 'diffs', 'checkout', '0003..0007', 'crops'), {
    recursive: true,
  });
  await writeFile(join(root, '.visual-diff', CROP_PATH), png);
}

/** Every file in a directory tree, bundle-relative, sorted. */
async function inventory(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await inventory(join(dir, entry.name), rel)));
    else found.push(rel);
  }
  return found.sort();
}

describe('exportBundle', () => {
  let root: string;
  let out: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vdiff-ci-'));
    out = join(root, 'bundle');
    await seedStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the four documents and the changed shots', async () => {
    const report = await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });

    expect(await inventory(out)).toEqual([
      'comment.md',
      'findings.json',
      'images/crops/f1.png',
      'images/pay-form/1280x800/base.png',
      'images/pay-form/1280x800/head.png',
      'images/pay-form/1280x800/pixel.png',
      'report.html',
      'summary.json',
    ]);
    expect(report.images).toBe(4);
    expect(report.missing).toEqual([]);
  });

  it('copies every compared shot under images=all and none under images=none', async () => {
    await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'all',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });
    // `cart` has no capture on disk in this fixture, so it is reported rather than invented.
    const all = await inventory(out);
    expect(all).toContain('images/pay-form/1280x800/base.png');
    expect(all).not.toContain('images/cart/1280x800/base.png');

    const bare = join(root, 'bare');
    const report = await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: bare,
      images: 'none',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });
    expect(await inventory(bare)).toEqual([
      'comment.md',
      'findings.json',
      'report.html',
      'summary.json',
    ]);
    expect(report.images).toBe(0);
  });

  it('reports a missing source instead of failing', async () => {
    await rm(join(root, '.visual-diff', PIXEL_PATH));
    const report = await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });
    expect(report.missing).toEqual(['images/pay-form/1280x800/pixel.png']);
    expect(report.files).toContain('images/pay-form/1280x800/head.png');
  });

  it('stores the diff verbatim', async () => {
    const result = fixtureDiff();
    await exportBundle({
      root,
      result,
      outDir: out,
      images: 'changed',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });
    const parsed = JSON.parse(await readFile(join(out, 'findings.json'), 'utf8')) as DiffResult;
    expect(parsed).toEqual(result);
  });

  it('summarises the pair, both runs and the gate', async () => {
    const gate = evaluateGate(fixtureDiff().summary, 'high');
    await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
      notices: ['e2e-pair: both sides were ingested'],
      gate,
    });
    const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8')) as BundleSummary;
    expect(summary.flow).toBe('checkout');
    expect(summary.pair).toEqual({ base: '0003', head: '0007' });
    expect(summary.gate).toEqual(gate);
    expect(summary.notices).toEqual(['e2e-pair: both sides were ingested']);
    expect(summary.runs.base.revision.sha).toBe('sha-0003');
    expect(summary.runs.head.env.chromium).toBe('131');
    expect(summary.files).toContain('summary.json');
  });

  it('renders a comment whose images resolve inside the bundle', async () => {
    await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });
    const comment = await readFile(join(out, 'comment.md'), 'utf8');
    expect(comment).toContain('src="./images/pay-form/1280x800/pixel.png"');
    // Every picture of the *diff* resolves inside the bundle. The one external reference the
    // comment may carry is the product mark in its heading, which is not evidence.
    const sources = [...comment.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
    expect(sources.length).toBeGreaterThan(1);
    for (const src of sources) {
      if (src === LOGO_URL) continue;
      expect(src, src).toMatch(/^\.\/images\//);
    }
    expect(comment.replace(LOGO_URL, '')).not.toContain('http');
  });

  it('renders the interactive page over an embedded snapshot, requesting nothing external (D38)', async () => {
    await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      appScript: 'APP_STUB()',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });
    const html = await readFile(join(out, 'report.html'), 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('<script>APP_STUB()</script>');

    const snapshot = snapshotOf(html);
    expect(snapshot.flow).toBe('checkout');
    expect(snapshot.diff.pair).toEqual({ base: '0003', head: '0007' });
    expect(snapshot.runs.map((r) => r.runId)).toEqual(['0003', '0007']);
    // Linked mode: every image the map offers is a bundle-relative path to a file that copied —
    // a source that was absent is simply not in the map, never a broken reference.
    const values = Object.values(snapshot.images);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value.startsWith('images/')).toBe(true);
    expect(values).toContain('images/pay-form/1280x800/base.png');
  });

  it('writes a page with the data and a note when the app script is not available', async () => {
    await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      appScript: null,
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });
    const html = await readFile(join(out, 'report.html'), 'utf8');
    expect(html).not.toContain('<script>');
    expect(html).toContain('exported without the report UI');
    expect(snapshotOf(html).flow).toBe('checkout');
  });

  it('embeds the shots under html=inline, so report.html alone is the report', async () => {
    const report = await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      html: 'inline',
      appScript: 'APP_STUB()',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });
    const snapshot = snapshotOf(await readFile(join(out, 'report.html'), 'utf8'));
    const values = Object.values(snapshot.images);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value.startsWith('data:image/png;base64,')).toBe(true);
    // The rest of the bundle is untouched: images/ still ships, and no second page appears.
    expect(report.files).toContain('images/pay-form/1280x800/base.png');
    expect(report.files).not.toContain('report.inline.html');
  });

  it('writes the linked page plus report.inline.html under html=both', async () => {
    const report = await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      html: 'both',
      appScript: 'APP_STUB()',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });
    expect(report.files).toContain('report.html');
    expect(report.files).toContain('report.inline.html');
    const linked = snapshotOf(await readFile(join(out, 'report.html'), 'utf8'));
    expect(Object.values(linked.images)).toContain('images/pay-form/1280x800/base.png');
    const inline = snapshotOf(await readFile(join(out, 'report.inline.html'), 'utf8'));
    for (const value of Object.values(inline.images)) {
      expect(value.startsWith('data:image/png;base64,')).toBe(true);
    }
    const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8')) as BundleSummary;
    expect(summary.html).toBe('both');
    expect(summary.files).toContain('report.inline.html');
  });
});

describe('exportBundle with a review (D39)', () => {
  let root: string;
  let out: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vdiff-export-review-'));
    out = join(root, 'bundle');
    await seedStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes review.json, renders it into comment.md and embeds it in the snapshot', async () => {
    const review = fakeReview({ headline: 'The Pay button grew wider.' });
    const report = await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      appScript: 'APP_STUB()',
      version: '0.9.0',
      generatedAt: '2026-09-07T09:00:00.000Z',
      review,
    });
    expect(report.files).toContain('review.json');
    expect(JSON.parse(await readFile(join(out, 'review.json'), 'utf8'))).toEqual(review);

    const comment = await readFile(join(out, 'comment.md'), 'utf8');
    expect(comment).toContain('#### Review');
    expect(comment).toContain('**The Pay button grew wider.**');

    const snapshot = snapshotOf(await readFile(join(out, 'report.html'), 'utf8'));
    expect(snapshot.review).toEqual(review);

    const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8')) as BundleSummary;
    expect(summary.review).toEqual(review);
    expect(summary.files).toContain('review.json');
  });

  it('writes the bundle exactly as before when there is no review', async () => {
    const report = await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      version: '0.9.0',
      generatedAt: '2026-09-07T09:00:00.000Z',
    });
    expect(report.files).not.toContain('review.json');
    const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8')) as BundleSummary;
    expect(summary.review).toBeNull();
    expect(await readFile(join(out, 'comment.md'), 'utf8')).not.toContain('#### Review');
  });
});
