/**
 * Golden tests for the overlay engine (mocking spec §10.3): "fixture HAR plus scenario in,
 * resulting responses out". Hermetic — no browser, no network, no clock.
 *
 * Each case drives a whole run: a scenario, an ordered list of requests a flow would make, and the
 * exact responses the page ends up receiving, with the attribution `network.json` would carry.
 * Running the requests in order is the point — `nth`, first-match-wins and the never-matched
 * warning are all run-scoped, and a per-request assertion would miss every one of them.
 */

import { describe, expect, it } from 'vitest';

import type { ScenarioMode, ScenarioRule, ScenarioSpec } from '../types.js';
import { ScenarioEngine } from './engine.js';
import type { MockRequest } from './match.js';
import {
  AIR_QUALITY_BODY,
  AIR_QUALITY_URL,
  ANALYTICS_URL,
  CHART_URL,
  FORECAST_BODY,
  FORECAST_URL,
  PLAIN_URL,
  PNG_BASE64,
  SEARCH_BODY,
  SEARCH_URL,
  recordingLookup,
} from './testkit.js';

interface Served {
  request: string;
  action: string;
  status: number | null;
  body: unknown;
  attribution: { ruleId: string | null; action: string; bodyChanged: boolean };
  delayMs: number;
}

/** Replay a list of requests through a scenario, exactly as the runner would. */
function run(spec: ScenarioSpec, requests: MockRequest[]): { served: Served[]; engine: ScenarioEngine } {
  const engine = new ScenarioEngine(spec);
  const find = recordingLookup();
  const served: Served[] = [];

  for (const request of requests) {
    const selected = engine.select(request);
    const recorded = find(request.method, request.url, selected?.occurrence ?? 1);
    const decision = engine.resolve(
      request,
      selected,
      engine.needsRecordedResponse(selected) ? recorded : undefined,
    );

    const { action, attribution } = decision;
    const passthrough = action.kind === 'passthrough';
    const body =
      action.kind === 'fulfill'
        ? decodeBody(action.response.body, action.response.encoding)
        : passthrough
          ? decodeBody(recorded?.text, undefined)
          : null;

    served.push({
      request: `${request.method} ${request.url}`,
      action: action.kind,
      status: action.kind === 'fulfill' ? action.response.status : passthrough ? (recorded?.status ?? null) : null,
      body,
      attribution: {
        ruleId: attribution.ruleId,
        action: attribution.action,
        bodyChanged: attribution.bodyChanged,
      },
      delayMs: action.delayMs,
    });
  }

  return { served, engine };
}

