/**
 * The fold from `network.json` to what the report prints (mocking spec §8).
 *
 * The sentences are asserted verbatim: "response modified by `empty-forecast` rule
 * `forecast-empty`" is the wording the spec names, and it is what a reviewer reads to understand
 * why a screen looks the way it does.
 */

import { describe, expect, it } from 'vitest';

import { SCENARIO_NONE, type NetworkEntry, type ScenarioAttribution } from '../types.js';
import {
  MAX_ATTRIBUTION_URLS,
  describeRuleHit,
  hasAttribution,
  modifiedRules,
  summarizeStep,
  type RuleHit,
} from './attribution.js';

function entry(url: string, attribution?: ScenarioAttribution): NetworkEntry {
  const value: NetworkEntry = {
    step: 'forecast',
    viewport: '1280x800',
    method: 'GET',
    url,
    status: 200,
    resourceType: 'fetch',
    harMatch: 'hit',
    durationMs: 12,
  };
  if (attribution !== undefined) value.attribution = attribution;
  return value;
}

function attributed(
  ruleId: string | null,
  action: ScenarioAttribution['action'],
  bodyChanged = false,
  scenario = 'empty-forecast',
): ScenarioAttribution {
  return { scenario, ruleId, action, bodyChanged };
}

function hit(patch: Partial<RuleHit> = {}): RuleHit {
  return {
    scenario: 'empty-forecast',
    ruleId: 'forecast-empty',
    action: 'patch',
    requests: 1,
    bodyChanged: 1,
    urls: ['https://api/v1/forecast'],
    ...patch,
  };
}

describe('summarizeStep', () => {
  it('folds many requests into one row per rule and action', () => {
    const step = summarizeStep('forecast', [
      entry('https://api/v1/forecast?a=1', attributed('forecast-empty', 'patch', true)),
      entry('https://api/v1/forecast?a=2', attributed('forecast-empty', 'patch', true)),
      entry('https://api/analytics/x', attributed('no-analytics', 'abort')),
      entry('https://api/v1/units', attributed(null, 'passthrough')),
    ]);

    expect(step.step).toBe('forecast');
    expect(step.passthroughs).toBe(1);
    expect(step.misses).toBe(0);
    expect(step.rules).toEqual([
      {
        scenario: 'empty-forecast',
        ruleId: 'forecast-empty',
        action: 'patch',
        requests: 2,
        bodyChanged: 2,
        urls: ['https://api/v1/forecast?a=1', 'https://api/v1/forecast?a=2'],
      },
      {
        scenario: 'empty-forecast',
        ruleId: 'no-analytics',
        action: 'abort',
        requests: 1,
        bodyChanged: 0,
        urls: ['https://api/analytics/x'],
      },
    ]);
  });

  it('keeps rows in the order their first request appeared', () => {
    const step = summarizeStep('forecast', [
      entry('https://api/b', attributed('second', 'respond', true)),
      entry('https://api/a', attributed('first', 'patch', true)),
      entry('https://api/b2', attributed('second', 'respond', true)),
    ]);
    expect(step.rules.map((rule) => rule.ruleId)).toEqual(['second', 'first']);
  });

  it('separates a rule’s actions, so a delayed request is not reported as an abort', () => {
    const step = summarizeStep('forecast', [
      entry('https://api/a', attributed('slow-air', 'delay')),
      entry('https://api/b', attributed('slow-air', 'patch', true)),
    ]);
    expect(step.rules.map((rule) => `${rule.ruleId}:${rule.action}`)).toEqual([
      'slow-air:delay',
      'slow-air:patch',
    ]);
  });

  it('counts a mock-mode miss separately from a passthrough (mocking §8)', () => {
    const step = summarizeStep('forecast', [
      entry('https://api/a', attributed(null, 'miss')),
      entry('https://api/b', attributed(null, 'miss')),
      entry('https://api/c', attributed(null, 'passthrough')),
    ]);
    expect(step.misses).toBe(2);
    expect(step.passthroughs).toBe(1);
    expect(step.rules).toEqual([]);
  });

  it('ignores entries with no attribution, rather than inventing a decision nobody made', () => {
    const step = summarizeStep('forecast', [entry('https://api/a'), entry('https://api/b')]);
    expect(step).toEqual({ step: 'forecast', rules: [], passthroughs: 0, misses: 0 });
  });

  it('caps and de-duplicates the URLs it keeps', () => {
    const entries = Array.from({ length: MAX_ATTRIBUTION_URLS + 4 }, (_, i) =>
      entry(`https://api/v1/forecast?i=${i}`, attributed('forecast-empty', 'patch', true)),
    );
    entries.push(entry('https://api/v1/forecast?i=0', attributed('forecast-empty', 'patch', true)));

    const step = summarizeStep('forecast', entries);
    expect(step.rules[0]?.urls).toHaveLength(MAX_ATTRIBUTION_URLS);
    expect(new Set(step.rules[0]?.urls).size).toBe(MAX_ATTRIBUTION_URLS);
    expect(step.rules[0]?.requests).toBe(MAX_ATTRIBUTION_URLS + 5);
  });
});

describe('describeRuleHit', () => {
  it('uses the spec’s wording when a body actually changed (mocking §8)', () => {
    expect(describeRuleHit(hit({ action: 'patch' }))).toBe(
      'response modified by empty-forecast rule forecast-empty',
    );
    expect(describeRuleHit(hit({ action: 'patchOps' }))).toBe(
      'response modified by empty-forecast rule forecast-empty',
    );
    expect(describeRuleHit(hit({ action: 'respond' }))).toBe(
      'response modified by empty-forecast rule forecast-empty',
    );
  });

  it('refuses to claim a modification that did not happen', () => {
    expect(describeRuleHit(hit({ action: 'patch', bodyChanged: 0 }))).toBe(
      'empty-forecast rule forecast-empty matched, response unchanged',
    );
  });

  it('names what an abort and a delay actually did', () => {
    expect(describeRuleHit(hit({ ruleId: 'no-analytics', action: 'abort', bodyChanged: 0 }))).toBe(
      'request aborted by empty-forecast rule no-analytics',
    );
    expect(describeRuleHit(hit({ ruleId: 'slow-air', action: 'delay', bodyChanged: 0 }))).toBe(
      'response delayed by empty-forecast rule slow-air',
    );
  });
});

describe('modifiedRules', () => {
  it('keeps the rules that changed what the page received', () => {
    const step = summarizeStep('forecast', [
      entry('https://api/a', attributed('patched', 'patch', true)),
      entry('https://api/b', attributed('noop', 'patch', false)),
      entry('https://api/c', attributed('gone', 'abort')),
      entry('https://api/d', attributed('late', 'delay')),
    ]);
    expect(modifiedRules(step).map((rule) => rule.ruleId)).toEqual(['patched', 'gone']);
  });
});

describe('hasAttribution', () => {
  it('is false for a missing run and for a scenario-less run with nothing recorded', () => {
    expect(hasAttribution(null)).toBe(false);
    expect(
      hasAttribution({ flow: 'f', runId: '0007', scenario: SCENARIO_NONE, steps: [] }),
    ).toBe(false);
  });

  it('is true whenever a scenario was in force, even before any rule fired', () => {
    expect(
      hasAttribution({ flow: 'f', runId: '0007', scenario: 'empty-forecast', steps: [] }),
    ).toBe(true);
  });
});
