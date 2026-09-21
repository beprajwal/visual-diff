/**
 * Zoom and pan as pure arithmetic, so the fullscreen viewer behaves the same everywhere and can be
 * tested without a DOM — the same reason the keyboard map in `keys.ts` is a table.
 *
 * Scale 1 means *fitted*: the screenshot as large as it goes while wholly visible, which is what
 * the viewer opens at. Zooming out past that only adds empty space, so 1 is the floor; panning is
 * clamped to the overhang, so an image that still fits stays centred and a magnified one can never
 * be dragged off into the void.
 *
 * Offsets are viewport pixels measured from the centre — the space CSS `translate()` works in, so
 * rendering is `transform(zoom)` and nothing else.
 */

import type { Size } from '../../types.js';

export interface Zoom {
  /** Multiple of the fitted size; 1 is "fits the frame". */
  scale: number;
  /** Horizontal offset from centre, in viewport pixels. */
  x: number;
  /** Vertical offset from centre, in viewport pixels. */
  y: number;
}

/** A point in the frame, relative to its centre. */
export interface Point {
  x: number;
  y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
/** One click of the +/− buttons and the keyboard bindings. */
export const SCALE_STEP = 1.5;

/**
 * The largest `content` fits to inside `frame` without cropping or distorting it — the size the
 * viewer draws at scale 1. Returned rather than left to CSS `object-fit` because the region boxes
 * are positioned as percentages of the drawn image, so the drawn size has to be a number the
 * layout and the overlay agree on.
 */
export function fitInside(content: Size, frame: Size): Size {
  if (content.w <= 0 || content.h <= 0 || frame.w <= 0 || frame.h <= 0) return { w: 0, h: 0 };
  const ratio = Math.min(frame.w / content.w, frame.h / content.h);
  return { w: content.w * ratio, h: content.h * ratio };
}

/** The state the viewer opens at: fitted and centred. */
export const FIT: Zoom = { scale: 1, x: 0, y: 0 };

const CENTRE: Point = { x: 0, y: 0 };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  return scale < MIN_SCALE ? MIN_SCALE : scale > MAX_SCALE ? MAX_SCALE : scale;
}

/**
 * How far the image may be dragged in each axis: half the overhang past the frame. Zero when the
 * scaled image still fits, which is what pins a fitted image to the centre.
 */
export function panLimits(scale: number, viewport: Size, fitted: Size): Size {
  const overhang = (content: number, frame: number): number => {
    const value = (content * scale - frame) / 2;
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return { w: overhang(fitted.w, viewport.w), h: overhang(fitted.h, viewport.h) };
}

/** Brings a zoom back inside the scale range and the pan limits. */
export function clampZoom(zoom: Zoom, viewport: Size, fitted: Size): Zoom {
  const scale = clampScale(zoom.scale);
  const limits = panLimits(scale, viewport, fitted);
  const axis = (value: number, limit: number): number => {
    if (!Number.isFinite(value)) return 0;
    const held = value < -limit ? -limit : value > limit ? limit : value;
    // `-0` compares equal to `0` but renders and serialises differently; normalise it away.
    return held === 0 ? 0 : held;
  };
  return { scale, x: axis(zoom.x, limits.w), y: axis(zoom.y, limits.h) };
}

export function panBy(zoom: Zoom, dx: number, dy: number, viewport: Size, fitted: Size): Zoom {
  return clampZoom({ scale: zoom.scale, x: zoom.x + dx, y: zoom.y + dy }, viewport, fitted);
}

/**
 * Zooms to an absolute scale while holding `focus` still — so the pixel under the cursor (or under
 * the centre, when nothing is pointed at) is the pixel that stays put, which is the difference
 * between inspecting a detail and losing it.
 */
export function zoomTo(
  zoom: Zoom,
  scale: number,
  viewport: Size,
  fitted: Size,
  focus: Point = CENTRE,
): Zoom {
  const next = clampScale(scale);
  const ratio = next / zoom.scale;
  if (!Number.isFinite(ratio)) return clampZoom({ ...FIT, scale: next }, viewport, fitted);
  return clampZoom(
    {
      scale: next,
      x: focus.x - (focus.x - zoom.x) * ratio,
      y: focus.y - (focus.y - zoom.y) * ratio,
    },
    viewport,
    fitted,
  );
}

export function zoomBy(
  zoom: Zoom,
  factor: number,
  viewport: Size,
  fitted: Size,
  focus: Point = CENTRE,
): Zoom {
  return zoomTo(zoom, zoom.scale * factor, viewport, fitted, focus);
}

/**
 * Wheel notches to a scale factor. Exponential, so a trackpad's many small deltas and a mouse
 * wheel's few large ones feel like the same gesture, and so zooming in then out by the same
 * distance lands back where it started. The divisor is tuned so a 120px notch is about a quarter
 * step: the whole range takes a deliberate scroll rather than one flick.
 */
export function wheelFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-deltaY / 500);
}

/**
 * Past this magnification the viewer stops smoothing the image. Interpolation invents colours
 * between pixels, which is precisely the thing a reviewer zooms in to judge — at this distance a
 * crisp grid of the real pixels is the honest picture.
 */
export const CRISP_SCALE = 3;

export function isCrisp(zoom: Zoom): boolean {
  return zoom.scale >= CRISP_SCALE;
}

/** True when the image is fitted and centred — the state the "fit" control returns to. */
export function isFit(zoom: Zoom): boolean {
  return zoom.scale === 1 && zoom.x === 0 && zoom.y === 0;
}

/** The CSS transform for a zoom. Translation first: the offsets are already in viewport pixels. */
export function transform(zoom: Zoom): string {
  return `translate(${zoom.x.toFixed(2)}px, ${zoom.y.toFixed(2)}px) scale(${zoom.scale.toFixed(2)})`;
}

/** The zoom level as a reviewer reads it: `100%`, `250%`. */
export function zoomLabel(zoom: Zoom): string {
  return `${Math.round(zoom.scale * 100)}%`;
}
