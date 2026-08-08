import { describe, expect, it } from 'vitest';
import type { Rect } from '../types.js';
import { clusterRegions, connectedComponents } from './regions.js';

const W = 200;
const H = 120;

function maskOf(rects: Rect[], width = W, height = H): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y += 1) {
      for (let x = r.x; x < r.x + r.w; x += 1) mask[y * width + x] = 1;
    }
  }
  return mask;
}

const opts = { minRegionArea: 64, maxRegions: 40 };

describe('connectedComponents', () => {
  it('finds one component per blob with its bounding box and pixel count', () => {
    const mask = maskOf([
      { x: 5, y: 5, w: 10, h: 10 },
      { x: 100, y: 60, w: 4, h: 6 },
    ]);

    const { components } = connectedComponents(mask, W, H);

    expect(components).toHaveLength(2);
    expect(components[0]).toEqual({ rect: { x: 5, y: 5, w: 10, h: 10 }, pixels: 100 });
    expect(components[1]).toEqual({ rect: { x: 100, y: 60, w: 4, h: 6 }, pixels: 24 });
  });

  it('treats diagonally touching pixels as one component', () => {
    const mask = maskOf([
      { x: 10, y: 10, w: 1, h: 1 },
      { x: 11, y: 11, w: 1, h: 1 },
    ]);

    expect(connectedComponents(mask, W, H).components).toHaveLength(1);
  });
});

describe('clusterRegions', () => {
  it('merges blobs that sit within the proximity budget', () => {
    const near = clusterRegions(
      maskOf([
        { x: 10, y: 10, w: 20, h: 20 },
        { x: 35, y: 10, w: 20, h: 20 },
      ]),
      W,
      H,
      opts,
    );

    expect(near.regions).toHaveLength(1);
    expect(near.regions[0]?.rect).toEqual({ x: 10, y: 10, w: 45, h: 20 });
    expect(near.regions[0]?.changedPixels).toBe(800);
  });

  it('keeps blobs further apart than the proximity budget separate', () => {
    const far = clusterRegions(
      maskOf([
        { x: 10, y: 10, w: 20, h: 20 },
        { x: 60, y: 10, w: 30, h: 20 },
      ]),
      W,
      H,
      opts,
    );

    expect(far.regions).toHaveLength(2);
    // Sorted by area, largest first.
    expect(far.regions.map((r) => r.area)).toEqual([600, 400]);
    expect(far.regions.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('drops regions below minRegionArea and counts them', () => {
    const result = clusterRegions(
      maskOf([
        { x: 10, y: 10, w: 4, h: 4 },
        { x: 100, y: 60, w: 20, h: 20 },
      ]),
      W,
      H,
      opts,
    );

    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.area).toBe(400);
    expect(result.dropped).toBe(1);
    expect(result.totalFound).toBe(2);
  });

  it('caps at maxRegions and collapses the remainder into one entry', () => {
    const blobs: Rect[] = [];
    for (let i = 0; i < 5; i += 1) blobs.push({ x: 10 + i * 30, y: 10, w: 10 + i, h: 10 });

    const result = clusterRegions(maskOf(blobs), W, H, { minRegionArea: 64, maxRegions: 2 });

    expect(result.totalFound).toBe(5);
    expect(result.regions).toHaveLength(2);
    expect(result.collapsed).toBe(3);
    expect(result.collapsedRect).not.toBeNull();
    expect(result.collapsedPixels).toBe(10 * 10 + 11 * 10 + 12 * 10);
    // The two biggest survive; the collapsed box spans the three smallest.
    expect(result.regions.map((r) => r.rect.w)).toEqual([14, 13]);
    expect(result.collapsedRect).toEqual({ x: 10, y: 10, w: 72, h: 10 });
  });

  it('excludes regions sitting inside a mask rect', () => {
    const result = clusterRegions(
      maskOf([
        { x: 10, y: 10, w: 20, h: 20 },
        { x: 100, y: 60, w: 20, h: 20 },
      ]),
      W,
      H,
      { ...opts, exclude: [{ x: 5, y: 5, w: 40, h: 40 }] },
    );

    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.rect).toEqual({ x: 100, y: 60, w: 20, h: 20 });
    expect(result.excluded).toBe(1);
    expect(result.dropped).toBe(1);
  });

  it('keeps a region that only partly overlaps a mask rect', () => {
    const result = clusterRegions(maskOf([{ x: 10, y: 10, w: 40, h: 20 }]), W, H, {
      ...opts,
      exclude: [{ x: 0, y: 0, w: 20, h: 100 }],
    });

    expect(result.regions).toHaveLength(1);
    expect(result.excluded).toBe(0);
  });

  it('returns nothing for an empty mask', () => {
    const result = clusterRegions(new Uint8Array(W * H), W, H, opts);
    expect(result).toMatchObject({ regions: [], dropped: 0, collapsed: 0, totalFound: 0 });
  });

  it('computes density as changed pixels over bounding-box area', () => {
    // An L shape: bounding box 20x20, only 300 of the 400 pixels changed.
    const result = clusterRegions(
      maskOf([
        { x: 10, y: 10, w: 20, h: 10 },
        { x: 10, y: 20, w: 10, h: 10 },
      ]),
      W,
      H,
      opts,
    );

    expect(result.regions[0]?.area).toBe(400);
    expect(result.regions[0]?.changedPixels).toBe(300);
    expect(result.regions[0]?.density).toBeCloseTo(0.75, 6);
  });
});
