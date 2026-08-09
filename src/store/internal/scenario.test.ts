/**
 * The scenario axis of run identity (mocking spec §6, D12).
 *
 * The property under test throughout: a run captured before scenarios existed is not "unknown", it
 * is `none` — a fact about that run, and one every reader must reach the same way.
 */

import { describe, expect, it } from 'vitest';

import {
  normalizeRunMeta,
  normalizeScenarioName,
  sameScenario,
  scenarioOf,
} from './scenario.js';
import { SCENARIO_NONE } from '../../types.js';
import type { RunMeta } from '../../types.js';

const META: RunMeta = {
  runId: '0007',
  flow: 'forecast',
  scenario: 'empty-forecast',
  flowHash: 'sha256:abc',
  revision: { sha: '9f8e7d6', ref: 'main', dirty: false },
  mode: 'attach',
  network: 'replay',
  harHits: 3,
  harMisses: 0,
  viewports: ['1280x800'],
  status: 'ok',
  failedSteps: [],
  env: {
    tool: '0.1.0',
    node: 'v20.0.0',
    playwright: '1.50.0',
    chromium: '133',
    os: 'darwin-arm64',
    deviceScaleFactor: 2,
  },
  startedAt: '2026-08-10T10:00:00.000Z',
  finishedAt: '2026-08-10T10:00:10.000Z',
  unstable: false,
  pinned: false,
  pruned: false,
  warnings: [],
};

/** A meta.json as slice 1 wrote it: every field of `RunMeta` except the one this slice added. */
function sliceOneMeta(): Partial<RunMeta> {
  const copy: Partial<RunMeta> = { ...META };
  delete copy.scenario;
  return copy;
}

describe('scenarioOf', () => {
  it('answers the scenario a run recorded', () => {
    expect(scenarioOf(META)).toBe('empty-forecast');
  });

  it('reads a slice-1 meta.json, which has no scenario key at all, as the reserved none', () => {
    const sliceOne = sliceOneMeta();
    expect('scenario' in sliceOne).toBe(false);
    expect(scenarioOf(sliceOne)).toBe(SCENARIO_NONE);
    expect(scenarioOf(sliceOne)).toBe('none');
  });

  it('treats blank, missing and non-string values as none rather than as an error', () => {
    expect(scenarioOf({ scenario: '' })).toBe(SCENARIO_NONE);
    expect(scenarioOf({ scenario: '   ' })).toBe(SCENARIO_NONE);
    expect(scenarioOf({ scenario: undefined })).toBe(SCENARIO_NONE);
    expect(scenarioOf({ scenario: 7 as unknown as string })).toBe(SCENARIO_NONE);
    expect(scenarioOf(null)).toBe(SCENARIO_NONE);
    expect(scenarioOf(undefined)).toBe(SCENARIO_NONE);
  });

  it('trims, so a stray space in a hand-edited meta.json is not a second scenario', () => {
    expect(scenarioOf({ scenario: ' empty-forecast ' })).toBe('empty-forecast');
  });
});

describe('normalizeScenarioName', () => {
  it('normalises a --scenario argument exactly as a run’s own field is', () => {
    expect(normalizeScenarioName('empty-forecast')).toBe('empty-forecast');
    expect(normalizeScenarioName(' empty-forecast ')).toBe('empty-forecast');
    expect(normalizeScenarioName(undefined)).toBe(SCENARIO_NONE);
    expect(normalizeScenarioName('')).toBe(SCENARIO_NONE);
    // `--scenario none` is spelled the same way a scenario-less run records itself.
    expect(normalizeScenarioName('none')).toBe(SCENARIO_NONE);
  });
});

describe('normalizeRunMeta', () => {
  it('guarantees the field is present, so in-memory code never handles "unknown"', () => {
    const sliceOne = sliceOneMeta();
    const normalized = normalizeRunMeta(sliceOne as RunMeta);
    expect(normalized.scenario).toBe(SCENARIO_NONE);
    expect(normalized.runId).toBe('0007');
  });

  it('returns the same object when nothing needs defaulting', () => {
    expect(normalizeRunMeta(META)).toBe(META);
  });

  it('never rewrites a scenario a run really recorded', () => {
    expect(normalizeRunMeta({ ...META, scenario: 'wireframe' }).scenario).toBe('wireframe');
  });
});

describe('sameScenario', () => {
  it('is the default pairing rule: like for like, with absent meaning none', () => {
    const sliceOne = sliceOneMeta();
    expect(sameScenario(META, { scenario: 'empty-forecast' })).toBe(true);
    expect(sameScenario(META, { scenario: 'slow-forecast' })).toBe(false);
    expect(sameScenario(sliceOne, { scenario: SCENARIO_NONE })).toBe(true);
    expect(sameScenario(sliceOne, META)).toBe(false);
  });
});
