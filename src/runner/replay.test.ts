import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import type { HarMatch, NetworkMode, ScenarioAction, ScenarioAttribution, Step } from '../types.js';
import { harMatchFor, nextAnchor, pngSize, scenarioAnswered, selectorOf, verbOf } from './replay.js';

describe('pngSize', () => {
  it('reads the IHDR chunk of a real PNG', () => {
    const png = new PNG({ width: 37, height: 11 });
    const size = pngSize(PNG.sync.write(png));
    expect(size).toEqual({ width: 37, height: 11 });
  });

  it('reports zeroes rather than throwing on a truncated buffer', () => {
    expect(pngSize(new Uint8Array(4))).toEqual({ width: 0, height: 0 });
  });
});

describe('verbOf', () => {
  it('names the verb a step failed on, in vocabulary order', () => {
    expect(verbOf({ id: 'a', goto: '/cart' })).toBe('goto');
    expect(verbOf({ id: 'a', click: '#pay' })).toBe('click');
    expect(verbOf({ id: 'a', waitFor: 'text=Payment' })).toBe('waitFor');
    expect(verbOf({ id: 'a', shoot: true })).toBeUndefined();
  });
});

describe('selectorOf', () => {
  it('returns the selector the step resolved against — the D4 drift signal', () => {
    expect(selectorOf({ id: 'a', click: '[data-test=pay]' })).toBe('[data-test=pay]');
    expect(selectorOf({ id: 'a', fill: { '[name=card]': '4242' } })).toBe('[name=card]');
    expect(selectorOf({ id: 'a', scroll: { selector: '#footer' } })).toBe('#footer');
    expect(selectorOf({ id: 'a', goto: '/cart' })).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ HAR verdicts (mocking §8) */

function attributed(action: ScenarioAction): ScenarioAttribution {
  return { scenario: 'empty-forecast', ruleId: 'r1', action, bodyChanged: false };
}

describe('harMatchFor', () => {
  it('is the slice-1 rule, unchanged, when no scenario was in force', () => {
    expect(harMatchFor('replay', undefined, false)).toBe('hit');
    expect(harMatchFor('replay', undefined, true)).toBe('miss');
    expect(harMatchFor('record', undefined, false)).toBe('recorded');
    expect(harMatchFor('record', undefined, true)).toBe('recorded');
    expect(harMatchFor('off', undefined, false)).toBe('bypassed');
  });

  /*
   * A rule that deliberately aborted or answered a request never consulted the recording. Calling
   * it a `hit` would inflate the HAR coverage a replay reports; calling it a `miss` would raise the
   * warning that says the diff may be misleading, about a scenario doing exactly what it was asked.
   */
  it.each<[ScenarioAction, HarMatch]>([
    ['abort', 'bypassed'],
    ['respond', 'bypassed'],
    ['patch', 'hit'],
    ['patchOps', 'hit'],
    ['miss', 'miss'],
  ])('reads the scenario action %s as %s, whatever the network mode', (action, expected) => {
    for (const mode of ['replay', 'mock', 'off', 'record'] as NetworkMode[]) {
      expect(harMatchFor(mode, attributed(action), false)).toBe(expected);
      expect(harMatchFor(mode, attributed(action), true)).toBe(expected);
    }
  });

  it('lets the network mode decide for a request the scenario passed through', () => {
    expect(harMatchFor('replay', attributed('passthrough'), false)).toBe('hit');
    expect(harMatchFor('replay', attributed('passthrough'), true)).toBe('miss');
    expect(harMatchFor('replay', attributed('delay'), false)).toBe('hit');
    expect(harMatchFor('replay', attributed('delay'), true)).toBe('miss');
  });

  /* In mock mode an unmatched request is attributed `miss`; anything else that got through went to
   * the app's own origin, which is never the recording and never a miss. */
  it('never calls an app-origin request in mock mode a miss', () => {
    expect(harMatchFor('mock', attributed('passthrough'), false)).toBe('bypassed');
    expect(harMatchFor('mock', attributed('passthrough'), true)).toBe('bypassed');
  });

  /*
   * A request the recording had no entry for, which the app-origin backstop handed to the dev
   * server (`browser.ts#routeAppOriginOnly`). It never consulted the HAR: calling it a hit would
   * report a replay's HAR coverage as several times what it is, and calling a failed one a miss
   * would raise "the diff may be misleading" about the dev server doing its job.
   */
  it('calls a request the dev server answered bypassed, not a hit', () => {
    expect(harMatchFor('replay', undefined, false, true)).toBe('bypassed');
    expect(harMatchFor('replay', undefined, true, true)).toBe('bypassed');
  });

  /*
   * The distinction is *observed*, never inferred from the URL. A slice-1 recording contains the
   * app's own document, so on replay the HAR really does answer it — and that is a real hit. Only
   * a request the backstop actually passed through is bypassed.
   */
  it('still calls an app-origin request the HAR answered a hit', () => {
    expect(harMatchFor('replay', undefined, false, false)).toBe('hit');
    expect(harMatchFor('replay', undefined, true, false)).toBe('miss');
  });

  it('defaults to the network verdict, so slice-1 call sites are unchanged', () => {
    expect(harMatchFor('replay', undefined, false)).toBe('hit');
    expect(harMatchFor('off', undefined, false)).toBe('bypassed');
  });

  /*
   * A scenario's own verdict outranks it: a rule that answered or aborted a request settled it
   * before either the recording or the backstop was reached.
   */
  it('lets a scenario action outrank the dev-server verdict', () => {
    expect(harMatchFor('replay', attributed('respond'), false, true)).toBe('bypassed');
    expect(harMatchFor('mock', attributed('miss'), true, true)).toBe('miss');
    expect(harMatchFor('replay', attributed('patch'), false, true)).toBe('hit');
  });
});

/*
 * The count behind the `mock N served` line. Under `mock` there is no recording, so `harHits` is
 * necessarily 0 and "har 0 hit" would be a true sentence reading as total failure of a run that in
 * fact served every request from its scenario.
 */
describe('scenarioAnswered', () => {
  it('counts the two verbs that answer a request without the recording', () => {
    expect(scenarioAnswered(attributed('respond'))).toBe(true);
    expect(scenarioAnswered(attributed('abort'))).toBe(true);
  });

  /* `patch` and `patchOps` *are* the recording, rewritten: they already count as HAR hits, and
   * counting them here too would report one request twice. */
  it('does not count a rule that rewrote a recorded body', () => {
    expect(scenarioAnswered(attributed('patch'))).toBe(false);
    expect(scenarioAnswered(attributed('patchOps'))).toBe(false);
  });

  it('does not count a request no rule claimed, or one with no scenario at all', () => {
    expect(scenarioAnswered(attributed('passthrough'))).toBe(false);
    expect(scenarioAnswered(attributed('delay'))).toBe(false);
    expect(scenarioAnswered(attributed('miss'))).toBe(false);
    expect(scenarioAnswered(undefined)).toBe(false);
  });
});

describe('nextAnchor', () => {
  const steps: Step[] = [
    { id: 'cart', goto: '/cart' },
    { id: 'pay-form', click: '#pay' },
    { id: 'fill-card', fill: { '[name=card]': '4242' } },
    { id: 'receipt', goto: '/receipt' },
    { id: 'print', click: '#print' },
  ];

  it('finds the next goto step, which is where --continue-on-error re-anchors', () => {
    expect(nextAnchor(steps, 1)).toBe(3);
    expect(nextAnchor(steps, 4)).toBe(-1);
  });

  it('treats the step it starts on as a candidate', () => {
    expect(nextAnchor(steps, 3)).toBe(3);
    expect(nextAnchor(steps, 0)).toBe(0);
  });
});
