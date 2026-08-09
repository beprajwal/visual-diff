/**
 * The C/F toggle, as pure functions.
 *
 * Every temperature in the payload is Celsius (`timezone=UTC` and metric units are pinned in the
 * request), so conversion happens exactly once, on the way to the screen. Nothing in state is ever
 * stored in display units — a converted value that gets converted again is the classic version of
 * this bug, and it produces a plausible-looking wrong number rather than an obvious one.
 */

export const UNITS = ['c', 'f'];

export const DEFAULT_UNITS = 'c';

export function isUnits(value) {
  return UNITS.includes(value);
}

export function normalizeUnits(value) {
  return isUnits(value) ? value : DEFAULT_UNITS;
}

export function otherUnits(units) {
  return normalizeUnits(units) === 'c' ? 'f' : 'c';
}

/** Celsius in, display units out. */
export function convertTemperature(celsius, units) {
  if (celsius === null || celsius === undefined || !Number.isFinite(celsius)) return null;
  return normalizeUnits(units) === 'f' ? celsius * (9 / 5) + 32 : celsius;
}

export function unitSymbol(units) {
  return normalizeUnits(units) === 'f' ? '°F' : '°C';
}

/**
 * Whole degrees, because a dashboard that shows 26.8° next to 80.2° is claiming a precision the
 * forecast does not have — and because half the pixels in the chart's axis labels would be decimal
 * points that change on every re-record.
 */
export function formatTemperature(celsius, units, { withUnit = true } = {}) {
  const value = convertTemperature(celsius, units);
  if (value === null) return '—';
  const rounded = Math.round(value);
  // `Math.round(-0.4)` is `-0`, which renders as "-0°".
  const safe = Object.is(rounded, -0) ? 0 : rounded;
  return withUnit ? `${safe}${unitSymbol(units)}` : `${safe}°`;
}

export function formatPercent(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`;
}

export function formatWind(kmh, units) {
  if (kmh === null || kmh === undefined || !Number.isFinite(kmh)) return '—';
  return normalizeUnits(units) === 'f'
    ? `${Math.round(kmh * 0.621371)} mph`
    : `${Math.round(kmh)} km/h`;
}

export function formatMillimetres(mm, units) {
  if (mm === null || mm === undefined || !Number.isFinite(mm)) return '—';
  return normalizeUnits(units) === 'f' ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
}
