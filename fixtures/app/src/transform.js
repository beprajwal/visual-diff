/**
 * Open-Meteo payloads → view models.
 *
 * Everything here is defensive in one specific direction: a *scenario* may have removed a field, an
 * array, or every element of an array before the app sees it. That is the whole point of the
 * overlay engine, so "the API returned no hours" and "the API returned no `daily` at all" are
 * ordinary inputs, not corruption. Each one has to produce a renderable empty view model rather
 * than a thrown error, because a fixture that white-screens under a scenario cannot be diffed.
 *
 * The complementary rule: nothing here invents data. A missing value becomes `null`, and the view
 * renders an em-dash. Filling a gap with a plausible number would make a patched-away field look
 * like it was never patched.
 */

import { describeWeatherCode } from './weather-codes.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** "2026-08-09T20:00" → 20. Returns null for anything that is not an ISO-ish local timestamp. */
export function hourOfDay(isoLocal) {
  if (typeof isoLocal !== 'string') return null;
  const match = /T(\d{2}):/.exec(isoLocal);
  return match === null ? null : Number(match[1]);
}

/** "2026-08-09T20:00" → "20:00". */
export function formatHourLabel(isoLocal) {
  if (typeof isoLocal !== 'string') return '—';
  const match = /T(\d{2}:\d{2})/.exec(isoLocal);
  return match === null ? '—' : match[1];
}

/** "2026-08-09" → "Sun 9 Aug", computed from the string, never from a clock. */
const WEEKDAYS = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDayLabel(isoDate) {
  if (typeof isoDate !== 'string') return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (match === null) return '—';
  const [, year, month, day] = match;
  // `Date.UTC` is arithmetic on the string's own numbers, not a reading of the current time, so the
  // label is identical on every machine and under the runner's frozen clock.
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const weekday = WEEKDAYS[(Math.floor(timestamp / 86_400_000) % 7 + 7) % 7];
  return `${weekday} ${Number(day)} ${MONTHS[Number(month) - 1] ?? '—'}`;
}

/**
 * The index in `hourly.time` matching `current.time`, or 0.
 *
 * `current.time` is a quarter-hour stamp ("…T20:15") while `hourly.time` is on the hour, so this
 * matches on the shared "…THH" prefix rather than on equality.
 */
export function currentHourIndex(times, currentTime) {
  if (typeof currentTime !== 'string') return 0;
  const prefix = currentTime.slice(0, 13);
  const index = times.findIndex((time) => typeof time === 'string' && time.slice(0, 13) === prefix);
  return index < 0 ? 0 : index;
}

/** `count` hourly samples starting at the current hour, as chart-ready rows. */
export function sliceHours(hourly, currentTime, count = 48) {
  const times = asArray(hourly?.time);
  const temperatures = asArray(hourly?.temperature_2m);
  const probabilities = asArray(hourly?.precipitation_probability);
  const codes = asArray(hourly?.weather_code);

  const start = currentHourIndex(times, currentTime);
  const rows = [];
  for (let i = start; i < times.length && rows.length < count; i += 1) {
    const temperature = asNumber(temperatures[i]);
    if (temperature === null) continue;
    rows.push({
      time: times[i],
      label: formatHourLabel(times[i]),
      hourOfDay: hourOfDay(times[i]) ?? 0,
      temperature,
      precipitationProbability: asNumber(probabilities[i]) ?? 0,
      weather: describeWeatherCode(codes[i]),
    });
  }
  return rows;
}

export function toDailyRows(daily) {
  const times = asArray(daily?.time);
  const codes = asArray(daily?.weather_code);
  const maxima = asArray(daily?.temperature_2m_max);
  const minima = asArray(daily?.temperature_2m_min);
  const precipitation = asArray(daily?.precipitation_sum);
  const sunrises = asArray(daily?.sunrise);
  const sunsets = asArray(daily?.sunset);

  return times.map((time, index) => ({
    date: time,
    label: formatDayLabel(time),
    weather: describeWeatherCode(codes[index]),
    max: asNumber(maxima[index]),
    min: asNumber(minima[index]),
    precipitation: asNumber(precipitation[index]),
    sunrise: formatHourLabel(sunrises[index]),
    sunset: formatHourLabel(sunsets[index]),
  }));
}

