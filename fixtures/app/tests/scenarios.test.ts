/**
 * The committed scenario specs, checked with the repository's own parser and overlay engine.
 *
 * This is api-mocking spec §10.3 — "golden tests on the overlay engine: fixture HAR plus scenario
 * in, resulting responses out" — pointed at the files that actually ship. It is hermetic: no
 * browser, no dev server, no network. Everything comes from `.visual-diff/scenarios/*.yaml` and
 * `.visual-diff/flows/weather.har`.
 *
 * The assertion that matters most is the last one. A scenario is only useful if its glob matches
 * the URLs the app really builds, and a glob that matches nothing fails *silently at author time*:
 * the run succeeds, the screenshot looks plausible, and it is the recorded state rather than the
 * patched one. §8 calls that the tool actively misleading its user. So each rule is driven against
 * a URL produced by `src/api.js` — the same function the application calls — rather than against a
 * URL written out by hand here, which would only ever prove the glob matches itself.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadScenarioFile, parseScenarioFile } from '../../../src/scenario/index.js';
import { ScenarioEngine, matchesGlob } from '../../../src/mocking/index.js';
import { indexHar } from '../../../src/runner/har.js';
import type { ScenarioSpec } from '../../../src/types.js';

import { airQualityUrl, forecastUrl } from '../src/api.js';
import { LOCATIONS } from '../src/locations.js';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const SCENARIOS_DIR = join(APP_DIR, '.visual-diff', 'scenarios');
const HAR_PATH = join(APP_DIR, '.visual-diff', 'flows', 'weather.har');

const scenarioFiles = readdirSync(SCENARIOS_DIR)
  .filter((name) => name.endsWith('.yaml'))
  .sort();

const BERLIN = LOCATIONS.find((location) => location.slug === 'berlin');

describe('the scenarios directory', () => {
  it('holds the two scenarios the fixture demonstrates: one overlay, one mock', () => {
    expect(scenarioFiles).toEqual(['empty-forecast.yaml', 'mock-detail.yaml']);
  });
});

describe.each(scenarioFiles)('%s', (fileName) => {
  const path = join(SCENARIOS_DIR, fileName);
  const expectedName = basename(fileName, '.yaml');

  it('parses with no validation issues and no warnings', async () => {
    const result = await parseScenarioFile(path);
    // On the issue *text*, not on a boolean: the message names file, line and offending key, which
    // is the difference between a two-minute fix and reading YAML by eye.
    const issues = result.ok ? [] : result.issues.map((issue) => `${issue.code}: ${issue.message}`);
    expect(issues).toEqual([]);
    expect(result.ok).toBe(true);

    const warnings = result.ok ? result.warnings.map((w) => `${w.code}: ${w.message}`) : [];
    expect(warnings).toEqual([]);
  });

  it('is named after its file, which is what --scenario resolves by', async () => {
    const spec = await loadScenarioFile(path);
    expect(spec.scenario).toBe(expectedName);
  });

  it('gives every rule a stable, unique id — the report attributes by id', async () => {
    const spec = await loadScenarioFile(path);
    const ids = spec.rules.map((rule) => rule.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size, `duplicate rule id in ${fileName}`).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  /**
   * The check this file exists for. Every rule must match at least one URL the application really
   * builds — otherwise the scenario is a no-op that looks like it worked.
   */
  it('has no rule whose glob matches nothing the app ever requests', async () => {
    const spec = await loadScenarioFile(path);
    expect(BERLIN).toBeDefined();
    const urls = [forecastUrl(BERLIN!), airQualityUrl(BERLIN!)];

    for (const rule of spec.rules) {
      const matched = urls.some((url) => matchesGlob(rule.match.url, url));
      expect(matched, `rule '${rule.id}' glob ${rule.match.url} matched none of: ${urls.join(', ')}`).toBe(
        true,
      );
    }
  });
});

/* ------------------------------------------------------------------ golden overlay (§10.3) */

async function load(name: string): Promise<ScenarioSpec> {
  return loadScenarioFile(join(SCENARIOS_DIR, `${name}.yaml`));
}

