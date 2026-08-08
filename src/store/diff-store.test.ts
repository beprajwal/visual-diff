import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hasDiff,
  invalidateDiff,
  listAllStoredPairs,
  listStoredPairs,
  readDiff,
  readFindingsCount,
  readRegions,
  runsReferencedByDiffs,
  statBlob,
  writeCrop,
  writeDiff,
  writePixelDiff,
  writeRegions,
} from './diff-store.js';
import { TINY_PNG, makeRunMeta } from './fixtures.js';
import * as paths from './paths.js';
import type { DiffResult, RunId, RunMeta } from '../types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-diffs-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

function meta(flow: string, runId: RunId): RunMeta {
  return { ...makeRunMeta(flow), runId } as RunMeta;
}

function makeDiff(
  flow: string,
  base: RunId,
  head: RunId,
  engineVersion = '1',
  totalFindings = 3,
): DiffResult {
  return {
    engineVersion,
    flow,
    pair: { base, head },
    computedAt: '2026-08-08T10:05:00.000Z',
    baseMeta: meta(flow, base),
    headMeta: meta(flow, head),
    flowDiff: [{ id: 'cart', status: 'matched', baseIndex: 0, headIndex: 0 }],
    steps: [{ id: 'cart', status: 'matched', viewports: {}, findings: [] }],
    summary: {
      totalFindings,
      bySeverity: { high: 1, med: 1, low: 1 },
      byKind: {
        content: totalFindings,
        style: 0,
        layout: 0,
        structural: 0,
        a11y: 0,
        console: 0,
        network: 0,
      },
      stepsCompared: 1,
      stepsChanged: 1,
      stepsAdded: 0,
      stepsRemoved: 0,
      stepsSpecChanged: 0,
      stepsFailed: 0,
      stepsBlocked: 0,
      maxPixelChangedRatio: 0.021,
    },
    warnings: [],
  };
}

describe('the findings cache', () => {
  it('is keyed by (base, head, engineVersion)', async () => {
    await writeDiff(tmp, makeDiff('checkout', '0003', '0007', '1'));

    expect(await readDiff(tmp, 'checkout', '0003', '0007', '1')).not.toBeNull();
    // A different pair is a different entry.
    expect(await readDiff(tmp, 'checkout', '0004', '0007', '1')).toBeNull();
    // Bumping the engine version invalidates the entry rather than serving stale output.
    expect(await readDiff(tmp, 'checkout', '0003', '0007', '2')).toBeNull();
    // Omitting the version reads whatever is stored.
    expect((await readDiff(tmp, 'checkout', '0003', '0007'))?.engineVersion).toBe('1');
  });

  it('writes findings.json inside the pair directory', async () => {
    await writeDiff(tmp, makeDiff('checkout', '0003', '0007'));
    expect(await hasDiff(tmp, 'checkout', '0003', '0007')).toBe(true);
    const file = paths.diffFindingsFile(tmp, 'checkout', '0003', '0007');
    expect(file).toContain(path.join('diffs', 'checkout', '0003..0007', 'findings.json'));
    const text = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });

  it('round-trips the summary count for the timeline', async () => {
    await writeDiff(tmp, makeDiff('checkout', '0003', '0007', '1', 12));
    expect(await readFindingsCount(tmp, 'checkout', '0003', '0007')).toBe(12);
    expect(await readFindingsCount(tmp, 'checkout', '0001', '0002')).toBeNull();
  });

  it('invalidates by deleting the whole pair directory, blobs included', async () => {
    await writeDiff(tmp, makeDiff('checkout', '0003', '0007'));
    await writeCrop(tmp, 'checkout', '0003', '0007', 'f1', TINY_PNG);
    await invalidateDiff(tmp, 'checkout', '0003', '0007');
    expect(await hasDiff(tmp, 'checkout', '0003', '0007')).toBe(false);
    expect(await statBlob(tmp, 'diffs/checkout/0003..0007/crops/f1.png')).toBeNull();
  });
});

describe('stored pairs', () => {
  it('lists pairs per flow and across flows', async () => {
    await writeDiff(tmp, makeDiff('checkout', '0003', '0007'));
    await writeDiff(tmp, makeDiff('checkout', '0007', '0008'));
    await writeDiff(tmp, makeDiff('search', '0000', '0001'));

    expect(await listStoredPairs(tmp, 'checkout')).toEqual([
      { flow: 'checkout', base: '0003', head: '0007' },
      { flow: 'checkout', base: '0007', head: '0008' },
    ]);
    expect((await listAllStoredPairs(tmp)).map((pair) => `${pair.flow}:${pair.base}..${pair.head}`))
      .toEqual(['checkout:0003..0007', 'checkout:0007..0008', 'search:0000..0001']);
  });

  it('reports which runs a stored diff references, so retention can exempt them', async () => {
    await writeDiff(tmp, makeDiff('checkout', '0003', '0007'));
    const referenced = await runsReferencedByDiffs(tmp, 'checkout');
    expect([...referenced].sort()).toEqual(['0003', '0007']);
  });

  it('ignores directories that are not pair names', async () => {
    await fsp.mkdir(path.join(paths.flowDiffsDir(tmp, 'checkout'), 'scratch'), { recursive: true });
    expect(await listStoredPairs(tmp, 'checkout')).toEqual([]);
  });
});

describe('diff blobs', () => {
  it('returns paths relative to .visual-diff, as the contracts carry them', async () => {
    const crop = await writeCrop(tmp, 'checkout', '0003', '0007', 'f1', TINY_PNG);
    const pixel = await writePixelDiff(
      tmp,
      'checkout',
      '0003',
      '0007',
      'pay-form',
      '1280x800',
      TINY_PNG,
    );
    const regions = await writeRegions(tmp, 'checkout', '0003', '0007', 'pay-form', '1280x800', {
      regions: [{ id: 'r1', rect: { x: 6, y: 56, w: 86, h: 19 }, area: 1634, changedPixels: 800, density: 0.49 }],
      dropped: 2,
      collapsed: 0,
      totalFound: 3,
    });

    expect(crop).toBe('diffs/checkout/0003..0007/crops/f1.png');
    expect(pixel).toBe('diffs/checkout/0003..0007/steps/pay-form/1280x800/pixel.png');
    expect(regions).toBe('diffs/checkout/0003..0007/steps/pay-form/1280x800/regions.json');

    expect(await statBlob(tmp, crop)).toBe(TINY_PNG.byteLength);
    expect(await statBlob(tmp, pixel)).toBe(TINY_PNG.byteLength);

    const stored = await readRegions(tmp, 'checkout', '0003', '0007', 'pay-form', '1280x800');
    expect(stored).toMatchObject({ dropped: 2, totalFound: 3 });
  });

  it('refuses to stat a blob outside the store', async () => {
    expect(() => paths.resolveInsideVdiff(tmp, '../../etc/passwd')).toThrow();
    await expect(statBlob(tmp, '../../etc/passwd')).rejects.toThrow(/escapes/);
  });
});
