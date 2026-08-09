/**
 * A miniature recorded API for the golden tests (mocking spec §10.3).
 *
 * Shaped after the Open-Meteo payloads the fixture app records (D14) — nested objects, parallel
 * numeric arrays, nulls inside those arrays, and a binary asset — because those are what stress
 * merge patch and `patchOps`. It is deliberately *not* the committed fixture HAR: the engine's
 * golden tests must stay hermetic and stable even while `fixtures/app` is being built, and a golden
 * test that changes whenever the fixture is re-recorded stops being a golden test.
 *
 * Kept in TypeScript rather than a `.json` file so it needs no loader, no `resolveJsonModule`
 * interaction and no build step of its own.
 */

import type { RecordedResponse } from './response.js';

export const FORECAST_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.13&hourly=temperature_2m&daily=weather_code';
export const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search?name=lisbon&count=2';
export const AIR_QUALITY_URL =
  'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=38.72&longitude=-9.13';
export const ANALYTICS_URL = 'https://analytics.example.test/analytics/collect?event=view';
export const CHART_URL = 'http://localhost:5173/assets/sparkline.png';
export const PLAIN_URL = 'http://localhost:5173/assets/notes.txt';

/** The forecast body every patch test starts from. Nulls are real: Open-Meteo emits them. */
export const FORECAST_BODY = {
  latitude: 38.72,
  longitude: -9.13,
  timezone: 'Europe/Lisbon',
  current_weather: { temperature: 17.4, weathercode: 3, is_day: 1 },
  hourly_units: { time: 'iso8601', temperature_2m: '°C' },
  hourly: {
    time: ['2026-08-10T00:00', '2026-08-10T01:00', '2026-08-10T02:00', '2026-08-10T03:00'],
    temperature_2m: [17.4, 17.1, null, 16.6],
  },
  daily: {
    time: ['2026-08-10', '2026-08-11', '2026-08-12'],
    weather_code: [3, 61, 0],
    temperature_2m_max: [24.8, 22.1, 26.3],
  },
};

export const SEARCH_BODY = {
  results: [
    { id: 2267057, name: 'Lisbon', country: 'Portugal', latitude: 38.72, longitude: -9.13 },
    { id: 4335045, name: 'Lisbon', country: 'United States', latitude: 30.24, longitude: -91.9 },
  ],
  generationtime_ms: 0.62,
};

export const AIR_QUALITY_BODY = {
  hourly: { time: ['2026-08-10T00:00', '2026-08-10T01:00'], pm10: [11.2, 12.9] },
};

/** A 1x1 transparent PNG: the smallest honest non-JSON body. */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function json(body: unknown, status = 200): RecordedResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '512' },
    mediaType: 'application/json',
    text: JSON.stringify(body),
  };
}

/**
 * The recorded responses, keyed exactly as `runner/har.ts` keys them: `METHOD url`.
 *
 * The forecast URL is recorded twice with different bodies, which is what makes `nth` testable: the
 * second occurrence of an otherwise identical request is a real thing a dashboard does when it
 * refetches after a units toggle.
 */
export function recordedResponses(): Map<string, RecordedResponse[]> {
  const entries = new Map<string, RecordedResponse[]>();
  entries.set(`GET ${FORECAST_URL}`, [
    json(FORECAST_BODY),
    json({ ...FORECAST_BODY, current_weather: { temperature: 18.9, weathercode: 61, is_day: 1 } }),
  ]);
  entries.set(`GET ${SEARCH_URL}`, [json(SEARCH_BODY)]);
  entries.set(`GET ${AIR_QUALITY_URL}`, [json(AIR_QUALITY_BODY)]);
  entries.set(`POST ${ANALYTICS_URL}`, [json({ ok: true }, 202)]);
  entries.set(`GET ${CHART_URL}`, [
    {
      status: 200,
      headers: { 'content-type': 'image/png' },
      mediaType: 'image/png',
      // The recorded text is the decoded form, exactly as `indexHar` hands it over.
      text: Buffer.from(PNG_BASE64, 'base64').toString('utf8'),
    },
  ]);
  entries.set(`GET ${PLAIN_URL}`, [
    {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      mediaType: 'text/plain',
      text: '{"looks":"like json but is not served as json"}',
    },
  ]);
  return entries;
}

/**
 * A recording lookup for the golden tests. Repeats are served positionally by occurrence and then
 * clamp to the last entry, which is how a replay behaves once the recording runs out.
 */
export function recordingLookup(): (
  method: string,
  url: string,
  occurrence?: number,
) => RecordedResponse | undefined {
  const entries = recordedResponses();
  return (method: string, url: string, occurrence = 1) => {
    const list = entries.get(`${method.toUpperCase()} ${url}`);
    if (list === undefined || list.length === 0) return undefined;
    return list[Math.min(occurrence, list.length) - 1];
  };
}
