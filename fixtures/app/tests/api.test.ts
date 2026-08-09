/**
 * URL construction and error mapping.
 *
 * The URL assertions are written out in full, byte for byte, rather than rebuilt from the same
 * helpers they test. That is deliberate and slightly tedious: `routeFromHAR` matches on the request
 * URL, so a change to a query parameter silently invalidates every entry in the committed
 * recording. Spelling the expected URL out means such a change fails here — where the message says
 * what happened — instead of surfacing later as fifteen unexplained HAR misses.
 */

import { describe, expect, it } from 'vitest';

import {
  AIR_QUALITY_ORIGIN,
  API_ORIGINS,
  ApiError,
  FORECAST_ORIGIN,
  GEOCODING_ORIGIN,
  airQualityUrl,
  fetchJson,
  forecastUrl,
  geocodeUrl,
} from '../src/api.js';

const BERLIN = { latitude: '52.52', longitude: '13.405' };

function jsonResponse(body: unknown, { status = 200, ok = status < 400 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('origins', () => {
  it('names the three Open-Meteo services the fixture uses', () => {
    expect(FORECAST_ORIGIN).toBe('https://api.open-meteo.com');
    expect(GEOCODING_ORIGIN).toBe('https://geocoding-api.open-meteo.com');
    expect(AIR_QUALITY_ORIGIN).toBe('https://air-quality-api.open-meteo.com');
    expect(API_ORIGINS).toEqual([FORECAST_ORIGIN, GEOCODING_ORIGIN, AIR_QUALITY_ORIGIN]);
  });
});

describe('forecastUrl', () => {
  it('builds the exact URL the recording contains', () => {
    expect(forecastUrl(BERLIN)).toBe(
      'https://api.open-meteo.com/v1/forecast' +
        '?latitude=52.52&longitude=13.405' +
        '&current=temperature_2m%2Capparent_temperature%2Crelative_humidity_2m%2Cprecipitation%2Cweather_code%2Cwind_speed_10m%2Cis_day' +
        '&hourly=temperature_2m%2Cprecipitation_probability%2Cweather_code' +
        '&daily=weather_code%2Ctemperature_2m_max%2Ctemperature_2m_min%2Cprecipitation_sum%2Csunrise%2Csunset' +
        '&timezone=UTC&forecast_days=7',
    );
  });

  it('matches the glob the spec’s example scenarios use', () => {
    expect(forecastUrl(BERLIN)).toContain('/v1/forecast');
    expect(airQualityUrl(BERLIN)).toContain('/v1/air-quality');
    expect(geocodeUrl('san')).toContain('/v1/search');
  });

  it('pins the timezone, so the chart’s x axis cannot depend on where it was recorded', () => {
    expect(forecastUrl(BERLIN)).toContain('timezone=UTC');
    expect(airQualityUrl(BERLIN)).toContain('timezone=UTC');
  });

  it('is stable under repeated calls, parameter order included', () => {
    expect(forecastUrl(BERLIN)).toBe(forecastUrl({ ...BERLIN }));
  });
});

describe('airQualityUrl', () => {
  it('builds the exact URL the recording contains', () => {
    expect(airQualityUrl(BERLIN)).toBe(
      'https://air-quality-api.open-meteo.com/v1/air-quality' +
        '?latitude=52.52&longitude=13.405' +
        '&current=european_aqi%2Cpm10%2Cpm2_5%2Cozone%2Cnitrogen_dioxide' +
        '&hourly=european_aqi%2Cpm10%2Cpm2_5' +
        '&timezone=UTC&forecast_days=1',
    );
  });
});

describe('geocodeUrl', () => {
  it('builds the exact URL the recording contains', () => {
    expect(geocodeUrl('san')).toBe('https://geocoding-api.open-meteo.com/v1/search?name=san&count=5&language=en&format=json');
  });

  it('encodes a query that needs it', () => {
    expect(geocodeUrl('são paulo')).toContain('name=s%C3%A3o+paulo');
  });
});

describe('coordinates', () => {
  it('accepts a number and stringifies it the way the app does', () => {
    expect(forecastUrl({ latitude: 32.71571, longitude: -117.16472 })).toContain('latitude=32.71571&longitude=-117.16472');
  });

  it('refuses a coordinate that could not round-trip into a stable URL', () => {
    expect(() => forecastUrl({ latitude: Number.NaN, longitude: 0 })).toThrow(
      'coordinate must be a finite number or a string, got null',
    );
    expect(() => forecastUrl({ latitude: undefined, longitude: 0 })).toThrow(
      'coordinate must be a finite number or a string, got undefined',
    );
  });
});

describe('fetchJson', () => {
  it('returns the parsed body on success', async () => {
    const body = await fetchJson('https://api.open-meteo.com/v1/forecast', {
      fetchImpl: async () => jsonResponse({ latitude: 52.52 }),
    });
    expect(body).toEqual({ latitude: 52.52 });
  });

  it('surfaces Open-Meteo’s own reason for a 400, verbatim', async () => {
    // The committed recording contains exactly this response, and the error screen prints it.
    const reason = 'Latitude must be in range of -90 to 90°. Given: 999.0.';
    await expect(
      fetchJson('https://api.open-meteo.com/v1/forecast?latitude=999', {
        fetchImpl: async () => jsonResponse({ error: true, reason }, { status: 400 }),
      }),
    ).rejects.toThrow(reason);
  });

  it('treats a 200 carrying `error: true` as a failure', async () => {
    await expect(
      fetchJson('https://api.open-meteo.com/v1/forecast', {
        fetchImpl: async () => jsonResponse({ error: true, reason: 'upstream said no' }),
      }),
    ).rejects.toThrow('upstream said no');
  });

  it('falls back to the status when the body carries no reason', async () => {
    await expect(
      fetchJson('https://api.open-meteo.com/v1/forecast', {
        fetchImpl: async () => jsonResponse({ error: true }, { status: 503 }),
      }),
    ).rejects.toThrow('Request failed with status 503.');
  });

  it('reports an aborted request as unreachable, which is what a HAR miss looks like to the page', async () => {
    // In a replayed run, a URL the recording does not contain is aborted at the route layer, so
    // `fetch` rejects. The screen has to say something a human can act on.
    const error = await fetchJson('https://api.open-meteo.com/v1/forecast', {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Could not reach the weather service.');
    expect(error.url).toBe('https://api.open-meteo.com/v1/forecast');
    expect(error.status).toBeNull();
  });

  it('reports a malformed success body distinctly from an unreachable service', async () => {
    await expect(
      fetchJson('https://api.open-meteo.com/v1/forecast', {
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token <');
            },
          }) as unknown as Response,
      }),
    ).rejects.toThrow('The weather service sent a malformed response.');
  });

  it('carries the status on the error so the screen can print "HTTP 400"', async () => {
    const error = await fetchJson('https://api.open-meteo.com/v1/forecast', {
      fetchImpl: async () => jsonResponse({ error: true, reason: 'nope' }, { status: 400 }),
    }).catch((thrown) => thrown);
    expect(error.status).toBe(400);
  });
});