/** The one full forecast view model, shared by the detail screen and the location cards. */
export function toForecastView(payload, { hours = 48 } = {}) {
  const current = payload?.current ?? {};
  const days = toDailyRows(payload?.daily);
  const hourly = sliceHours(payload?.hourly, current.time, hours);

  return {
    observedAt: typeof current.time === 'string' ? current.time : null,
    observedLabel: formatHourLabel(current.time),
    temperature: asNumber(current.temperature_2m),
    apparentTemperature: asNumber(current.apparent_temperature),
    humidity: asNumber(current.relative_humidity_2m),
    precipitation: asNumber(current.precipitation),
    windSpeed: asNumber(current.wind_speed_10m),
    isDay: current.is_day === 1,
    weather: describeWeatherCode(current.weather_code),
    elevation: asNumber(payload?.elevation),
    hours: hourly,
    days,
    /** The two facts every empty-state decision in the UI is made from. */
    hasHours: hourly.length > 0,
    hasDays: days.length > 0,
  };
}

/** The union of daily minima and maxima, for the range bars in the 7-day strip. */
export function dailyBounds(days) {
  const values = [];
  for (const day of days) {
    if (day.min !== null) values.push(day.min);
    if (day.max !== null) values.push(day.max);
  }
  if (values.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max === min ? { min, max: min + 1 } : { min, max };
}

export function toAirQualityView(payload) {
  const current = payload?.current ?? {};
  const hourly = payload?.hourly ?? {};
  const times = asArray(hourly.time);
  const indices = asArray(hourly.european_aqi);

  return {
    observedLabel: formatHourLabel(current.time),
    europeanAqi: asNumber(current.european_aqi),
    pm10: asNumber(current.pm10),
    pm25: asNumber(current.pm2_5),
    ozone: asNumber(current.ozone),
    nitrogenDioxide: asNumber(current.nitrogen_dioxide),
    hours: times
      .map((time, index) => ({ time, label: formatHourLabel(time), aqi: asNumber(indices[index]) }))
      .filter((row) => row.aqi !== null),
  };
}

/**
 * The European AQI bands, which drive the colour of the badge and the bars.
 *
 * Boundaries are the published ones; `null` (a patched-away index) gets its own band rather than
 * being silently bucketed as "good".
 */
export function aqiBand(index) {
  if (index === null || index === undefined || !Number.isFinite(index)) {
    return { key: 'unknown', label: 'No reading' };
  }
  if (index <= 20) return { key: 'good', label: 'Good' };
  if (index <= 40) return { key: 'fair', label: 'Fair' };
  if (index <= 60) return { key: 'moderate', label: 'Moderate' };
  if (index <= 80) return { key: 'poor', label: 'Poor' };
  if (index <= 100) return { key: 'very-poor', label: 'Very poor' };
  return { key: 'extreme', label: 'Extremely poor' };
}

/**
 * Geocoding results → search rows.
 *
 * Open-Meteo omits `results` entirely when nothing matches — there is no empty array to check — so
 * a missing key and an empty list have to mean the same thing here. The screen distinguishes
 * "searched and found nothing" from "not searched yet" using the request status, never the payload.
 */
export function toSearchResults(payload) {
  return asArray(payload?.results).map((result) => ({
    id: result.id,
    name: result.name,
    country: typeof result.country === 'string' ? result.country : null,
    admin1: typeof result.admin1 === 'string' ? result.admin1 : null,
    latitude: asNumber(result.latitude),
    longitude: asNumber(result.longitude),
    population: asNumber(result.population),
    elevation: asNumber(result.elevation),
  }));
}

export function describePlace(result) {
  return [result.admin1, result.country].filter((part) => typeof part === 'string' && part.length > 0).join(', ');
}
