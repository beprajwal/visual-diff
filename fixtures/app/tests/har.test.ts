/**
 * The committed recording.
 *
 * `.visual-diff/flows/weather.har` is a build artifact of a network call that must never happen
 * again in CI, which makes it the one file here nothing else can regenerate or check. Everything
 * that could go wrong with it is silent:
 *
 *   - a URL that drifts from the one the app requests replays as a HAR miss, not an error;
 *   - a missing CORS header makes the browser block a response that looks perfectly fine on disk;
 *   - a stale `content-encoding` hands the browser a body it cannot decode;
 *   - a credential recorded by accident is committed forever.
 *
 * So each of those is asserted directly, and the scrub list is cross-checked against the runner's
 * own `DEFAULTS.alwaysRedactHeaders` rather than restated — a fixture that scrubs less than the
 * tool does is a fixture that teaches the wrong lesson.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULTS } from '../../../src/types.js';
import { ALWAYS_REDACT_HEADERS, scrub, toHarEntry } from '../scripts/record-har.mjs';
import { API_ORIGINS } from '../src/api.js';
import { LOCATIONS, OUT_OF_RANGE_POINT, RECORDED_SEARCHES, RECORDED_SEARCH_DESTINATIONS } from '../src/locations.js';
import { recordingPlan } from '../src/recording.js';

const HAR_PATH = fileURLToPath(new URL('../.visual-diff/flows/weather.har', import.meta.url));

interface HarEntry {
  request: { method: string; url: string; headers: { name: string; value: string }[] };
  response: {
    status: number;
    headers: { name: string; value: string }[];
    content: { mimeType: string; text: string; size: number };
  };
}

const har = JSON.parse(readFileSync(HAR_PATH, 'utf8')) as { log: { version: string; entries: HarEntry[]; comment: string } };
const entries = har.log.entries;

function headerValue(headers: { name: string; value: string }[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

function bodyOf(url: string): unknown {
  const entry = entries.find((candidate) => candidate.request.url === url);
  if (entry === undefined) throw new Error(`the recording has no entry for ${url}`);
  return JSON.parse(entry.response.content.text);
}

describe('the recording as a HAR', () => {
  it('is HAR 1.2 with entries', () => {
    expect(har.log.version).toBe('1.2');
    expect(entries.length).toBeGreaterThan(0);
  });

  it('credits the data source and its licence, so the provenance travels with the file', () => {
    expect(har.log.comment).toContain('Open-Meteo');
    expect(har.log.comment).toContain('CC-BY-4.0');
  });
});

describe('coverage', () => {
  it('contains exactly the requests the app makes — no more, no fewer', () => {
    // Both sides are derived from `api.js`, so this fails the moment a query parameter changes on
    // one side only. That is the drift that turns a working fixture into fifteen HAR misses.
    const recorded = entries.map((entry) => entry.request.url).sort();
    const planned = recordingPlan()
      .map((item) => item.url)
      .sort();
    expect(recorded).toEqual(planned);
  });

  it('covers all three endpoints the spec’s example scenarios target', () => {
    const paths = new Set(entries.map((entry) => new URL(entry.request.url).pathname));
    expect(paths).toContain('/v1/forecast');
    expect(paths).toContain('/v1/search');
    expect(paths).toContain('/v1/air-quality');
  });

  it('covers every saved location on both the forecast and air-quality endpoints', () => {
    for (const location of LOCATIONS) {
      const forLocation = entries.filter((entry) => {
        const params = new URL(entry.request.url).searchParams;
        return params.get('latitude') === location.latitude && params.get('longitude') === location.longitude;
      });
      expect(forLocation, `entries for ${location.name}`).toHaveLength(2);
    }
  });

  it('covers each recorded search term', () => {
    const searched = entries
      .filter((entry) => new URL(entry.request.url).pathname === '/v1/search')
      .map((entry) => new URL(entry.request.url).searchParams.get('name'));
    expect(searched.sort()).toEqual([...RECORDED_SEARCHES].sort());
  });

  it('only ever talks to Open-Meteo', () => {
    for (const entry of entries) {
      expect(API_ORIGINS).toContain(new URL(entry.request.url).origin);
      expect(entry.request.method).toBe('GET');
    }
  });
});

describe('the responses', () => {
  it('are all JSON that parses', () => {
    for (const entry of entries) {
      expect(entry.response.content.mimeType, entry.request.url).toContain('application/json');
      expect(() => JSON.parse(entry.response.content.text)).not.toThrow();
      expect(entry.response.content.size).toBe(Buffer.byteLength(entry.response.content.text, 'utf8'));
    }
  });

  it('carry a wildcard CORS header, without which the browser blocks every replayed response', () => {
    for (const entry of entries) {
      expect(headerValue(entry.response.headers, 'access-control-allow-origin'), entry.request.url).toBe('*');
    }
  });

  it('carry no transfer headers, which would misdescribe the decoded body stored beside them', () => {
    for (const entry of entries) {
      for (const header of ['content-encoding', 'content-length', 'transfer-encoding']) {
        expect(headerValue(entry.response.headers, header), `${header} on ${entry.request.url}`).toBeUndefined();
      }
    }
  });

  it('are the successes and the failures the fixture’s screens need', () => {
    const statuses = entries.map((entry) => entry.response.status);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(13);
    expect(statuses.filter((status) => status === 400)).toHaveLength(2);
    expect(new Set(statuses)).toEqual(new Set([200, 400]));
  });
});

describe('the payloads the screens depend on', () => {
  it('gives every saved location a full hourly and daily series', () => {
    for (const location of LOCATIONS) {
      const payload = bodyOf(
        entries.find((entry) => {
          const params = new URL(entry.request.url).searchParams;
          return (
            new URL(entry.request.url).pathname === '/v1/forecast' &&
            params.get('latitude') === location.latitude
          );
        })!.request.url,
      ) as { hourly: { time: string[]; temperature_2m: number[] }; daily: { time: string[] }; current: { time: string } };

      expect(payload.hourly.time.length, location.name).toBeGreaterThanOrEqual(48);
      expect(payload.hourly.temperature_2m.length).toBe(payload.hourly.time.length);
      expect(payload.daily.time).toHaveLength(7);
      expect(payload.current.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    }
  });

  it('answers the unmatched search with no `results` key at all — the genuine empty state', () => {
    const empty = bodyOf('https://geocoding-api.open-meteo.com/v1/search?name=zzzzzzzz&count=5&language=en&format=json');
    expect(Object.hasOwn(empty as object, 'results')).toBe(false);
  });

  it('answers the populated search with five results', () => {
    const populated = bodyOf('https://geocoding-api.open-meteo.com/v1/search?name=san&count=5&language=en&format=json') as {
      results: { id: number; name: string; latitude: number; longitude: number }[];
    };
    expect(populated.results).toHaveLength(5);
    expect(populated.results[0].name).toBe('San Diego');
    expect(populated.results[0].id).toBe(5391811);
  });

  it('recorded a forecast for the point the first search result links to', () => {
    // The link the app renders is built from `String(result.latitude)`, so the transcribed
    // coordinates in `locations.js` have to still match the payload — otherwise search → pick →
    // forecast quietly becomes a HAR miss.
    const populated = bodyOf('https://geocoding-api.open-meteo.com/v1/search?name=san&count=5&language=en&format=json') as {
      results: { latitude: number; longitude: number }[];
    };
    const destination = RECORDED_SEARCH_DESTINATIONS[0];
    expect(String(populated.results[0].latitude)).toBe(destination.latitude);
    expect(String(populated.results[0].longitude)).toBe(destination.longitude);

    const recorded = entries.map((entry) => new URL(entry.request.url).searchParams.get('latitude'));
    expect(recorded).toContain(destination.latitude);
  });

  it('records the API’s own refusal, reason text and all, for the error state', () => {
    for (const endpoint of ['https://api.open-meteo.com/v1/forecast', 'https://air-quality-api.open-meteo.com/v1/air-quality']) {
      const entry = entries.find(
        (candidate) =>
          candidate.request.url.startsWith(endpoint) &&
          new URL(candidate.request.url).searchParams.get('latitude') === OUT_OF_RANGE_POINT.latitude,
      );
      expect(entry, endpoint).toBeDefined();
      expect(entry!.response.status).toBe(400);
      const body = JSON.parse(entry!.response.content.text) as { error: boolean; reason: string };
      expect(body.error).toBe(true);
      expect(body.reason).toBe('Latitude must be in range of -90 to 90°. Given: 999.0.');
    }
  });
});

describe('scrubbing', () => {
  it('scrubs exactly what the runner scrubs', () => {
    expect([...ALWAYS_REDACT_HEADERS].sort()).toEqual([...DEFAULTS.alwaysRedactHeaders].sort());
  });

  it('committed no credential header on either side of any entry', () => {
    for (const entry of entries) {
      for (const name of DEFAULTS.alwaysRedactHeaders) {
        expect(headerValue(entry.request.headers, name), `request ${name}`).toBeUndefined();
        expect(headerValue(entry.response.headers, name), `response ${name}`).toBeUndefined();
      }
    }
  });

  it('carries no redacted header anywhere in the file, at any nesting depth', () => {
    // Deliberately not a substring scan of the raw text: Open-Meteo advertises
    // `access-control-allow-headers: accept, authorization, …`, which is a statement about what the
    // API would accept, not a credential. Grepping for the word would fail on that forever. What
    // matters is whether any name/value pair is *named* one of the redacted headers, so the whole
    // parsed structure is walked instead.
    const found: string[] = [];
    const redacted = new Set(DEFAULTS.alwaysRedactHeaders.map((name) => name.toLowerCase()));

    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const record = node as { name?: unknown; value?: unknown };
      if (typeof record.name === 'string' && redacted.has(record.name.toLowerCase())) {
        found.push(`${record.name}: ${String(record.value)}`);
      }
      for (const value of Object.values(node)) walk(value);
    };

    walk(har);
    expect(found).toEqual([]);
  });

  it('removes credential headers when they are present', () => {
    // The live API sends none of these, so the scrub is exercised against a synthetic entry — a
    // scrub that is only ever run over clean input has never actually been tested.
    const dirty = {
      log: {
        entries: [
          {
            request: {
              headers: [
                { name: 'authorization', value: 'Bearer secret' },
                { name: 'accept', value: 'application/json' },
              ],
              cookies: [{ name: 'Cookie', value: 'session=1' }],
            },
            response: {
              headers: [
                { name: 'Set-Cookie', value: 'session=1' },
                { name: 'content-type', value: 'application/json' },
              ],
              cookies: [],
            },
          },
        ],
      },
    };

    expect(scrub(dirty)).toBe(3);
    expect(dirty.log.entries[0].request.headers).toEqual([{ name: 'accept', value: 'application/json' }]);
    expect(dirty.log.entries[0].request.cookies).toEqual([]);
    expect(dirty.log.entries[0].response.headers).toEqual([{ name: 'content-type', value: 'application/json' }]);
  });
});

describe('toHarEntry', () => {
  it('drops transfer headers and stores the decoded body with a matching size', () => {
    const entry = toHarEntry({
      url: 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.405',
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': '999',
        'access-control-allow-origin': '*',
      }),
      body: '{"ok":true}',
      startedDateTime: '2026-08-09T20:00:00.000Z',
      timeMs: 12,
    }) as HarEntry;

    expect(headerValue(entry.response.headers, 'content-encoding')).toBeUndefined();
    expect(headerValue(entry.response.headers, 'content-length')).toBeUndefined();
    expect(headerValue(entry.response.headers, 'access-control-allow-origin')).toBe('*');
    expect(entry.response.content.text).toBe('{"ok":true}');
    expect(entry.response.content.size).toBe(11);
    expect(entry.request.method).toBe('GET');
  });
});
