/**
 * Payload → view model.
 *
 * Almost every assertion here is about a *missing* field, because the api-mocking spec's whole
 * point is that a scenario removes things: `patch: { hourly: { temperature_2m: [] } }` empties an
 * array, `patchOps` removes an element, and `respond` replaces a whole body. Each of those arrives
 * here as a shape the live API would never produce, and each has to render rather than throw — a
 * fixture that white-screens under a scenario cannot be diffed, which makes the scenario untestable.
 *
 * The mirror rule is asserted too: nothing here invents a value. A field a scenario removed must
 * come out `null`, never a plausible substitute, or the patch would be invisible on screen.
 */

import { describe, expect, it } from 'vitest';

import {
  aqiBand,
  currentHourIndex,
  dailyBounds,
  describePlace,
  formatDayLabel,
  formatHourLabel,
  hourOfDay,
  sliceHours,
  toAirQualityView,
  toDailyRows,
  toForecastView,
  toSearchResults,
} from '../src/transform.js';

const HOURLY = {
  time: ['2026-08-09T18:00', '2026-08-09T19:00', '2026-08-09T20:00', '2026-08-09T21:00', '2026-08-09T22:00'],
  temperature_2m: [28.4, 27.6, 26.8, 25.1, 24],
  precipitation_probability: [0, 0, 10, 20, 5],
  weather_code: [0, 1, 3, 3, 61],
};

const DAILY = {
  time: ['2026-08-09', '2026-08-10'],
  weather_code: [3, 80],
  temperature_2m_max: [31.8, 30.2],
  temperature_2m_min: [14.6, 17.8],
  precipitation_sum: [0, 0.3],
  sunrise: ['2026-08-09T03:39', '2026-08-10T03:40'],
  sunset: ['2026-08-09T18:44', '2026-08-10T18:42'],
};

const CURRENT = {
  time: '2026-08-09T20:15',
  temperature_2m: 26.8,
  apparent_temperature: 26.2,
  relative_humidity_2m: 42,
  precipitation: 0,
  weather_code: 3,
  wind_speed_10m: 9.4,
  is_day: 0,
};

describe('timestamp helpers', () => {
  it('reads the hour out of an Open-Meteo local timestamp', () => {
    expect(hourOfDay('2026-08-09T20:00')).toBe(20);
    expect(hourOfDay('2026-08-09T00:00')).toBe(0);
    expect(hourOfDay('not a timestamp')).toBeNull();
    expect(hourOfDay(null)).toBeNull();
  });

  it('formats the hour label the x axis uses', () => {
    expect(formatHourLabel('2026-08-09T20:00')).toBe('20:00');
    expect(formatHourLabel(undefined)).toBe('—');
  });

  it('derives the weekday from the date string, never from a clock', () => {
    // 2026-08-09 is a Sunday; 2026-08-10 a Monday. Computed from the string's own numbers, so the
    // label is identical under the runner's frozen clock and in any timezone.
    expect(formatDayLabel('2026-08-09')).toBe('Sun 9 Aug');
    expect(formatDayLabel('2026-08-10')).toBe('Mon 10 Aug');
    expect(formatDayLabel('2026-01-01')).toBe('Thu 1 Jan');
    expect(formatDayLabel('nope')).toBe('—');
  });
});

describe('currentHourIndex', () => {
  it('matches the quarter-hour "current" stamp to its hourly bucket', () => {
    expect(currentHourIndex(HOURLY.time, '2026-08-09T20:15')).toBe(2);
    expect(currentHourIndex(HOURLY.time, '2026-08-09T18:00')).toBe(0);
  });

  it('falls back to the first sample when the stamp is missing or unmatched', () => {
    expect(currentHourIndex(HOURLY.time, '2029-01-01T00:00')).toBe(0);
    expect(currentHourIndex(HOURLY.time, undefined)).toBe(0);
    expect(currentHourIndex([], '2026-08-09T20:15')).toBe(0);
  });
});

