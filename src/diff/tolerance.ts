/** Tolerance annotates evidence; it never destroys measurements or changes severity. */
import type { Finding, PixelDiffResult, PixelImage, Rect, ViewportDiff, VisualToleranceOptions } from '../types.js';
import { DEFAULTS } from '../types.js';
import { changedOutside } from './pixel.js';
import { maxLengthDelta } from './severity.js';

export function resolvedTolerance(options: VisualToleranceOptions = {}) {
  return { maxChangedPixelRatio: options.maxChangedPixelRatio ?? DEFAULTS.diff.maxChangedPixelRatio,
    layout: { enabled: options.layout?.enabled ?? DEFAULTS.diff.layout.enabled,
      tolerancePx: options.layout?.tolerancePx ?? DEFAULTS.diff.layout.tolerancePx } };
}

export function sameTolerance(a: VisualToleranceOptions | undefined, b: VisualToleranceOptions): boolean {
  // Missing result metadata predates tolerance (or explicitly used legacy strict settings).
  const stored = a ?? { maxChangedPixelRatio: 0, layout: { enabled: true, tolerancePx: 0.5 } };
  return JSON.stringify(resolvedTolerance(stored)) === JSON.stringify(resolvedTolerance(b));
}

export function toleranceActive(options: VisualToleranceOptions): boolean {
  const policy = resolvedTolerance(options);
  return policy.maxChangedPixelRatio > 0 || !policy.layout.enabled || policy.layout.tolerancePx !== 0.5;
}

export function toleratesLayout(delta: number, options: VisualToleranceOptions): boolean {
  const { layout } = resolvedTolerance(options);
  return !layout.enabled || delta <= layout.tolerancePx;
}

function covered(rects: readonly Rect[], x: number, y: number): boolean {
  return rects.some(r => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
}

/** Conservative proof that a moved/resized box kept the same pixels at relative coordinates.
 * Geometry alone cannot explain a canvas repaint or a changed image inside the same container.
 * A mismatch leaves the pixels for the ordinary allowance to judge. No image copies are needed.
 */
export function sameRelativePixels(base: PixelImage, head: PixelImage, from: Rect, to: Rect, exclude: readonly Rect[] = []): boolean {
  const left = Math.max(0, -from.x, -to.x);
  const top = Math.max(0, -from.y, -to.y);
  const right = Math.min(from.w, to.w, base.width - from.x, head.width - to.x);
  const bottom = Math.min(from.h, to.h, base.height - from.y, head.height - to.y);
  if (right <= left || bottom <= top) return false;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      if (covered(exclude, from.x + x, from.y + y) || covered(exclude, to.x + x, to.y + y)) continue;
      const b = ((from.y + y) * base.width + from.x + x) * 4;
      const h = ((to.y + y) * head.width + to.x + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        if (base.data[b + channel] !== head.data[h + channel]) return false;
      }
    }
  }
  return true;
}

/** Replaced image content can scale with its box; verify both directions so downscaling cannot
 * hide a changed source pixel that the forward nearest-neighbour mapping did not visit.
 */
export function sameScaledPixels(base: PixelImage, head: PixelImage, from: Rect, to: Rect, exclude: readonly Rect[] = []): boolean {
  const inside = (image: PixelImage, r: Rect): boolean => r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 &&
    r.x + r.w <= image.width && r.y + r.h <= image.height;
  if (!inside(base, from) || !inside(head, to)) return false;
  const compare = (a: PixelImage, b: PixelImage, ar: Rect, br: Rect): boolean => {
    for (let y = 0; y < br.h; y++) {
      for (let x = 0; x < br.w; x++) {
        const ax = ar.x + Math.floor((x + 0.5) * ar.w / br.w);
        const ay = ar.y + Math.floor((y + 0.5) * ar.h / br.h);
        if (covered(exclude, ax, ay) || covered(exclude, br.x + x, br.y + y)) continue;
        const ai = (ay * a.width + ax) * 4;
        const bi = ((br.y + y) * b.width + br.x + x) * 4;
        for (let c = 0; c < 4; c++) if (a.data[ai + c] !== b.data[bi + c]) return false;
      }
    }
    return true;
  };
  return compare(base, head, from, to) && compare(head, base, to, from);
}

