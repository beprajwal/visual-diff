/**
 * Chart geometry.
 *
 * The SVG chart is where the api-mocking spec says pixel diffing earns its keep, which means every
 * one of these numbers ends up as a coordinate in a committed screenshot. Two properties matter
 * more than the rest and are asserted directly:
 *
 *   - **Degenerate input still produces a drawable chart.** A flat series, a single point, an empty
 *     series, and a series full of nulls are all things a scenario produces on purpose. A crash
 *     there would mean the scenario cannot be captured at all.
 *   - **Coordinates are rounded.** Floating-point tails are invisible on screen but land in
 *     `dom.json`, where they become attribute-change findings that mean nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  buildSparkline,
  buildTemperatureChart,
  linearScale,
  niceBounds,
  round,
  smoothAreaPath,
  smoothLinePath,
  ticksBetween,
} from '../src/chart.js';

function hours(temperatures: number[], probabilities: number[] = []) {
  return temperatures.map((temperature, index) => ({
    time: `2026-08-09T${String(index % 24).padStart(2, '0')}:00`,
    label: `${String(index % 24).padStart(2, '0')}:00`,
    hourOfDay: index % 24,
    temperature,
    precipitationProbability: probabilities[index] ?? 0,
    weather: { code: 0, label: 'Clear sky', icon: 'sun' },
  }));
}

describe('round', () => {
  it('keeps two decimals and never emits negative zero', () => {
    expect(round(12.3456)).toBe(12.35);
    expect(round(12)).toBe(12);
    expect(round(-0.001)).toBe(0);
    expect(Object.is(round(-0.001), -0)).toBe(false);
  });
});

describe('linearScale', () => {
  it('maps a domain onto a range', () => {
    const scale = linearScale([0, 10], [100, 200]);
    expect(scale(0)).toBe(100);
    expect(scale(10)).toBe(200);
    expect(scale(5)).toBe(150);
  });

  it('inverts happily, which is how a y axis is built', () => {
    const scale = linearScale([0, 10], [200, 100]);
    expect(scale(0)).toBe(200);
    expect(scale(10)).toBe(100);
  });

  it('centres a zero-width domain instead of dividing by zero', () => {
    const scale = linearScale([15, 15], [200, 100]);
    expect(scale(15)).toBe(150);
    expect(Number.isFinite(scale(15))).toBe(true);
  });
});

describe('niceBounds', () => {
  it('rounds outward to the step', () => {
    expect(niceBounds([13.2, 27.8], { step: 5, minSpan: 10 })).toEqual({ min: 10, max: 30 });
  });

  it('widens a range narrower than minSpan so a still day is not drawn as a mountain range', () => {
    const bounds = niceBounds([20, 20.3], { step: 5, minSpan: 10 });
    expect(bounds.max - bounds.min).toBeGreaterThanOrEqual(10);
    expect(bounds.min).toBeLessThanOrEqual(20);
    expect(bounds.max).toBeGreaterThanOrEqual(20.3);
  });

  it('falls back to a fixed box when every value was patched away', () => {
    expect(niceBounds([], { step: 5, minSpan: 10 })).toEqual({ min: 0, max: 10 });
    expect(niceBounds([Number.NaN, Number.POSITIVE_INFINITY], { step: 5, minSpan: 10 })).toEqual({ min: 0, max: 10 });
  });
});

describe('ticksBetween', () => {
  it('walks the multiples inside the range, inclusive of both ends', () => {
    expect(ticksBetween(10, 30, 5)).toEqual([10, 15, 20, 25, 30]);
    expect(ticksBetween(-8, 4, 4)).toEqual([-8, -4, 0, 4]);
  });

  it('returns nothing when no multiple fits', () => {
    expect(ticksBetween(11, 13, 5)).toEqual([]);
  });
});

describe('smoothLinePath', () => {
  it('is empty for no points and a bare move for one', () => {
    expect(smoothLinePath([])).toBe('');
    expect(smoothLinePath([{ x: 3.14159, y: 2 }])).toBe('M 3.14 2');
  });

  it('emits one cubic segment per gap, all coordinates rounded', () => {
    const path = smoothLinePath([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ]);
    expect(path.startsWith('M 0 0')).toBe(true);
    expect(path.match(/C /g)).toHaveLength(2);
    for (const number of path.match(/-?\d+\.?\d*/g) ?? []) {
      expect(number).toMatch(/^-?\d+(\.\d{1,2})?$/);
    }
  });

  it('closes the area down to the baseline and back', () => {
    const area = smoothAreaPath(
      [
        { x: 0, y: 4 },
        { x: 10, y: 6 },
      ],
      50,
    );
    expect(area.endsWith('L 10 50 L 0 50 Z')).toBe(true);
  });
});

