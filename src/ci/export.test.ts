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
import { TINY_PNG } from '../store/fixtures.js';
import { exportBundle } from './export.js';
import { evaluateGate } from './gate.js';
import type { BundleSummary } from './export.js';

const PIXEL_PATH = 'diffs/checkout/0003..0007/steps/pay-form/1280x800/pixel.png';
const CROP_PATH = 'diffs/checkout/0003..0007/crops/f1.png';

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
    expect(comment).not.toContain('http');
  });

  it('renders a static page that requests nothing off its own directory', async () => {
    await exportBundle({
      root,
      result: fixtureDiff(),
      outDir: out,
      images: 'changed',
      version: '0.6.0',
      generatedAt: '2026-08-11T09:00:00.000Z',
    });
    const html = await readFile(join(out, 'report.html'), 'utf8');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('src="images/pay-form/1280x800/base.png"');
    // A cell whose files were not copied says so rather than showing a broken image.
    expect(html).toContain('not in this bundle');
    expect(html).toContain('findings.json');
  });
});