describe('empty-forecast, applied to the committed recording', () => {
  it('empties the hourly series and leaves everything else exactly as recorded', async () => {
    const spec = await load('empty-forecast');
    const har = indexHar(readFileSync(HAR_PATH, 'utf8'));
    const engine = new ScenarioEngine(spec);

    const url = forecastUrl(BERLIN!);
    const request = { method: 'GET', url };
    const recorded = har.find('GET', url);
    expect(recorded, `the recording has no entry for ${url}`).toBeDefined();

    const before = JSON.parse(recorded!.text) as {
      hourly: { temperature_2m: number[]; time: string[] };
      current: { temperature_2m: number };
    };
    // The premise: the recorded payload is a real one with a real series in it.
    expect(before.hourly.temperature_2m.length).toBeGreaterThan(24);

    const decision = engine.handle(request, recorded);
    expect(decision.attribution.ruleId).toBe('forecast-empty');
    expect(decision.attribution.action).toBe('patch');
    expect(decision.attribution.bodyChanged).toBe(true);
    expect(decision.action.kind).toBe('fulfill');

    const served = decision.action.kind === 'fulfill' ? decision.action.response : null;
    const after = JSON.parse(String(served?.body)) as typeof before;

    expect(after.hourly.temperature_2m).toEqual([]);
    // A merge patch replaces the named key and nothing else: the timestamps and the current
    // conditions are still the recorded ones, which is the whole of D10 — a screen patched from a
    // real payload rather than invented wholesale.
    expect(after.hourly.time).toEqual(before.hourly.time);
    expect(after.current.temperature_2m).toBe(before.current.temperature_2m);
  });

  it('leaves the air-quality request alone, so only the rule’s own endpoint changes', async () => {
    const spec = await load('empty-forecast');
    const engine = new ScenarioEngine(spec);
    const url = airQualityUrl(BERLIN!);

    const decision = engine.handle({ method: 'GET', url }, undefined);
    expect(decision.attribution.ruleId).toBeNull();
    expect(decision.attribution.action).toBe('passthrough');
    expect(decision.attribution.bodyChanged).toBe(false);
  });
});

describe('mock-detail, which has no recording behind it at all', () => {
  it('answers both endpoints from the scenario alone', async () => {
    const spec = await load('mock-detail');
    expect(spec.mode).toBe('mock');
    const engine = new ScenarioEngine(spec);

    for (const [ruleId, url] of [
      ['forecast', forecastUrl(BERLIN!)],
      ['air-quality', airQualityUrl(BERLIN!)],
    ] as const) {
      // `undefined` recorded response: there is no HAR in this mode, by design.
      const decision = engine.handle({ method: 'GET', url }, undefined);
      expect(decision.attribution.ruleId).toBe(ruleId);
      expect(decision.attribution.action).toBe('respond');
      expect(decision.action.kind).toBe('fulfill');
      if (decision.action.kind === 'fulfill') {
        expect(decision.action.response.status).toBe(200);
        expect(JSON.parse(String(decision.action.response.body))).toBeTypeOf('object');
      }
    }
  });

  /*
   * The screens the mock feeds are built by `toForecastView`, which needs `current`, `hourly` and
   * `daily`. A mock body missing one of them renders a skeleton or an empty state forever, and the
   * flow's `waitFor` fails with a timeout that says nothing about why.
   */
  it('invents a body with every block the detail screen reads', async () => {
    const spec = await load('mock-detail');
    const engine = new ScenarioEngine(spec);
    const decision = engine.handle({ method: 'GET', url: forecastUrl(BERLIN!) }, undefined);

    expect(decision.action.kind).toBe('fulfill');
    if (decision.action.kind !== 'fulfill') return;
    const body = JSON.parse(String(decision.action.response.body)) as Record<string, any>;

    expect(Object.keys(body.current)).toEqual(
      expect.arrayContaining(['time', 'temperature_2m', 'weather_code']),
    );
    expect(body.hourly.time.length).toBe(body.hourly.temperature_2m.length);
    expect(body.hourly.time.length).toBeGreaterThanOrEqual(48);
    expect(body.daily.time.length).toBe(7);
    expect(body.daily.temperature_2m_max.length).toBe(7);
  });
});
