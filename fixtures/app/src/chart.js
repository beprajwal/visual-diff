/**
 * Chart geometry, as pure functions over numbers.
 *
 * The SVG time-series chart is the reason this fixture exists: it is a large area of the screen
 * whose pixels are derived from an API payload by arithmetic, so a scenario that patches one number
 * in `hourly.temperature_2m` moves a curve, and a pixel diff is the only thing that notices. Every
 * coordinate therefore comes from here, where it can be tested without a browser.
 *
 * Two constraints shape the implementation:
 *
 *   1. **No `Math.random`, no `Date.now`.** The runner seeds one and freezes the other, and a chart
 *      that depends on either would produce a finding on every run and drown the real ones.
 *   2. **Coordinates are rounded to two decimals.** Floating-point tails in a `d` attribute are
 *      invisible on screen but land in `dom.json`, where they turn into attribute-change findings
 *      that mean nothing. Rounding at the boundary keeps the DOM diff honest.
 */

/** Two decimals is well under a device pixel at `deviceScaleFactor: 2`, and it prints short. */
export function round(value) {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * A linear scale from a data domain to a pixel range.
 *
 * A zero-width domain (every hour the same temperature — a real payload for a still day, and the
 * exact shape a scenario produces when it flattens a series) maps to the middle of the range
 * instead of dividing by zero.
 */
export function linearScale([d0, d1], [r0, r1]) {
  const span = d1 - d0;
  if (span === 0) return () => round((r0 + r1) / 2);
  const factor = (r1 - r0) / span;
  return (value) => round(r0 + (value - d0) * factor);
}

/**
 * Round a data range outward to a multiple of `step`, with a minimum height.
 *
 * Without the minimum, a series spanning 0.3° fills the plot with a curve that looks like a
 * mountain range, and the next re-record redraws it completely for a change nobody can feel.
 */
export function niceBounds(values, { step = 5, minSpan = 10 } = {}) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { min: 0, max: minSpan };

  let min = Math.min(...finite);
  let max = Math.max(...finite);

  if (max - min < minSpan) {
    const middle = (min + max) / 2;
    min = middle - minSpan / 2;
    max = middle + minSpan / 2;
  }

  return {
    min: Math.floor(min / step) * step,
    max: Math.ceil(max / step) * step,
  };
}

/** Every `step`-th multiple inside `[min, max]`, inclusive. */
export function ticksBetween(min, max, step) {
  const out = [];
  for (let value = Math.ceil(min / step) * step; value <= max + 1e-9; value += step) out.push(round(value));
  return out;
}

/**
 * A smooth path through `points`, as a cubic Bézier chain (Catmull-Rom with a tension of 1/6).
 *
 * A polyline through 48 hourly readings reads as a saw; a smoothed curve reads as weather. The
 * control points are derived only from the neighbouring samples, so the curve is a pure function of
 * the data — no easing, no animation, nothing that depends on when it was drawn.
 */
