/**
 * Open-Meteo endpoints, as pure URL builders.
 *
 * This module is the single place a request URL is constructed, and it is imported by three
 * different consumers:
 *
 *   1. the app, at run time, to fetch;
 *   2. `scripts/record-har.mjs`, to decide what to record;
 *   3. `tests/har.test.ts`, to assert the committed recording covers exactly what the app asks for.
 *
 * That sharing is the point. Playwright's `routeFromHAR` matches on the request URL, so a recording
 * whose URLs drift from the app's by one query parameter serves nothing, every request becomes a
 * HAR miss, and the frozen network the whole tool depends on silently stops working. Building the
 * URL in one place makes that class of drift impossible rather than merely unlikely.
 *
 * Parameter order is fixed by construction (`URLSearchParams` preserves insertion order), so the
 * same inputs always produce the same byte string.
 */

export const FORECAST_ORIGIN = 'https://api.open-meteo.com';
export const GEOCODING_ORIGIN = 'https://geocoding-api.open-meteo.com';
export const AIR_QUALITY_ORIGIN = 'https://air-quality-api.open-meteo.com';

/** Every origin the app is allowed to talk to. Asserted over the committed HAR. */
export const API_ORIGINS = [FORECAST_ORIGIN, GEOCODING_ORIGIN, AIR_QUALITY_ORIGIN];

/**
 * `timezone=UTC` rather than `auto`: the runner pins `TZ=UTC` and freezes the clock, and a
 * timezone-shifted payload would make the chart's x-axis depend on where the recording was taken.
 */
const FORECAST_PARAMS = {
  current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day',
  hourly: 'temperature_2m,precipitation_probability,weather_code',
  daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset',
  timezone: 'UTC',
  forecast_days: '7',
};

const AIR_QUALITY_PARAMS = {
  current: 'european_aqi,pm10,pm2_5,ozone,nitrogen_dioxide',
  hourly: 'european_aqi,pm10,pm2_5',
  timezone: 'UTC',
  forecast_days: '1',
};

const GEOCODING_PARAMS = {
  count: '5',
  language: 'en',
  format: 'json',
};

/**
 * Coordinates travel as strings all the way from the location table to the URL.
 *
 * `String(-21.9426)` happens to round-trip, but `String(0.1 + 0.2)` does not, and a coordinate that
 * renders one way in the recorder and another way in the app is exactly the silent HAR miss this
 * module exists to prevent. Keeping them as authored text removes the question.
 */
function coord(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new TypeError(`coordinate must be a finite number or a string, got ${JSON.stringify(value)}`);
}

function build(origin, path, params) {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Hourly + daily + current forecast for one point. Used by both the list and the detail screen. */
export function forecastUrl({ latitude, longitude }) {
  return build(FORECAST_ORIGIN, '/v1/forecast', {
    latitude: coord(latitude),
    longitude: coord(longitude),
    ...FORECAST_PARAMS,
  });
}

/** Air quality for one point. Only the detail screen asks for it. */
export function airQualityUrl({ latitude, longitude }) {
  return build(AIR_QUALITY_ORIGIN, '/v1/air-quality', {
    latitude: coord(latitude),
    longitude: coord(longitude),
    ...AIR_QUALITY_PARAMS,
  });
}

/** Place-name search, behind the search form on the location list. */
export function geocodeUrl(query) {
  return build(GEOCODING_ORIGIN, '/v1/search', { name: query, ...GEOCODING_PARAMS });
}

/**
 * Thrown for anything the caller should render as the error state: a non-2xx response, an
 * Open-Meteo `{"error": true, "reason": …}` body, or a transport failure (which is what a replayed
 * run produces for a URL the recording does not contain).
 */
export class ApiError extends Error {
  constructor(message, { status = null, url = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
  }
}

/**
 * Fetch JSON and normalise every failure into an `ApiError`.
 *
 * Open-Meteo reports parameter errors as a 400 carrying `{"error": true, "reason": "…"}`, so the
 * reason is surfaced verbatim: the error screen shows what the API actually said rather than a
 * generic apology, which makes the recorded 400 worth having as a fixture at all.
 */
export async function fetchJson(url, { fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new ApiError('Could not reach the weather service.', { url, cause });
  }

  let body = null;
  try {
    body = await response.json();
  } catch (cause) {
    if (response.ok) throw new ApiError('The weather service sent a malformed response.', { status: response.status, url, cause });
  }

  if (!response.ok || (body !== null && body.error === true)) {
    const reason = body !== null && typeof body.reason === 'string' ? body.reason : `Request failed with status ${response.status}.`;
    throw new ApiError(reason, { status: response.status, url });
  }

  return body;
}
