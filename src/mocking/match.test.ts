import { describe, expect, it } from 'vitest';

import type { ScenarioRule } from '../types.js';
import { RequestCounter, requestKey, ruleMatches, selectRule } from './match.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast?latitude=38.72&hourly=temperature_2m';

function get(url = FORECAST) {
  return { method: 'GET', url };
}

const rule = (over: Partial<ScenarioRule> & { id: string; match: ScenarioRule['match'] }) =>
  ({ abort: true, ...over }) as ScenarioRule;

describe('rule matching', () => {
  it('matches any method when the rule omits one', () => {
    const r = rule({ id: 'any', match: { url: '**/v1/forecast**' } });
    expect(ruleMatches(r, { method: 'GET', url: FORECAST }, 1)).toBe(true);
    expect(ruleMatches(r, { method: 'POST', url: FORECAST }, 1)).toBe(true);
  });

  it('compares an explicit method case-insensitively', () => {
    const r = rule({ id: 'get', match: { method: 'get', url: '**/v1/forecast**' } });
    expect(ruleMatches(r, { method: 'GET', url: FORECAST }, 1)).toBe(true);
    expect(ruleMatches(r, { method: 'POST', url: FORECAST }, 1)).toBe(false);
  });

  it('matches the full url including the query string', () => {
    const r = rule({ id: 'units', match: { url: '**/v1/forecast?*temperature_unit=fahrenheit*' } });
    expect(ruleMatches(r, get(`${FORECAST}&temperature_unit=fahrenheit`), 1)).toBe(true);
    expect(ruleMatches(r, get(FORECAST), 1)).toBe(false);
  });

  it('honours nth by comparing it to the occurrence, not to a rule-local count', () => {
    const r = rule({ id: 'second', match: { url: '**/forecast**', nth: 2 } });
    expect(ruleMatches(r, get(), 1)).toBe(false);
    expect(ruleMatches(r, get(), 2)).toBe(true);
    expect(ruleMatches(r, get(), 3)).toBe(false);
  });
});

describe('first match wins in file order', () => {
  const rules: ScenarioRule[] = [
    rule({ id: 'specific', match: { method: 'GET', url: '**/v1/forecast**' } }),
    rule({ id: 'catch-all', match: { url: '**' } }),
  ];

  it('returns the earliest matching rule and its index', () => {
    expect(selectRule(rules, get(), 1)).toEqual({ rule: rules[0], index: 0, occurrence: 1 });
  });

  it('falls through to a later rule when the earlier one does not match', () => {
    const selected = selectRule(rules, { method: 'POST', url: 'https://x.test/analytics' }, 1);
    expect(selected?.rule.id).toBe('catch-all');
    expect(selected?.index).toBe(1);
  });

  it('returns null for a passthrough', () => {
    expect(selectRule([rules[0] as ScenarioRule], { method: 'GET', url: 'https://x.test/a' }, 1)).toBeNull();
  });

  it('lets an nth rule placed first take only its occurrence, leaving the rest to the next rule', () => {
    const ordered: ScenarioRule[] = [
      rule({ id: 'first-call', match: { url: '**/forecast**', nth: 1 } }),
      rule({ id: 'later-calls', match: { url: '**/forecast**' } }),
    ];
    expect(selectRule(ordered, get(), 1)?.rule.id).toBe('first-call');
    expect(selectRule(ordered, get(), 2)?.rule.id).toBe('later-calls');
  });
});

describe('occurrence counting (§11)', () => {
  it('counts per (method, url), one-based', () => {
    const counter = new RequestCounter();
    expect(counter.next(get())).toBe(1);
    expect(counter.next(get())).toBe(2);
    expect(counter.seen(get())).toBe(2);
  });

  it('keeps separate counters for different methods and different query strings', () => {
    const counter = new RequestCounter();
    expect(counter.next({ method: 'GET', url: FORECAST })).toBe(1);
    expect(counter.next({ method: 'POST', url: FORECAST })).toBe(1);
    expect(counter.next({ method: 'GET', url: `${FORECAST}&past_days=7` })).toBe(1);
    expect(counter.next({ method: 'GET', url: FORECAST })).toBe(2);
  });

  it('treats the method case-insensitively when keying', () => {
    const counter = new RequestCounter();
    counter.next({ method: 'get', url: FORECAST });
    expect(counter.next({ method: 'GET', url: FORECAST })).toBe(2);
    expect(requestKey({ method: 'get', url: FORECAST })).toBe(`GET ${FORECAST}`);
  });

  it('forgets everything on reset, so a new run starts at 1', () => {
    const counter = new RequestCounter();
    counter.next(get());
    counter.reset();
    expect(counter.next(get())).toBe(1);
  });
});