describe('sliceHours', () => {
  it('starts at the current hour and stops at the requested count', () => {
    const rows = sliceHours(HOURLY, CURRENT.time, 2);
    expect(rows.map((row) => row.time)).toEqual(['2026-08-09T20:00', '2026-08-09T21:00']);
    expect(rows[0].temperature).toBe(26.8);
    expect(rows[0].precipitationProbability).toBe(10);
    expect(rows[0].weather.label).toBe('Overcast');
    expect(rows[0].hourOfDay).toBe(20);
  });

  it('returns nothing when a scenario emptied the series', () => {
    expect(sliceHours({ ...HOURLY, temperature_2m: [] }, CURRENT.time, 48)).toEqual([]);
    expect(sliceHours({}, CURRENT.time, 48)).toEqual([]);
    expect(sliceHours(undefined, CURRENT.time, 48)).toEqual([]);
  });

  it('skips samples whose temperature was patched to null, keeping the rest', () => {
    const patched = { ...HOURLY, temperature_2m: [28.4, null, 26.8, 25.1, 24] };
    const rows = sliceHours(patched, '2026-08-09T18:00', 48);
    expect(rows.map((row) => row.temperature)).toEqual([28.4, 26.8, 25.1, 24]);
  });

  it('defaults a missing precipitation probability to zero rather than dropping the hour', () => {
    const rows = sliceHours({ ...HOURLY, precipitation_probability: [] }, '2026-08-09T18:00', 3);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.precipitationProbability === 0)).toBe(true);
  });
});

describe('toDailyRows', () => {
  it('zips the parallel arrays into rows', () => {
    const rows = toDailyRows(DAILY);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: '2026-08-09',
      label: 'Sun 9 Aug',
      max: 31.8,
      min: 14.6,
      precipitation: 0,
      sunrise: '03:39',
      sunset: '18:44',
    });
    expect(rows[1].weather.label).toBe('Slight rain showers');
  });

  it('survives a patchOps removal that shortens one array but not the others', () => {
    // `{ op: remove, path: /daily/temperature_2m_max/0 }` leaves `time` longer than `max`.
    const rows = toDailyRows({ ...DAILY, temperature_2m_max: [30.2] });
    expect(rows).toHaveLength(2);
    expect(rows[0].max).toBe(30.2);
    expect(rows[1].max).toBeNull();
  });

  it('is empty when there is no daily block at all', () => {
    expect(toDailyRows(undefined)).toEqual([]);
    expect(toDailyRows({})).toEqual([]);
  });
});

describe('toForecastView', () => {
  const payload = { current: CURRENT, hourly: HOURLY, daily: DAILY, elevation: 37 };

  it('reads the current conditions and both series', () => {
    const view = toForecastView(payload, { hours: 3 });
    expect(view).toMatchObject({
      observedAt: '2026-08-09T20:15',
      observedLabel: '20:15',
      temperature: 26.8,
      apparentTemperature: 26.2,
      humidity: 42,
      precipitation: 0,
      windSpeed: 9.4,
      isDay: false,
      elevation: 37,
      hasHours: true,
      hasDays: true,
    });
    expect(view.weather.label).toBe('Overcast');
    expect(view.hours).toHaveLength(3);
    expect(view.days).toHaveLength(2);
  });

  it('reports the empty state the spec’s `empty-forecast` scenario produces', () => {
    const view = toForecastView({ ...payload, hourly: { ...HOURLY, temperature_2m: [] } });
    expect(view.hasHours).toBe(false);
    expect(view.hours).toEqual([]);
    // Everything else still renders — the scenario emptied one series, not the screen.
    expect(view.temperature).toBe(26.8);
    expect(view.hasDays).toBe(true);
  });

  it('renders an entirely empty body without throwing', () => {
    const view = toForecastView({});
    expect(view.temperature).toBeNull();
    expect(view.hours).toEqual([]);
    expect(view.days).toEqual([]);
    expect(view.hasHours).toBe(false);
    expect(view.hasDays).toBe(false);
    expect(view.weather.icon).toBe('unknown');
    expect(toForecastView(undefined).hours).toEqual([]);
  });

  it('nulls a removed field rather than substituting a plausible number', () => {
    const view = toForecastView({ ...payload, current: { ...CURRENT, wind_speed_10m: null } });
    expect(view.windSpeed).toBeNull();
    expect(view.temperature).toBe(26.8);
  });
});

