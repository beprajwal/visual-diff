/**
 * Stage 2 — pixel diff (spec §8).
 *
 * Perceptual comparison via `pixelmatch` (spec §12: pure JS, portability beats speed). The
 * `antialiasTolerance` knob is passed straight through as pixelmatch's YIQ colour-delta threshold
 * with antialias detection enabled, which is exactly the pair of controls the spec names.
 *
 * Differing image dimensions are a finding in their own right; comparison then proceeds on the
 * common area rather than reporting 100% changed.
 */

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { PixelDiffResult, PixelImage, Rect, Size } from '../types.js';
import { clampRect, roundRect } from './geometry.js';

export function decodePng(buffer: Buffer): PixelImage {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

export function encodePng(image: PixelImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return PNG.sync.write(png);
}

export function createImage(width: number, height: number, fill?: [number, number, number, number]): PixelImage {
  const data = new Uint8Array(width * height * 4);
  if (fill !== undefined) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = fill[3];
    }
  }
  return { width, height, data };
}

/** Copy an axis-aligned sub-rectangle out of an image. The rect must already be in bounds. */
export function subImage(image: PixelImage, rect: Rect): PixelImage {
  const out = createImage(rect.w, rect.h);
  for (let y = 0; y < rect.h; y += 1) {
    const src = ((rect.y + y) * image.width + rect.x) * 4;
    out.data.set(image.data.subarray(src, src + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

/** Clip a rect to the image and copy it out. Returns null when nothing overlaps. */
export function cropImage(image: PixelImage, rect: Rect): PixelImage | null {
  const clipped = clampRect(roundRect(rect), image.width, image.height);
  if (clipped === null || clipped.w <= 0 || clipped.h <= 0) return null;
  return subImage(image, clipped);
}

export interface PixelDiffOptions {
  /** YIQ colour-delta threshold; also the antialias sensitivity (spec §6 `antialiasTolerance`). */
  antialiasTolerance: number;
}

export function sizeOf(image: PixelImage): Size {
  return { w: image.width, h: image.height };
}

export function pixelDiff(
  base: PixelImage,
  head: PixelImage,
  options: PixelDiffOptions,
): PixelDiffResult {
  const compared: Size = {
    w: Math.min(base.width, head.width),
    h: Math.min(base.height, head.height),
  };
  const dimensionsChanged = base.width !== head.width || base.height !== head.height;

  if (compared.w <= 0 || compared.h <= 0) {
    return {
      base: sizeOf(base),
      head: sizeOf(head),
      compared: { w: Math.max(0, compared.w), h: Math.max(0, compared.h) },
      dimensionsChanged,
      changedPixels: 0,
      changedRatio: 0,
      mask: new Uint8Array(0),
    };
  }

  const region: Rect = { x: 0, y: 0, w: compared.w, h: compared.h };
  const a = base.width === compared.w && base.height === compared.h ? base : subImage(base, region);
  const b = head.width === compared.w && head.height === compared.h ? head : subImage(head, region);

  const out = new Uint8Array(compared.w * compared.h * 4);
  const changedPixels = pixelmatch(a.data, b.data, out, compared.w, compared.h, {
    threshold: options.antialiasTolerance,
    includeAA: false,
    diffMask: true,
  });

  const mask = new Uint8Array(compared.w * compared.h);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = out[i * 4 + 3] !== 0 ? 1 : 0;
  }

  return {
    base: sizeOf(base),
    head: sizeOf(head),
    compared,
    dimensionsChanged,
    changedPixels,
    changedRatio: changedPixels / (compared.w * compared.h),
    mask,
  };
}

/**
 * `pixel.png`: the head shot faded toward white with changed pixels painted red, so a reviewer can
 * read the change in place. Pixels outside the compared area (present on one side only) are faded
 * and tinted so "not compared" never reads as "unchanged".
 */
export function renderPixelOverlay(head: PixelImage, diff: PixelDiffResult): PixelImage {
  const out = createImage(head.width, head.height);
  const fade = (v: number): number => Math.round(255 - (255 - v) * 0.18);
  for (let y = 0; y < head.height; y += 1) {
    for (let x = 0; x < head.width; x += 1) {
      const i = (y * head.width + x) * 4;
      const inCompared = x < diff.compared.w && y < diff.compared.h;
      const changed = inCompared && diff.mask[y * diff.compared.w + x] === 1;
      if (changed) {
        out.data[i] = 255;
        out.data[i + 1] = 46;
        out.data[i + 2] = 46;
        out.data[i + 3] = 255;
        continue;
      }
      const r = fade(head.data[i] ?? 255);
      const g = fade(head.data[i + 1] ?? 255);
      const b = fade(head.data[i + 2] ?? 255);
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = inCompared ? b : Math.round(b * 0.82);
      out.data[i + 3] = 255;
    }
  }
  return out;
}
