/**
 * The saved locations the dashboard opens on, and the ad-hoc points the recording also covers.
 *
 * Four places chosen so the recorded payloads are genuinely different from one another: a mid
 * northern city, a sub-arctic island, an equatorial highland, and a southern-hemisphere coast. The
 * seasons are opposite, the daylight hours are wildly different, and the temperature ranges do not
 * overlap — which is what makes the chart worth pixel-diffing and stops a scenario that patches one
 * location from accidentally looking correct against all of them.
 *
 * Coordinates are strings on purpose; see `coord()` in `api.js`.
 */

export const LOCATIONS = [
  {
    slug: 'berlin',
    name: 'Berlin',
    region: 'Germany',
    latitude: '52.52',
    longitude: '13.405',
  },
  {
    slug: 'reykjavik',
    name: 'Reykjavík',
    region: 'Iceland',
    latitude: '64.1466',
    longitude: '-21.9426',
  },
  {
    slug: 'nairobi',
    name: 'Nairobi',
    region: 'Kenya',
    latitude: '-1.2864',
    longitude: '36.8172',
  },
  {
    slug: 'wellington',
    name: 'Wellington',
    region: 'New Zealand',
    latitude: '-41.2866',
    longitude: '174.7756',
  },
];

export function findLocation(slug) {
  return LOCATIONS.find((location) => location.slug === slug) ?? null;
}

/**
 * Search terms the recording covers.
 *
 * `san` is the populated case, `zzzzzzzz` is the genuinely empty one — Open-Meteo answers it with
 * `200 {"generationtime_ms": …}` and no `results` key at all, which is a real empty response rather
 * than an invented one. An app that only ever renders lists it has data for has no empty state to
 * regress.
 */
export const RECORDED_SEARCHES = ['san', 'reykjavik', 'zzzzzzzz'];

/**
 * Where a search result leads.
 *
 * Clicking the first hit for "san" navigates to `#/at/32.71571,-117.16472`, which asks for a
 * forecast the recording has to contain — otherwise the most interesting path through the app
 * (search → pick → forecast) ends in a HAR miss and the run carries a warning that has nothing to
 * do with the change under test.
 *
 * These coordinates are the ones Open-Meteo returned, transcribed. `tests/har.test.ts` asserts they
 * still match the recorded search payload, so a re-record that shifts San Diego by a decimal place
 * fails a test instead of quietly breaking that path.
 */
export const RECORDED_SEARCH_DESTINATIONS = [
  { label: 'San Diego', query: 'san', latitude: '32.71571', longitude: '-117.16472' },
];

/**
 * A point outside the valid coordinate range.
 *
 * Open-Meteo answers `400 {"error": true, "reason": "Latitude must be in range of -90 to 90°. …"}`,
 * so the error screen is driven by a real recorded failure. It is reachable the way a real one is —
 * `#/at/999,13.405`, a hand-edited or stale URL — rather than by a button labelled "break it".
 */
export const OUT_OF_RANGE_POINT = { latitude: '999', longitude: '13.405' };