export function smoothLinePath(points) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${round(points[0].x)} ${round(points[0].y)}`;

  const parts = [`M ${round(points[0].x)} ${round(points[0].y)}`];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;

    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;

    parts.push(`C ${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(p2.x)} ${round(p2.y)}`);
  }
  return parts.join(' ');
}

/** The same curve, closed down to `baselineY`, for the gradient fill under it. */
export function smoothAreaPath(points, baselineY) {
  if (points.length === 0) return '';
  const line = smoothLinePath(points);
  const last = points[points.length - 1];
  const first = points[0];
  return `${line} L ${round(last.x)} ${round(baselineY)} L ${round(first.x)} ${round(baselineY)} Z`;
}

/**
 * Lay a temperature series and a precipitation-probability series into one plot box.
 *
 * Returns everything the SVG needs and nothing it does not: the caller maps over arrays, it never
 * computes a coordinate. `series` may be empty — that is the empty state, and it must produce a
 * drawable (if bare) chart rather than a crash, because "the API returned no hours" is precisely
 * one of the scenarios this fixture exists to render.
 */
export function buildTemperatureChart({
  hours,
  width = 880,
  height = 300,
  padding = { top: 24, right: 24, bottom: 34, left: 46 },
  tickStep = 5,
  xTickEvery = 6,
  units = 'c',
  convert = (celsius) => celsius,
}) {
  const plot = {
    x: padding.left,
    y: padding.top,
    width: Math.max(0, width - padding.left - padding.right),
    height: Math.max(0, height - padding.top - padding.bottom),
  };
  const baselineY = plot.y + plot.height;

  const temperatures = hours.map((hour) => convert(hour.temperature, units));
  const bounds = niceBounds(temperatures, { step: tickStep, minSpan: tickStep * 2 });
  const yTicks = ticksBetween(bounds.min, bounds.max, tickStep);

  const scaleY = linearScale([bounds.min, bounds.max], [baselineY, plot.y]);
  const lastIndex = Math.max(1, hours.length - 1);
  const scaleX = linearScale([0, lastIndex], [plot.x, plot.x + plot.width]);

  const points = hours.map((hour, index) => ({
    x: scaleX(index),
    y: scaleY(convert(hour.temperature, units)),
    index,
    hour,
  }));

  // Precipitation bars share the x scale and get the bottom third of the plot, drawn behind the
  // curve. One bar per hour, gapped so 48 of them stay countable.
  const bandHeight = round(plot.height * 0.34);
  const slot = hours.length > 0 ? plot.width / hours.length : 0;
  const barWidth = round(Math.max(2, slot * 0.55));
  const bars = hours.map((hour, index) => {
    const probability = Number.isFinite(hour.precipitationProbability) ? hour.precipitationProbability : 0;
    const barHeight = round((probability / 100) * bandHeight);
    return {
      index,
      x: round(scaleX(index) - barWidth / 2),
      y: round(baselineY - barHeight),
      width: barWidth,
      height: barHeight,
      probability,
      hour,
    };
  });

  const extremes = findExtremes(points);

  return {
    width,
    height,
    plot,
    baselineY,
    bounds,
    yTicks: yTicks.map((value) => ({ value, y: scaleY(value) })),
    // Every `xTickEvery`-th hour of the day, so the labels land on round clock times rather than on
    // whichever hour the recording happened to start at. Narrow viewports pass a larger value: at
    // 390px there is no room for eight labels and they would overlap into a smear.
    xTicks: points.filter((point) => point.hour.hourOfDay % xTickEvery === 0),
    points,
    bars,
    linePath: smoothLinePath(points),
    areaPath: smoothAreaPath(points, baselineY),
    warmest: extremes.warmest,
    coldest: extremes.coldest,
    hasData: hours.length > 0,
  };
}

/**
 * The single warmest and coldest sample.
 *
 * Ties resolve to the earliest hour so the marker cannot jump between two identical readings — an
 * unstable tie-break is a finding on a run where nothing changed.
 */
function findExtremes(points) {
  let warmest = null;
  let coldest = null;
  for (const point of points) {
    const value = point.hour.temperature;
    if (!Number.isFinite(value)) continue;
    if (warmest === null || value > warmest.hour.temperature) warmest = point;
    if (coldest === null || value < coldest.hour.temperature) coldest = point;
  }
  return { warmest, coldest };
}

/**
 * A compact sparkline path for the location cards, normalised into its own little box.
 *
 * Shares `smoothLinePath` with the big chart so the two cannot disagree about what a curve looks
 * like, which is the sort of drift that shows up as an unexplained diff months later.
 */
export function buildSparkline(temperatures, { width = 168, height = 44, padding = 4 } = {}) {
  const finite = temperatures.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return { path: '', areaPath: '', width, height, hasData: false };

  const bounds = niceBounds(finite, { step: 1, minSpan: 2 });
  const scaleY = linearScale([bounds.min, bounds.max], [height - padding, padding]);
  const scaleX = linearScale([0, temperatures.length - 1], [padding, width - padding]);
  const points = temperatures.map((value, index) => ({
    x: scaleX(index),
    y: scaleY(Number.isFinite(value) ? value : bounds.min),
  }));

  return {
    path: smoothLinePath(points),
    areaPath: smoothAreaPath(points, height - padding),
    width,
    height,
    hasData: true,
  };
}
