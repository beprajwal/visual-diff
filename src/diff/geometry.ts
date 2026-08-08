/**
 * Rectangle helpers shared by region clustering, DOM attribution and cropping.
 *
 * Coordinate spaces (spec §8): DOM rects arrive in CSS pixels; screenshots, masks, regions and
 * crops live in *image* pixels. Everything downstream of {@link scaleRect} is image space.
 */

import type { Rect } from '../types.js';

export function area(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

export function right(r: Rect): number {
  return r.x + r.w;
}

export function bottom(r: Rect): number {
  return r.y + r.h;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(right(a), right(b)) - x;
  const h = Math.min(bottom(a), bottom(b)) - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

export function intersects(a: Rect, b: Rect): boolean {
  return intersect(a, b) !== null;
}

/** True when `inner` fits inside `outer`, allowing `tol` pixels of slop on every edge. */
export function contains(outer: Rect, inner: Rect, tol = 0): boolean {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    right(inner) <= right(outer) + tol &&
    bottom(inner) <= bottom(outer) + tol
  );
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(bottom(a), bottom(b)) - y };
}

export function unionAll(rects: Rect[]): Rect | null {
  let acc: Rect | null = null;
  for (const r of rects) acc = acc === null ? r : union(acc, r);
  return acc;
}

/** Axis gaps between two rects. Zero on an axis means they overlap or touch on that axis. */
export function gap(a: Rect, b: Rect): { dx: number; dy: number } {
  const dx = Math.max(0, Math.max(a.x - right(b), b.x - right(a)));
  const dy = Math.max(0, Math.max(a.y - bottom(b), b.y - bottom(a)));
  return { dx, dy };
}

/** True when the rects are within `proximity` pixels on both axes (spec §8, stage 3 merge). */
export function isNear(a: Rect, b: Rect, proximity: number): boolean {
  const { dx, dy } = gap(a, b);
  return dx <= proximity && dy <= proximity;
}

export function scaleRect(r: Rect, s: number): Rect {
  return { x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s };
}

export function roundRect(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.ceil(right(r)) - x, h: Math.ceil(bottom(r)) - y };
}

export function inflate(r: Rect, n: number): Rect {
  return { x: r.x - n, y: r.y - n, w: r.w + 2 * n, h: r.h + 2 * n };
}

/** Clip to a `w`x`h` image, returning null when nothing is left. */
export function clampRect(r: Rect, w: number, h: number): Rect | null {
  return intersect(r, { x: 0, y: 0, w, h });
}

export function rectsEqual(a: Rect, b: Rect, eps = 0): boolean {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.w - b.w) <= eps &&
    Math.abs(a.h - b.h) <= eps
  );
}

/** Euclidean distance between rect origins — the "moved" magnitude in the layout heuristic. */
export function originDistance(a: Rect, b: Rect): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Largest of the two size deltas — the "resized" magnitude in the layout heuristic. */
export function sizeDelta(a: Rect, b: Rect): number {
  return Math.max(Math.abs(a.w - b.w), Math.abs(a.h - b.h));
}