describe('dailyBounds', () => {
  it('spans the union of every minimum and maximum', () => {
    expect(dailyBounds(toDailyRows(DAILY))).toEqual({ min: 14.6, max: 31.8 });
  });

  it('never returns a zero-width span, which would divide by zero in the range bars', () => {
    expect(dailyBounds([{ min: 12, max: 12 }])).toEqual({ min: 12, max: 13 });
    expect(dailyBounds([])).toEqual({ min: 0, max: 1 });
  });
});

describe('air quality', () => {
  const payload = {
    current: { time: '2026-08-09T20:00', european_aqi: 33, pm10: 12.3, pm2_5: 8.4, ozone: 83, nitrogen_dioxide: 11.6 },
    hourly: { time: ['2026-08-09T00:00', '2026-08-09T01:00'], european_aqi: [21, 24] },
  };

  it('reads the current readings and the hourly index', () => {
    const view = toAirQualityView(payload);
    expect(view).toMatchObject({ observedLabel: '20:00', europeanAqi: 33, pm10: 12.3, pm25: 8.4, ozone: 83, nitrogenDioxide: 11.6 });
    expect(view.hours).toEqual([
      { time: '2026-08-09T00:00', label: '00:00', aqi: 21 },
      { time: '2026-08-09T01:00', label: '01:00', aqi: 24 },
    ]);
  });

  it('drops hours whose index is missing instead of plotting a null', () => {
    const view = toAirQualityView({ ...payload, hourly: { time: payload.hourly.time, european_aqi: [21, null] } });
    expect(view.hours).toHaveLength(1);
  });

  it('is renderable when the whole body was replaced by a `respond` rule', () => {
    const view = toAirQualityView({ error: true, reason: 'nope' });
    expect(view.europeanAqi).toBeNull();
    expect(view.hours).toEqual([]);
  });

  it('bands the European AQI at the published boundaries', () => {
    expect(aqiBand(0).key).toBe('good');
    expect(aqiBand(20).key).toBe('good');
    expect(aqiBand(20.1).key).toBe('fair');
    expect(aqiBand(40).key).toBe('fair');
    expect(aqiBand(60).key).toBe('moderate');
    expect(aqiBand(80).key).toBe('poor');
    expect(aqiBand(100).key).toBe('very-poor');
    expect(aqiBand(101).key).toBe('extreme');
  });

  it('gives a missing index its own band rather than bucketing it as good', () => {
    expect(aqiBand(null)).toEqual({ key: 'unknown', label: 'No reading' });
    expect(aqiBand(undefined).key).toBe('unknown');
    expect(aqiBand(Number.NaN).key).toBe('unknown');
  });
});

describe('search results', () => {
  it('maps the fields the result list shows', () => {
    const results = toSearchResults({
      results: [
        { id: 5391811, name: 'San Diego', country: 'United States', admin1: 'California', latitude: 32.71571, longitude: -117.16472, population: 1404452, elevation: 20 },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 5391811, name: 'San Diego', latitude: 32.71571, longitude: -117.16472, population: 1404452 });
    expect(describePlace(results[0])).toBe('California, United States');
  });

  it('treats a missing `results` key exactly like an empty list', () => {
    // This is not hypothetical: Open-Meteo answers an unmatched search with `{"generationtime_ms":…}`
    // and no `results` key at all, and the committed recording contains that response.
    expect(toSearchResults({ generationtime_ms: 0.49 })).toEqual([]);
    expect(toSearchResults({ results: [] })).toEqual([]);
    expect(toSearchResults(undefined)).toEqual([]);
  });

  it('omits an absent region from the description without leaving a stray comma', () => {
    expect(describePlace({ admin1: null, country: 'Iceland' })).toBe('Iceland');
    expect(describePlace({ admin1: null, country: null })).toBe('');
  });
});