function decodeBody(body: string | undefined, encoding: 'base64' | undefined): unknown {
  if (body === undefined) return null;
  if (encoding === 'base64') return { base64: body };
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function scenario(name: string, rules: ScenarioRule[], mode: ScenarioMode = 'overlay'): ScenarioSpec {
  return { version: 1, scenario: name, mode, rules };
}

const forecast: MockRequest = { method: 'GET', url: FORECAST_URL };
const search: MockRequest = { method: 'GET', url: SEARCH_URL };
const airQuality: MockRequest = { method: 'GET', url: AIR_QUALITY_URL };
const analytics: MockRequest = { method: 'POST', url: ANALYTICS_URL };
const chart: MockRequest = { method: 'GET', url: CHART_URL };

const { current_weather: _currentWeather, ...withoutCurrentWeather } = FORECAST_BODY;

describe('golden: the empty-forecast scenario from the spec', () => {
  const spec = scenario('empty-forecast', [
    {
      id: 'forecast-empty',
      match: { method: 'GET', url: '**/v1/forecast**' },
      patch: { hourly: { temperature_2m: [] }, current_weather: null },
    },
    {
      id: 'geocode-fails',
      match: { method: 'GET', url: '**/v1/search**' },
      respond: {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: { error: 'upstream_unavailable' },
      },
    },
    { id: 'slow-air-quality', match: { url: '**/v1/air-quality**' }, delay: 3000 },
    { id: 'no-analytics', match: { url: '**/analytics/**' }, abort: true },
  ]);

  it('produces one response per request, with attribution', () => {
    const { served, engine } = run(spec, [forecast, search, airQuality, analytics, chart]);

    expect(served).toEqual([
      {
        request: `GET ${FORECAST_URL}`,
        action: 'fulfill',
        status: 200,
        // `current_weather: null` in the patch deletes the key outright (RFC 7386), so the expected
        // body is built without it rather than with it set to undefined.
        body: {
          ...withoutCurrentWeather,
          hourly: { time: FORECAST_BODY.hourly.time, temperature_2m: [] },
        },
        attribution: { ruleId: 'forecast-empty', action: 'patch', bodyChanged: true },
        delayMs: 0,
      },
      {
        request: `GET ${SEARCH_URL}`,
        action: 'fulfill',
        status: 500,
        body: { error: 'upstream_unavailable' },
        attribution: { ruleId: 'geocode-fails', action: 'respond', bodyChanged: true },
        delayMs: 0,
      },
      {
        request: `GET ${AIR_QUALITY_URL}`,
        action: 'passthrough',
        status: 200,
        body: AIR_QUALITY_BODY,
        attribution: { ruleId: 'slow-air-quality', action: 'delay', bodyChanged: false },
        delayMs: 3000,
      },
      {
        request: `POST ${ANALYTICS_URL}`,
        action: 'abort',
        status: null,
        body: null,
        attribution: { ruleId: 'no-analytics', action: 'abort', bodyChanged: false },
        delayMs: 0,
      },
      {
        request: `GET ${CHART_URL}`,
        action: 'passthrough',
        status: 200,
        body: Buffer.from(PNG_BASE64, 'base64').toString('utf8'),
        attribution: { ruleId: null, action: 'passthrough', bodyChanged: false },
        delayMs: 0,
      },
    ]);

    expect(engine.warnings()).toEqual([]);
  });

  it('deletes the key merge patch was told to delete, and keeps everything else', () => {
    const { served } = run(spec, [forecast]);
    const body = served[0]?.body as Record<string, unknown>;
    expect('current_weather' in body).toBe(false);
    expect(body.daily).toEqual(FORECAST_BODY.daily);
    expect(body.hourly).toEqual({ time: FORECAST_BODY.hourly.time, temperature_2m: [] });
  });

  it('is deterministic: the same requests twice produce identical responses (§10.1)', () => {
    const first = run(spec, [forecast, search, airQuality, analytics]).served;
    const second = run(spec, [forecast, search, airQuality, analytics]).served;
    expect(second).toEqual(first);
  });
});

describe('golden: patchOps against the recorded arrays', () => {
  const spec = scenario('first-day-removed', [
    {
      id: 'first-day-removed',
      match: { url: '**/v1/forecast**' },
      patchOps: [
        { op: 'remove', path: '/daily/time/0' },
        { op: 'replace', path: '/daily/weather_code/0', value: 95 },
        { op: 'add', path: '/hourly/temperature_2m/-', value: 16.1 },
        { op: 'replace', path: '/hourly/temperature_2m/2', value: null },
      ],
    },
  ]);

  it('rewrites exactly the addressed elements', () => {
    const { served } = run(spec, [forecast]);
    expect(served[0]?.body).toEqual({
      ...FORECAST_BODY,
      hourly: {
        time: FORECAST_BODY.hourly.time,
        temperature_2m: [17.4, 17.1, null, 16.6, 16.1],
      },
      daily: {
        time: ['2026-08-11', '2026-08-12'],
        weather_code: [95, 61, 0],
        temperature_2m_max: FORECAST_BODY.daily.temperature_2m_max,
      },
    });
    expect(served[0]?.attribution).toEqual({
      ruleId: 'first-day-removed',
      action: 'patchOps',
      bodyChanged: true,
    });
  });
});

describe('golden: nth picks one occurrence of an otherwise identical request', () => {
  const spec = scenario('second-fetch-fails', [
    {
      id: 'refetch-500',
      match: { method: 'GET', url: '**/v1/forecast**', nth: 2 },
      respond: { status: 503, body: { error: 'retry_later' } },
    },
    { id: 'units-note', match: { url: '**/v1/search**' }, patch: { generationtime_ms: 0 } },
  ]);

  it('leaves the first fetch alone and replaces the second', () => {
    const { served, engine } = run(spec, [forecast, search, forecast, forecast]);

    expect(served.map((entry) => entry.attribution)).toEqual([
      { ruleId: null, action: 'passthrough', bodyChanged: false },
      { ruleId: 'units-note', action: 'patch', bodyChanged: true },
      { ruleId: 'refetch-500', action: 'respond', bodyChanged: true },
      { ruleId: null, action: 'passthrough', bodyChanged: false },
    ]);
    expect(served[0]?.body).toEqual(FORECAST_BODY);
    expect(served[1]?.body).toEqual({ ...SEARCH_BODY, generationtime_ms: 0 });
    expect(served[2]?.body).toEqual({ error: 'retry_later' });
    expect(engine.warnings()).toEqual([]);
  });
});

describe('golden: first match wins in file order', () => {
  it('shadows a later rule that would also have matched', () => {
    const spec = scenario('shadowed', [
      { id: 'catch-all', match: { url: '**' }, abort: true },
      { id: 'never-reached', match: { url: '**/v1/forecast**' }, respond: { status: 500 } },
    ]);
    const { served, engine } = run(spec, [forecast, search]);

    expect(served.map((entry) => entry.attribution.ruleId)).toEqual(['catch-all', 'catch-all']);
    expect(engine.unmatchedRuleIds()).toEqual(['never-reached']);
    expect(engine.unmatchedRulesWarning()?.message).toContain(
      "rule 'never-reached' never matched a request during this run",
    );
  });
});

describe('golden: a mistyped glob is warned about, never silently ignored (§8)', () => {
  it('serves the recording unchanged and says so', () => {
    const spec = scenario('empty-forecast', [
      // `forcast` is the typo the warning exists for.
      { id: 'forecast-empty', match: { url: '**/v1/forcast**' }, patch: { hourly: null } },
    ]);
    const { served, engine } = run(spec, [forecast]);

    expect(served[0]?.body).toEqual(FORECAST_BODY);
    expect(served[0]?.attribution).toEqual({
      ruleId: null,
      action: 'passthrough',
      bodyChanged: false,
    });
    expect(engine.warnings()).toEqual([
      {
        kind: 'scenario-rule-unmatched',
        message:
          "scenario 'empty-forecast': rule 'forecast-empty' never matched a request during this " +
          'run — those requests were served from the recording unchanged, so the screens you are ' +
          'looking at are the recorded state, not the patched one. Check the url glob.',
        rules: ['forecast-empty'],
      },
    ]);
  });
});

describe('golden: mock mode with no recording at all (D13)', () => {
  const spec = scenario(
    'offline-dashboard',
    [
      {
        id: 'forecast',
        match: { url: '**/v1/forecast**' },
        respond: { status: 200, body: { hourly: { time: [], temperature_2m: [] } } },
      },
      { id: 'chart-asset', match: { url: '**/sparkline.png' }, respond: { status: 200, body: { base64: PNG_BASE64 } } },
      { id: 'slow-search', match: { url: '**/v1/search**' }, delay: 250, respond: { status: 200, body: { results: [] } } },
    ],
    'mock',
  );

  it('serves what the rules describe and reports everything else as a miss', () => {
    const { served, engine } = run(spec, [forecast, chart, search, airQuality, analytics]);

    expect(served).toEqual([
      {
        request: `GET ${FORECAST_URL}`,
        action: 'fulfill',
        status: 200,
        body: { hourly: { time: [], temperature_2m: [] } },
        attribution: { ruleId: 'forecast', action: 'respond', bodyChanged: true },
        delayMs: 0,
      },
      {
        request: `GET ${CHART_URL}`,
        action: 'fulfill',
        status: 200,
        body: { base64: PNG_BASE64 },
        attribution: { ruleId: 'chart-asset', action: 'respond', bodyChanged: true },
        delayMs: 0,
      },
      {
        request: `GET ${SEARCH_URL}`,
        action: 'fulfill',
        status: 200,
        body: { results: [] },
        attribution: { ruleId: 'slow-search', action: 'respond', bodyChanged: true },
        delayMs: 250,
      },
      {
        request: `GET ${AIR_QUALITY_URL}`,
        action: 'abort',
        status: null,
        body: null,
        attribution: { ruleId: null, action: 'miss', bodyChanged: false },
        delayMs: 0,
      },
      {
        request: `POST ${ANALYTICS_URL}`,
        action: 'abort',
        status: null,
        body: null,
        attribution: { ruleId: null, action: 'miss', bodyChanged: false },
        delayMs: 0,
      },
    ]);

    expect(engine.warnings()).toEqual([
      {
        kind: 'mock-miss',
        message:
          "scenario 'offline-dashboard' (mock mode): 2 requests across 2 urls matched no rule and " +
          'were aborted — a mock-mode run serves only what its rules serve',
        urls: [`GET ${AIR_QUALITY_URL}`, `POST ${ANALYTICS_URL}`],
      },
    ]);
  });

  it('never consults the recording, even where one exists', () => {
    const { served } = run(spec, [forecast]);
    expect(served[0]?.body).not.toEqual(FORECAST_BODY);
  });
});

describe('golden: patching a non-JSON recording fails the run naming the rule (§8)', () => {
  it('refuses an image', () => {
    const spec = scenario('broken', [
      { id: 'patch-the-chart', match: { url: '**/sparkline.png' }, patch: { a: 1 } },
    ]);
    expect(() => run(spec, [chart])).toThrow(
      `scenario 'broken' rule 'patch-the-chart' cannot apply patch to GET ${CHART_URL}: the ` +
        "recorded response declares 'image/png', and patch/patchOps are only valid against JSON " +
        'content types',
    );
  });

  it('refuses a text/plain body even when it happens to parse as JSON', () => {
    const spec = scenario('broken', [
      { id: 'patch-the-notes', match: { url: '**/notes.txt' }, patch: { a: 1 } },
    ]);
    expect(() => run(spec, [{ method: 'GET', url: PLAIN_URL }])).toThrow(
      /the recorded response declares 'text\/plain'/,
    );
  });

  it('refuses a request the recording has no response for, naming rule and url', () => {
    const spec = scenario('broken', [
      { id: 'patch-the-missing', match: { url: '**/v1/marine**' }, patch: { a: 1 } },
    ]);
    expect(() => run(spec, [{ method: 'GET', url: 'https://api.open-meteo.com/v1/marine' }])).toThrow(
      "scenario 'broken' rule 'patch-the-missing' matched GET https://api.open-meteo.com/v1/marine, " +
        'but the recording has no response for it, so there is nothing for patch to patch',
    );
  });
});