describe('buildTemperatureChart', () => {
  const series = hours([17, 16.1, 15.7, 15.1, 14.7, 15.9, 18.2, 21, 24.5, 27.1, 29, 31.8], [0, 0, 0, 10, 20, 45, 60, 30, 10, 0, 0, 5]);

  it('lays out points, bars, ticks and markers from the data alone', () => {
    const chart = buildTemperatureChart({ hours: series });

    expect(chart.hasData).toBe(true);
    expect(chart.points).toHaveLength(series.length);
    expect(chart.bars).toHaveLength(series.length);
    expect(chart.linePath.startsWith('M ')).toBe(true);
    expect(chart.areaPath.endsWith('Z')).toBe(true);

    // The bounds must contain the data, and the ticks must sit inside the bounds.
    expect(chart.bounds.min).toBeLessThanOrEqual(14.7);
    expect(chart.bounds.max).toBeGreaterThanOrEqual(31.8);
    for (const tick of chart.yTicks) {
      expect(tick.value).toBeGreaterThanOrEqual(chart.bounds.min);
      expect(tick.value).toBeLessThanOrEqual(chart.bounds.max);
    }
  });

  it('puts every point inside the plot box', () => {
    const chart = buildTemperatureChart({ hours: series });
    for (const point of chart.points) {
      expect(point.x).toBeGreaterThanOrEqual(chart.plot.x);
      expect(point.x).toBeLessThanOrEqual(chart.plot.x + chart.plot.width);
      expect(point.y).toBeGreaterThanOrEqual(chart.plot.y);
      expect(point.y).toBeLessThanOrEqual(chart.baselineY);
    }
  });

  it('grows precipitation bars up from the baseline, in proportion to probability', () => {
    const chart = buildTemperatureChart({ hours: series });
    const dry = chart.bars[0];
    const wettest = chart.bars[6];

    expect(dry.height).toBe(0);
    expect(wettest.probability).toBe(60);
    expect(wettest.height).toBeGreaterThan(0);
    expect(round(wettest.y + wettest.height)).toBe(round(chart.baselineY));
  });

  it('marks the single warmest and coldest hour, breaking ties on the earlier one', () => {
    const chart = buildTemperatureChart({ hours: series });
    expect(chart.warmest?.hour.temperature).toBe(31.8);
    expect(chart.coldest?.hour.temperature).toBe(14.7);

    const flat = buildTemperatureChart({ hours: hours([12, 12, 12]) });
    expect(flat.warmest?.index).toBe(0);
    expect(flat.coldest?.index).toBe(0);
  });

  it('converts before scaling, so the Fahrenheit axis is labelled in Fahrenheit', () => {
    const celsius = buildTemperatureChart({ hours: series });
    const fahrenheit = buildTemperatureChart({
      hours: series,
      units: 'f',
      convert: (value: number, units: string) => (units === 'f' ? value * (9 / 5) + 32 : value),
    });

    expect(fahrenheit.bounds.max).toBeGreaterThan(celsius.bounds.max);
    expect(fahrenheit.bounds.min).toBeGreaterThan(celsius.bounds.min);
    // The curve is the same shape in both units — only the labels differ.
    expect(fahrenheit.points).toHaveLength(celsius.points.length);
  });

  it('draws an empty but valid chart when a scenario emptied the series', () => {
    const chart = buildTemperatureChart({ hours: [] });
    expect(chart.hasData).toBe(false);
    expect(chart.points).toEqual([]);
    expect(chart.bars).toEqual([]);
    expect(chart.linePath).toBe('');
    expect(chart.warmest).toBeNull();
    expect(chart.coldest).toBeNull();
    expect(chart.yTicks.length).toBeGreaterThan(0);
  });

  it('labels the x axis only on six-hour boundaries', () => {
    const chart = buildTemperatureChart({ hours: hours(Array.from({ length: 48 }, (_, i) => 10 + (i % 12))) });
    expect(chart.xTicks.length).toBeGreaterThan(0);
    for (const tick of chart.xTicks) expect(tick.hour.hourOfDay % 6).toBe(0);
  });

  it('thins the x labels for the narrow geometry, which has no room for eight of them', () => {
    const series48 = hours(Array.from({ length: 48 }, (_, i) => 10 + (i % 12)));
    const wide = buildTemperatureChart({ hours: series48, xTickEvery: 6 });
    const narrow = buildTemperatureChart({ hours: series48, width: 360, height: 240, xTickEvery: 12 });

    expect(narrow.xTicks.length).toBeLessThan(wide.xTicks.length);
    for (const tick of narrow.xTicks) expect(tick.hour.hourOfDay % 12).toBe(0);
    expect(narrow.width).toBe(360);
    // Taller relative to its width than the desktop chart, so the labels survive the scale-down.
    expect(narrow.height / narrow.width).toBeGreaterThan(wide.height / wide.width);
  });
});

describe('buildSparkline', () => {
  it('draws a curve and its fill for a real series', () => {
    const spark = buildSparkline([12, 13, 15, 14, 11]);
    expect(spark.hasData).toBe(true);
    expect(spark.path.startsWith('M ')).toBe(true);
    expect(spark.areaPath.endsWith('Z')).toBe(true);
  });

  it('reports no data rather than drawing a degenerate line', () => {
    expect(buildSparkline([]).hasData).toBe(false);
    expect(buildSparkline([12]).hasData).toBe(false);
    expect(buildSparkline([Number.NaN, null as unknown as number]).hasData).toBe(false);
  });
});
