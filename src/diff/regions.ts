/**
 * Stage 3 — region clustering (spec §8).
 *
 * Connected components (8-connected) over the change mask, merged by proximity, emitted as
 * rectangles sorted by area. Regions below `minRegionArea` are dropped, regions sitting inside a
 * flow `mask` or a config `ignore` rect are excluded, and the count is capped at `maxRegions` with
 * the remainder collapsed into a single "N smaller changes" entry — uncapped, a font-metric shift
 * produces hundreds of boxes and the report becomes unreadable.
 */

import type { Rect, Region, RegionSet } from '../types.js';
import { area as rectArea, isNear, union } from './geometry.js';

/** Bounding boxes closer than this (image px, both axes) are merged into one region. */
export const DEFAULT_PROXIMITY = 12;

/** A region is excluded when at most this fraction of its changed pixels escapes the mask rects. */
const EXCLUSION_ESCAPE_RATIO = 0.1;

/** Fixpoint guard for the proximity merge; each pass can only reduce the group count. */
const MAX_MERGE_PASSES = 12;

export interface ClusterOptions {
  minRegionArea: number;
  maxRegions: number;
  /** Image-space rects whose changes are ignored: flow `mask` plus config `ignore` node rects. */
  exclude?: readonly Rect[];
  proximity?: number;
}

export interface ClusterResult extends RegionSet {
  /** Bounding box of everything folded into the "N smaller changes" entry. */
  collapsedRect: Rect | null;
  collapsedPixels: number;
  /** Regions dropped specifically for landing inside a mask/ignore rect. */
  excluded: number;
}

interface Component {
  rect: Rect;
  pixels: number;
}

function findRoot(parent: Int32Array, i: number): number {
  let root = i;
  while (parent[root] !== root) root = parent[root] as number;
  let cur = i;
  while (parent[cur] !== root) {
    const next = parent[cur] as number;
    parent[cur] = root;
    cur = next;
  }
  return root;
}

/** 8-connected flood fill. Returns one component per blob plus a per-pixel label map. */
export function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): { components: Component[]; labels: Int32Array } {
  const labels = new Int32Array(width * height).fill(-1);
  const components: Component[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || labels[start] !== -1) continue;
    const label = components.length;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let pixels = 0;

    labels[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % width;
      const y = (idx - x) / width;
      pixels += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = ny * width + nx;
          if (mask[nIdx] !== 1 || labels[nIdx] !== -1) continue;
          labels[nIdx] = label;
          stack.push(nIdx);
        }
      }
    }

    components.push({ rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, pixels });
  }

  return { components, labels };
}

/**
 * Union components whose bounding boxes are within `proximity` on both axes, to a fixpoint.
 *
 * Roots are swept in x order so the inner loop can break as soon as a candidate starts beyond the
 * current group's right edge plus the proximity budget; group rects only ever grow, so that break
 * stays conservative as merges happen mid-pass.
 */
function mergeByProximity(components: Component[], proximity: number): Int32Array {
  const n = components.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  if (n < 2) return parent;

  const rect: Rect[] = components.map((c) => c.rect);

  for (let pass = 0; pass < MAX_MERGE_PASSES; pass += 1) {
    const roots: number[] = [];
    for (let i = 0; i < n; i += 1) if (findRoot(parent, i) === i) roots.push(i);
    roots.sort((a, b) => (rect[a] as Rect).x - (rect[b] as Rect).x);

    let merged = false;
    for (let i = 0; i < roots.length; i += 1) {
      const ri = roots[i] as number;
      if (findRoot(parent, ri) !== ri) continue;
      for (let j = i + 1; j < roots.length; j += 1) {
        const rj = roots[j] as number;
        if (findRoot(parent, rj) !== rj) continue;
        const a = rect[ri] as Rect;
        const b = rect[rj] as Rect;
        if (b.x > a.x + a.w + proximity) break;
        if (!isNear(a, b, proximity)) continue;
        parent[rj] = ri;
        rect[ri] = union(a, b);
        merged = true;
      }
    }
    if (!merged) break;
  }
  return parent;
}

function insideAny(x: number, y: number, rects: readonly Rect[]): boolean {
  for (const r of rects) {
    if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return true;
  }
  return false;
}

export function clusterRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  options: ClusterOptions,
): ClusterResult {
  const proximity = options.proximity ?? DEFAULT_PROXIMITY;
  const exclude = options.exclude ?? [];

  if (width <= 0 || height <= 0 || mask.length === 0) {
    return {
      regions: [],
      dropped: 0,
      collapsed: 0,
      totalFound: 0,
      collapsedRect: null,
      collapsedPixels: 0,
      excluded: 0,
    };
  }

  const { components, labels } = connectedComponents(mask, width, height);
  if (components.length === 0) {
    return {
      regions: [],
      dropped: 0,
      collapsed: 0,
      totalFound: 0,
      collapsedRect: null,
      collapsedPixels: 0,
      excluded: 0,
    };
  }

  const parent = mergeByProximity(components, proximity);

  interface Group {
    rect: Rect;
    pixels: number;
    outside: number;
  }
  const groups = new Map<number, Group>();
  components.forEach((c, i) => {
    const root = findRoot(parent, i);
    const g = groups.get(root);
    if (g === undefined) groups.set(root, { rect: c.rect, pixels: c.pixels, outside: 0 });
    else {
      g.rect = union(g.rect, c.rect);
      g.pixels += c.pixels;
    }
  });

  if (exclude.length > 0) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const label = labels[y * width + x] as number;
        if (label < 0) continue;
        if (insideAny(x, y, exclude)) continue;
        const g = groups.get(findRoot(parent, label));
        if (g !== undefined) g.outside += 1;
      }
    }
  } else {
    for (const g of groups.values()) g.outside = g.pixels;
  }

  const totalFound = groups.size;
  let dropped = 0;
  let excluded = 0;
  const kept: Array<{ rect: Rect; pixels: number }> = [];

  for (const g of groups.values()) {
    if (exclude.length > 0 && g.outside / g.pixels <= EXCLUSION_ESCAPE_RATIO) {
      dropped += 1;
      excluded += 1;
      continue;
    }
    if (rectArea(g.rect) < options.minRegionArea) {
      dropped += 1;
      continue;
    }
    kept.push({ rect: g.rect, pixels: g.pixels });
  }

  kept.sort((a, b) => {
    const byArea = rectArea(b.rect) - rectArea(a.rect);
    if (byArea !== 0) return byArea;
    const byPixels = b.pixels - a.pixels;
    if (byPixels !== 0) return byPixels;
    if (a.rect.y !== b.rect.y) return a.rect.y - b.rect.y;
    return a.rect.x - b.rect.x;
  });

  const capped = kept.slice(0, Math.max(0, options.maxRegions));
  const overflow = kept.slice(Math.max(0, options.maxRegions));

  const regions: Region[] = capped.map((k, i) => {
    const a = rectArea(k.rect);
    return {
      id: `r${i + 1}`,
      rect: k.rect,
      area: a,
      changedPixels: k.pixels,
      density: a === 0 ? 0 : k.pixels / a,
    };
  });

  let collapsedRect: Rect | null = null;
  let collapsedPixels = 0;
  for (const o of overflow) {
    collapsedRect = collapsedRect === null ? o.rect : union(collapsedRect, o.rect);
    collapsedPixels += o.pixels;
  }

  return {
    regions,
    dropped,
    collapsed: overflow.length,
    totalFound,
    collapsedRect,
    collapsedPixels,
    excluded,
  };
}
