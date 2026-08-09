/**
 * The exact set of requests the committed HAR must contain.
 *
 * Derived from the location table and the URL builders rather than written out by hand, so there is
 * one description of "what this fixture talks to" and three users of it: the recorder writes these,
 * the test asserts the recording contains these and nothing else, and the app requests these at run
 * time because it calls the same builders.
 */

import { airQualityUrl, forecastUrl, geocodeUrl } from './api.js';
import {
  LOCATIONS,
  OUT_OF_RANGE_POINT,
  RECORDED_SEARCHES,
  RECORDED_SEARCH_DESTINATIONS,
} from './locations.js';

/**
 * @returns {{ url: string, kind: 'forecast' | 'air-quality' | 'geocoding', label: string,
 *             expectStatus: number }[]}
 */
export function recordingPlan() {
  const plan = [];

  for (const location of LOCATIONS) {
    plan.push({
      url: forecastUrl(location),
      kind: 'forecast',
      label: `forecast ${location.name}`,
      expectStatus: 200,
    });
  }

  for (const location of LOCATIONS) {
    plan.push({
      url: airQualityUrl(location),
      kind: 'air-quality',
      label: `air quality ${location.name}`,
      expectStatus: 200,
    });
  }

  // Search → pick a result → forecast is the most interesting path through the app, so the point a
  // search result links to has to be in the recording too.
  for (const destination of RECORDED_SEARCH_DESTINATIONS) {
    plan.push({
      url: forecastUrl(destination),
      kind: 'forecast',
      label: `forecast ${destination.label} (search destination)`,
      expectStatus: 200,
    });
    plan.push({
      url: airQualityUrl(destination),
      kind: 'air-quality',
      label: `air quality ${destination.label} (search destination)`,
      expectStatus: 200,
    });
  }

  for (const query of RECORDED_SEARCHES) {
    plan.push({
      url: geocodeUrl(query),
      kind: 'geocoding',
      label: `search "${query}"`,
      expectStatus: 200,
    });
  }

  // The error state's evidence. Recorded deliberately, and asserted to still be a 400 — if
  // Open-Meteo ever starts accepting a latitude of 999 the fixture's error screen is a fiction and
  // the recorder should fail rather than quietly commit a 200.
  plan.push({
    url: forecastUrl(OUT_OF_RANGE_POINT),
    kind: 'forecast',
    label: 'forecast for an out-of-range latitude (the error state)',
    expectStatus: 400,
  });

  // The detail screen fires both requests, so the air-quality 400 is recorded too. Leaving it out
  // would still render the error screen — the request would abort as a HAR miss — but every run of
  // the error flow would then carry a miss warning, and a fixture that ships with a permanent
  // warning trains everyone to ignore the warning that matters.
  plan.push({
    url: airQualityUrl(OUT_OF_RANGE_POINT),
    kind: 'air-quality',
    label: 'air quality for an out-of-range latitude (the error state)',
    expectStatus: 400,
  });

  return plan;
}
