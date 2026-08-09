/**
 * The committed flow specs, checked with the repository's own parser.
 *
 * `loadFlowFile` is the exact code path `vdiff flow check` and `vdiff run` take, so this is the CLI
 * validating these files, not a re-implementation agreeing with itself. That matters because the
 * flow spec is the fixture's contract with the runner: a flow that stops parsing takes every
 * integration test built on it down with it, and the failure surfaces as "run failed" rather than
 * as "the YAML is wrong".
 *
 * Beyond parsing, the assertions pin the properties the api-mocking spec's scenarios rely on: the
 * flows replay (never record), they all share the one committed recording, step ids are stable and
 * unique, and every endpoint the example scenarios target is actually exercised somewhere.
 */

import { readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadFlowFile, parseFlowFile } from '../../../src/flow/index.js';
import { STEP_VERBS } from '../../../src/types.js';

const FLOWS_DIR = fileURLToPath(new URL('../.visual-diff/flows/', import.meta.url));

const flowFiles = readdirSync(FLOWS_DIR)
  .filter((name) => name.endsWith('.yaml'))
  .sort();

describe('the flows directory', () => {
  it('holds a flow for each screen family the spec asks the fixture to make diffable', () => {
    expect(flowFiles).toEqual([
      'detail-mock.yaml',
      'detail.yaml',
      'forecast.yaml',
      'locations.yaml',
      'search.yaml',
      'states.yaml',
    ]);
  });

  it('sits beside the one recording they all replay', () => {
    expect(existsSync(join(FLOWS_DIR, 'weather.har'))).toBe(true);
  });
});

describe.each(flowFiles)('%s', (fileName) => {
  const path = join(FLOWS_DIR, fileName);
  const expectedName = basename(fileName, '.yaml');

  it('parses with no validation issues and no warnings', async () => {
    const result = await parseFlowFile(path);
    // Asserting on the issue *text* rather than on a boolean: when this fails the message names the
    // offending key, which is the difference between a two-minute fix and a bisect.
    const issues = result.ok ? [] : result.issues.map((issue) => `${issue.code}: ${issue.message}`);
    expect(issues).toEqual([]);
    expect(result.ok).toBe(true);

    const warnings = result.ok ? result.warnings.map((issue) => `${issue.code}: ${issue.message}`) : [];
    expect(warnings).toEqual([]);
  });

  it('is named after its file, which is what the CLI resolves a flow by', async () => {
    const flow = await loadFlowFile(path);
    expect(flow.flow).toBe(expectedName);
  });

  /*
   * Every flow either replays the one committed recording or is explicitly a `mock` flow with no
   * recording at all (api-mocking D13). What none of them may be is `record` — which would reach
   * the live API from a test run — or `off`, which would leave the screens blank and make the
   * whole fixture prove nothing.
   */
  it('replays the committed recording, or is an explicit mock flow with none', async () => {
    const flow = await loadFlowFile(path);
    if (flow.network.mode === 'mock') {
      expect(flow.network.har).toBeUndefined();
      return;
    }
    expect(flow.network.mode).toBe('replay');
    expect(flow.network.har).toBe('weather.har');
  });

  it('captures both viewports', async () => {
    const flow = await loadFlowFile(path);
    expect(flow.viewports).toEqual(['1280x800', '390x844']);
  });

  it('has unique, stable-looking step ids and shoots at least one of them', async () => {
    const flow = await loadFlowFile(path);
    const ids = flow.steps.map((step) => step.id);
    expect(new Set(ids).size, `duplicate step id in ${fileName}`).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(flow.steps.some((step) => step.shoot)).toBe(true);
  });

  it('uses only the closed step vocabulary', async () => {
    const flow = await loadFlowFile(path);
    const allowed = new Set<string>(['id', 'shoot', ...STEP_VERBS]);
    for (const step of flow.steps) {
      for (const key of Object.keys(step)) {
        expect(allowed, `${fileName} step '${step.id}' uses '${key}'`).toContain(key);
      }
    }
  });

  it('waits for something concrete on every step that shoots', async () => {
    // A shot taken without a `waitFor` races whatever the previous step started. The settle gate
    // catches most of it, but "most" is not what a determinism guarantee needs.
    const flow = await loadFlowFile(path);
    for (const step of flow.steps) {
      if (!step.shoot) continue;
      expect(step.waitFor, `${fileName} step '${step.id}' shoots without waiting`).toBeTruthy();
    }
  });
});

describe('the flows as a set', () => {
  it('exercises all three endpoints the example scenarios target', async () => {
    // Not read out of the YAML — read out of what the flows actually reach. The list flow renders
    // forecasts, the detail flow adds air quality, the search flow adds geocoding.
    const forecast = await loadFlowFile(join(FLOWS_DIR, 'forecast.yaml'));
    const search = await loadFlowFile(join(FLOWS_DIR, 'search.yaml'));

    // Matched as substrings rather than whole selectors: several waits are scoped by `data-place`
    // to avoid resolving against the previous screen, and pinning the whole string here would make
    // that scoping a test failure rather than the improvement it is.
    const waits = (flow: { steps: { waitFor?: string }[] }) => flow.steps.map((step) => step.waitFor ?? '').join('\n');

    expect(waits(forecast)).toContain('[data-test=chart-line]');
    expect(waits(forecast)).toContain('[data-test=aqi-badge]');
    expect(waits(search)).toContain('[data-test=search-results]');
  });

  it('covers the empty, loading-capable and error screens the spec names', async () => {
    const search = await loadFlowFile(join(FLOWS_DIR, 'search.yaml'));
    const states = await loadFlowFile(join(FLOWS_DIR, 'states.yaml'));

    expect(search.steps.some((step) => step.waitFor === '[data-test=empty-state]')).toBe(true);
    expect(states.steps.some((step) => step.waitFor === '[data-test=error-detail]')).toBe(true);
  });

  it('pins the API’s own refusal text, which is the reason the 400 is worth committing', async () => {
    const states = await loadFlowFile(join(FLOWS_DIR, 'states.yaml'));
    const step = states.steps.find((candidate) => candidate.id === 'forecast-error');
    const texts = (step?.expect ?? []).map((expectation) => expectation.text);
    expect(texts).toContain('Latitude must be in range of -90 to 90°. Given: 999.0.');
  });

  it('shares one run-store namespace per flow, so no two flows collide on a name', () => {
    const names = flowFiles.map((name) => basename(name, '.yaml'));
    expect(new Set(names).size).toBe(names.length);
  });
});