export function hasChangedPixels(pixels: PixelDiffResult, rect: Rect, exclude: readonly Rect[]): boolean {
  for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(pixels.compared.h, Math.ceil(rect.y + rect.h)); y++) {
    for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(pixels.compared.w, Math.ceil(rect.x + rect.w)); x++) {
      if (pixels.mask[y * pixels.compared.w + x] === 1 && !exclude.some(box =>
        x >= box.x && y >= box.y && x < box.x + box.w && y < box.y + box.h)) return true;
    }
  }
  return false;
}

/** Mark geometry first, then compare pixels not already explained by tolerated geometry. */
export function applyTolerance(
  diff: ViewportDiff,
  pixels: PixelDiffResult,
  exclude: readonly Rect[],
  options: VisualToleranceOptions,
  scale: number,
  layoutRects: readonly Rect[],
): void {
  if (!toleranceActive(options) || diff.missing !== undefined) return;
  const allowance = resolvedTolerance(options).maxChangedPixelRatio;
  const excluded = [...exclude, ...layoutRects];
  const residual = changedOutside(pixels, excluded);
  const minorPixels = residual.changedRatio <= allowance;
  const pixelOnly = (f: Finding): boolean => f.reasons.includes('pixels-only') || f.reasons.includes('collapsed');
  // A fallback region is tolerated only if its changed pixels are covered by tolerated geometry
  // or the remaining global pixel count is within allowance. Never infer loading state here.
  const coveredByLayout = (f: Finding): boolean => {
    if (f.region === undefined || layoutRects.length === 0) return false;
    const r = f.region;
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(pixels.compared.h, Math.ceil(r.y + r.h)); y++) {
      for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(pixels.compared.w, Math.ceil(r.x + r.w)); x++) {
        if (pixels.mask[y * pixels.compared.w + x] !== 1) continue;
        if (!excluded.some(box => x >= box.x && y >= box.y && x < box.x + box.w && y < box.y + box.h)) return false;
      }
    }
    return true;
  };
  for (const finding of diff.findings) {
    const divisor = finding.reasons.includes('dimensions-changed') ? scale : 1;
    if ((finding.kind === 'layout' && toleratesLayout(maxLengthDelta(finding.changes) / divisor, options)) ||
      (pixelOnly(finding) && (minorPixels || coveredByLayout(finding)))) {
      finding.withinTolerance = true;
    }
  }
  if (!minorPixels) {
    // A region can contain both a tolerated resize and an actual repaint. Once its geometry
    // explanation is tolerated, keep a pixel explanation for any remaining significant evidence.
    for (const { rect } of diff.regions) {
      const sameRegion = (f: Finding): boolean => f.region !== undefined &&
        f.region.x === rect.x && f.region.y === rect.y && f.region.w === rect.w && f.region.h === rect.h;
      const explanations = diff.findings.filter(sameRegion);
      if (explanations.length > 0 && explanations.every(f => f.withinTolerance) &&
        hasChangedPixels(pixels, rect, excluded)) {
        const source = explanations[0]!;
        diff.findings.push({ id: '', kind: 'content', severity: 'med', step: source.step,
          viewport: diff.viewport, region: rect, changes: [], label: 'visual change', reasons: ['pixels-only'] });
      }
    }
  }
  const dimensionDelta = Math.max(Math.abs(pixels.base.w - pixels.head.w), Math.abs(pixels.base.h - pixels.head.h)) / scale;
  diff.significantDimensionsChanged = diff.dimensionsChanged && !toleratesLayout(dimensionDelta, options);
  diff.significantPixelChangedRatio = residual.changedRatio;
  if ((diff.pixelChangedRatio > 0 || diff.dimensionsChanged) && minorPixels &&
    (!diff.dimensionsChanged || toleratesLayout(dimensionDelta, options)) &&
    diff.findings.every(f => f.withinTolerance === true)) {
    diff.withinTolerance = true;
    diff.significantPixelChangedRatio = 0;
  }
}
