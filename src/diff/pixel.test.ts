import { describe, expect, it } from 'vitest';
import { createImage, cropImage, decodePng, encodePng, pixelDiff, renderPixelOverlay } from './pixel.js';
import { paintRect } from './testkit.js';

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const RED: [number, number, number, number] = [220, 20, 20, 255];

describe('png round trip', () => {
  it('decodes what it encodes', () => {
    const image = paintRect(createImage(12, 8, WHITE), { x: 2, y: 2, w: 4, h: 4 }, RED);
    const decoded = decodePng(encodePng(image));

    expect(decoded.width).toBe(12);
    expect(decoded.height).toBe(8);
    expect([...decoded.data.subarray(0, 4)]).toEqual([...WHITE]);
    const centre = ((3 * 12) + 3) * 4;
    expect([...decoded.data.subarray(centre, centre + 4)]).toEqual([...RED]);
  });
});

describe('pixelDiff', () => {
  it('reports zero change for identical images', () => {
    const a = paintRect(createImage(40, 30, WHITE), { x: 5, y: 5, w: 10, h: 10 }, RED);
    const b = paintRect(createImage(40, 30, WHITE), { x: 5, y: 5, w: 10, h: 10 }, RED);

    const diff = pixelDiff(a, b, { antialiasTolerance: 0.1 });

    expect(diff.changedPixels).toBe(0);
    expect(diff.changedRatio).toBe(0);
    expect(diff.dimensionsChanged).toBe(false);
    expect(diff.mask.some((v) => v === 1)).toBe(false);
  });

  it('marks the changed area in the mask', () => {
    const a = createImage(40, 30, WHITE);
    const b = paintRect(createImage(40, 30, WHITE), { x: 10, y: 10, w: 8, h: 8 }, RED);

    const diff = pixelDiff(a, b, { antialiasTolerance: 0.1 });

    expect(diff.changedPixels).toBeGreaterThan(0);
    expect(diff.compared).toEqual({ w: 40, h: 30 });
    // The interior of the block is unambiguously changed; edges may be treated as antialiasing.
    expect(diff.mask[14 * 40 + 14]).toBe(1);
    expect(diff.mask[0]).toBe(0);
    expect(diff.changedRatio).toBeCloseTo(diff.changedPixels / (40 * 30), 10);
  });

  it('flags differing dimensions and compares only the common area', () => {
    const a = createImage(40, 30, WHITE);
    const b = createImage(40, 50, WHITE);

    const diff = pixelDiff(a, b, { antialiasTolerance: 0.1 });

    expect(diff.dimensionsChanged).toBe(true);
    expect(diff.base).toEqual({ w: 40, h: 30 });
    expect(diff.head).toEqual({ w: 40, h: 50 });
    expect(diff.compared).toEqual({ w: 40, h: 30 });
    // The page grew, but the shared area is untouched, so this is not "100% changed".
    expect(diff.changedPixels).toBe(0);
    expect(diff.mask).toHaveLength(40 * 30);
  });

  it('survives a zero-overlap dimension change', () => {
    const diff = pixelDiff(createImage(0, 0), createImage(10, 10, WHITE), {
      antialiasTolerance: 0.1,
    });

    expect(diff.dimensionsChanged).toBe(true);
    expect(diff.changedPixels).toBe(0);
    expect(diff.changedRatio).toBe(0);
  });
});

describe('renderPixelOverlay', () => {
  it('paints changed pixels red and fades the rest', () => {
    const a = createImage(20, 10, WHITE);
    const b = paintRect(createImage(20, 10, WHITE), { x: 4, y: 2, w: 6, h: 6 }, RED);
    const diff = pixelDiff(a, b, { antialiasTolerance: 0.1 });

    const overlay = renderPixelOverlay(b, diff);

    expect(overlay.width).toBe(20);
    expect(overlay.height).toBe(10);
    const changed = ((4 * 20) + 6) * 4;
    expect([...overlay.data.subarray(changed, changed + 4)]).toEqual([255, 46, 46, 255]);
    expect(overlay.data[3]).toBe(255);
  });
});

describe('cropImage', () => {
  it('clips to the image bounds', () => {
    const image = createImage(20, 20, WHITE);
    const crop = cropImage(image, { x: -5, y: -5, w: 10, h: 10 });

    expect(crop).not.toBeNull();
    expect(crop?.width).toBe(5);
    expect(crop?.height).toBe(5);
  });

  it('returns null when the rect is entirely outside', () => {
    expect(cropImage(createImage(10, 10, WHITE), { x: 50, y: 50, w: 4, h: 4 })).toBeNull();
  });
});
