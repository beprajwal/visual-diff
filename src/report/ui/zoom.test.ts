import { describe, expect, it } from 'vitest';

import {
  FIT,
  fitInside,
  isCrisp,
  MAX_SCALE,
  clampScale,
  clampZoom,
  isFit,
  panBy,
  panLimits,
  transform,
  wheelFactor,
  zoomBy,
  zoomLabel,
  zoomTo,
} from './zoom.js';

/** A 800×600 frame holding an image fitted to 800×400. */
const VIEWPORT = { w: 800, h: 600 };
const FITTED = { w: 800, h: 400 };

describe('clampScale', () => {
  it('holds the range and survives nonsense', () => {
    expect(clampScale(0.1)).toBe(1);
    expect(clampScale(2)).toBe(2);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe('fitInside', () => {
  it('contains the image in whichever axis binds', () => {
    expect(fitInside({ w: 1600, h: 800 }, VIEWPORT)).toEqual({ w: 800, h: 400 });
    expect(fitInside({ w: 600, h: 1200 }, VIEWPORT)).toEqual({ w: 300, h: 600 });
  });

  it('enlarges a small image to fill the frame', () => {
    expect(fitInside({ w: 200, h: 150 }, VIEWPORT)).toEqual({ w: 800, h: 600 });
  });

  it('is empty when either size is unknown', () => {
    expect(fitInside({ w: 0, h: 0 }, VIEWPORT)).toEqual({ w: 0, h: 0 });
    expect(fitInside({ w: 800, h: 400 }, { w: 0, h: 0 })).toEqual({ w: 0, h: 0 });
  });
});

describe('panLimits', () => {
  it('is zero while the image still fits', () => {
    expect(panLimits(1, VIEWPORT, FITTED)).toEqual({ w: 0, h: 0 });
  });

  it('is half the overhang once it does not', () => {
    // 2× of 800×400 is 1600×800 inside an 800×600 frame: 800 over wide, 200 over tall.
    expect(panLimits(2, VIEWPORT, FITTED)).toEqual({ w: 400, h: 100 });
  });

  it('clamps each axis on its own', () => {
    // 1.25× is 1000×500: wider than the frame, still shorter than it.
    expect(panLimits(1.25, VIEWPORT, FITTED)).toEqual({ w: 100, h: 0 });
  });
});

describe('clampZoom', () => {
  it('recentres an image that fits', () => {
    expect(clampZoom({ scale: 1, x: 120, y: -90 }, VIEWPORT, FITTED)).toEqual(FIT);
  });

  it('keeps the image against the frame edge at most', () => {
    expect(clampZoom({ scale: 2, x: 9999, y: -9999 }, VIEWPORT, FITTED)).toEqual({
      scale: 2,
      x: 400,
      y: -100,
    });
  });
});

describe('panBy', () => {
  it('moves within the limits and stops at them', () => {
    const zoomed = zoomTo(FIT, 2, VIEWPORT, FITTED);
    expect(panBy(zoomed, 50, 20, VIEWPORT, FITTED)).toEqual({ scale: 2, x: 50, y: 20 });
    expect(panBy(zoomed, 5000, 0, VIEWPORT, FITTED).x).toBe(400);
  });

  it('is inert while the image fits', () => {
    expect(panBy(FIT, 40, 40, VIEWPORT, FITTED)).toEqual(FIT);
  });
});

describe('zoomTo', () => {
  it('holds the focused point still', () => {
    // Zooming 2× about a point 100px right of centre moves that content 100px further right,
    // so the offset compensates by the same amount.
    const zoomed = zoomTo(FIT, 2, VIEWPORT, FITTED, { x: 100, y: 0 });
    expect(zoomed).toEqual({ scale: 2, x: -100, y: 0 });
  });

  it('returns to centre when zooming back out to fit', () => {
    const zoomed = zoomTo(FIT, 4, VIEWPORT, FITTED, { x: 220, y: 60 });
    expect(zoomTo(zoomed, 1, VIEWPORT, FITTED, { x: 220, y: 60 })).toEqual(FIT);
  });

  it('never leaves the image showing empty space', () => {
    const zoomed = zoomTo(FIT, 8, VIEWPORT, FITTED, { x: 400, y: 300 });
    const limits = panLimits(8, VIEWPORT, FITTED);
    expect(Math.abs(zoomed.x)).toBeLessThanOrEqual(limits.w);
    expect(Math.abs(zoomed.y)).toBeLessThanOrEqual(limits.h);
  });
});

describe('zoomBy', () => {
  it('multiplies the current scale', () => {
    expect(zoomBy({ scale: 2, x: 0, y: 0 }, 1.5, VIEWPORT, FITTED).scale).toBe(3);
  });

  it('cannot be driven past the ends of the range', () => {
    expect(zoomBy(FIT, 0.5, VIEWPORT, FITTED)).toEqual(FIT);
    expect(zoomBy({ scale: 6, x: 0, y: 0 }, 4, VIEWPORT, FITTED).scale).toBe(MAX_SCALE);
  });
});

describe('wheelFactor', () => {
  it('zooms in scrolling up and out scrolling down', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
  });

  it('is symmetric, so a gesture and its reverse cancel', () => {
    expect(wheelFactor(-120) * wheelFactor(120)).toBeCloseTo(1, 10);
  });

  it('takes more than a flick to cross the whole range', () => {
    let scale = 1;
    let notches = 0;
    while (scale < MAX_SCALE && notches < 100) {
      scale = clampScale(scale * wheelFactor(-120));
      notches += 1;
    }
    expect(notches).toBeGreaterThan(6);
  });
});

describe('rendering', () => {
  it('reports the fitted state', () => {
    expect(isFit(FIT)).toBe(true);
    expect(isFit({ scale: 1, x: 3, y: 0 })).toBe(false);
  });

  it('stops smoothing once the magnification is about the pixels themselves', () => {
    expect(isCrisp({ scale: 2, x: 0, y: 0 })).toBe(false);
    expect(isCrisp({ scale: 4, x: 0, y: 0 })).toBe(true);
  });

  it('formats a transform and a label', () => {
    expect(transform({ scale: 2.5, x: -12.5, y: 4 })).toBe(
      'translate(-12.50px, 4.00px) scale(2.50)',
    );
    expect(zoomLabel({ scale: 2.5, x: 0, y: 0 })).toBe('250%');
  });
});
