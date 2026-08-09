import { describe, expect, it } from 'vitest';

import type { ScenarioMode, ScenarioRule, ScenarioSpec } from '../types.js';
import { ScenarioEngine, needsRecordedResponse, resolveDecision, verbOf } from './engine.js';
import { ScenarioError } from './errors.js';
import type { RecordedResponse } from './response.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast?latitude=38.72&hourly=temperature_2m';

function spec(rules: ScenarioRule[], mode: ScenarioMode = 'overlay'): ScenarioSpec {
  return { version: 1, scenario: 'empty-forecast', mode, rules };
}

function recordedJson(body: unknown): RecordedResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '99' },
    mediaType: 'application/json',
    text: JSON.stringify(body),
  };
}

const get = { method: 'GET', url: FORECAST };

describe('verbs', () => {
  it('names the verb a rule carries, with delay standing alone', () => {
    expect(verbOf({ id: 'a', match: { url: '**' }, patch: { a: 1 } })).toBe('patch');
    expect(verbOf({ id: 'a', match: { url: '**' }, patchOps: [] })).toBe('patchOps');
    expect(verbOf({ id: 'a', match: { url: '**' }, respond: { status: 500 } })).toBe('respond');
    expect(verbOf({ id: 'a', match: { url: '**' }, abort: true })).toBe('abort');
    expect(verbOf({ id: 'a', match: { url: '**' }, delay: 3000 })).toBe('delay');
  });

  it('needs the recorded response only for the two patch verbs', () => {
    const of = (rule: ScenarioRule) => needsRecordedResponse({ rule, index: 0, occurrence: 1 });
    expect(of({ id: 'a', match: { url: '**' }, patch: {} })).toBe(true);
    expect(of({ id: 'a', match: { url: '**' }, patchOps: [] })).toBe(true);
    expect(of({ id: 'a', match: { url: '**' }, respond: { status: 500 } })).toBe(false);
    expect(of({ id: 'a', match: { url: '**' }, abort: true })).toBe(false);
    expect(of({ id: 'a', match: { url: '**' }, delay: 10 })).toBe(false);
    expect(needsRecordedResponse(null)).toBe(false);
  });
});

describe('overlay mode', () => {
  it('passes an unmatched request through to the recording', () => {
    const engine = new ScenarioEngine(spec([{ id: 'r', match: { url: '**/v1/search**' }, abort: true }]));
    const decision = engine.handle(get);
    expect(decision.action).toEqual({ kind: 'passthrough', delayMs: 0 });
    expect(decision.attribution).toEqual({
      scenario: 'empty-forecast',
      ruleId: null,
      action: 'passthrough',
      bodyChanged: false,
    });
    expect(decision.rule).toBeNull();
  });

  it('applies a merge patch to the recorded body and attributes the rule', () => {
    const engine = new ScenarioEngine(
      spec([
        {
          id: 'forecast-empty',
          match: { method: 'GET', url: '**/v1/forecast**' },
          patch: { hourly: { temperature_2m: [] } },
        },
      ]),
    );
    const recorded = recordedJson({ hourly: { time: ['00:00'], temperature_2m: [17.4] } });
    const decision = engine.handle(get, recorded);

    expect(decision.action.kind).toBe('fulfill');
    if (decision.action.kind !== 'fulfill') throw new Error('expected a fulfill');
    expect(JSON.parse(decision.action.response.body as string)).toEqual({
      hourly: { time: ['00:00'], temperature_2m: [] },
    });
    // content-length described the recorded bytes and is dropped with them.
    expect(decision.action.response.headers).toEqual({ 'content-type': 'application/json' });
    expect(decision.attribution).toEqual({
      scenario: 'empty-forecast',
      ruleId: 'forecast-empty',
      action: 'patch',
      bodyChanged: true,
    });
  });

  it('reports bodyChanged false for a patch that changes nothing', () => {
    const engine = new ScenarioEngine(
      spec([{ id: 'noop', match: { url: '**' }, patch: { a: 1 } }]),
    );
    const decision = engine.handle(get, recordedJson({ a: 1 }));
    expect(decision.attribution).toEqual({
      scenario: 'empty-forecast',
      ruleId: 'noop',
      action: 'patch',
      bodyChanged: false,
    });
  });

  it('applies patchOps for what merge patch cannot express', () => {
    const engine = new ScenarioEngine(
      spec([
        {
          id: 'first-day-removed',
          match: { url: '**/v1/forecast**' },
          patchOps: [
            { op: 'remove', path: '/daily/time/0' },
            { op: 'replace', path: '/daily/weather_code/0', value: 95 },
          ],
        },
      ]),
    );
    const decision = engine.handle(
      get,
      recordedJson({ daily: { time: ['a', 'b'], weather_code: [3, 61] } }),
    );
    if (decision.action.kind !== 'fulfill') throw new Error('expected a fulfill');
    expect(JSON.parse(decision.action.response.body as string)).toEqual({
      daily: { time: ['b'], weather_code: [95, 61] },
    });
    expect(decision.attribution.action).toBe('patchOps');
    expect(decision.attribution.bodyChanged).toBe(true);
  });

  it('serves a respond rule without consulting the recording', () => {
    const engine = new ScenarioEngine(
      spec([
        {
          id: 'geocode-fails',
          match: { method: 'GET', url: '**/v1/forecast**' },
          respond: {
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: { error: 'upstream_unavailable' },
          },
        },
      ]),
    );
    const decision = engine.handle(get);
    expect(decision.action).toEqual({
      kind: 'fulfill',
      delayMs: 0,
      response: {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: '{"error":"upstream_unavailable"}',
      },
    });
    expect(decision.attribution.action).toBe('respond');
    expect(decision.attribution.bodyChanged).toBe(true);
  });

  it('reports a respond that reproduces the recorded body as unchanged', () => {
    const engine = new ScenarioEngine(
      spec([{ id: 'same', match: { url: '**' }, respond: { status: 200, body: { a: 1 } } }]),
    );
    const decision = engine.handle(get, recordedJson({ a: 1 }));
    expect(decision.attribution.bodyChanged).toBe(false);
  });

  it('aborts on an abort rule', () => {
    const engine = new ScenarioEngine(
      spec([{ id: 'no-analytics', match: { url: '**' }, abort: true }]),
    );
    const decision = engine.handle(get);
    expect(decision.action).toEqual({ kind: 'abort', delayMs: 0, reason: 'rule' });
    expect(decision.attribution).toEqual({
      scenario: 'empty-forecast',
      ruleId: 'no-analytics',
      action: 'abort',
      bodyChanged: false,
    });
  });

  it('passes the recording through late for a delay-only rule', () => {
    const engine = new ScenarioEngine(
      spec([{ id: 'slow-air-quality', match: { url: '**' }, delay: 3000 }]),
    );
    const decision = engine.handle(get);
    expect(decision.action).toEqual({ kind: 'passthrough', delayMs: 3000 });
    expect(decision.attribution).toEqual({
      scenario: 'empty-forecast',
      ruleId: 'slow-air-quality',
      action: 'delay',
      bodyChanged: false,
    });
  });

  it('composes delay with every other verb', () => {
    const rules: ScenarioRule[] = [
      { id: 'slow-patch', match: { url: '**/a' }, delay: 100, patch: { a: 2 } },
      { id: 'slow-respond', match: { url: '**/b' }, delay: 200, respond: { status: 503 } },
      { id: 'slow-abort', match: { url: '**/c' }, delay: 300, abort: true },
    ];
    const engine = new ScenarioEngine(spec(rules));
    expect(engine.handle({ method: 'GET', url: 'https://x.test/a' }, recordedJson({ a: 1 })).action)
      .toMatchObject({ kind: 'fulfill', delayMs: 100 });
    expect(engine.handle({ method: 'GET', url: 'https://x.test/b' }).action).toMatchObject({
      kind: 'fulfill',
      delayMs: 200,
    });
    expect(engine.handle({ method: 'GET', url: 'https://x.test/c' }).action).toEqual({
      kind: 'abort',
      delayMs: 300,
      reason: 'rule',
    });
  });
});

describe('mock mode (D13)', () => {
  it('aborts an unmatched request as a miss, with no rule to attribute it to', () => {
    const engine = new ScenarioEngine(
      spec([{ id: 'r', match: { url: '**/v1/search**' }, respond: { status: 200 } }], 'mock'),
    );
    const decision = engine.handle(get);
    expect(decision.action).toEqual({ kind: 'abort', delayMs: 0, reason: 'no-recording' });
    expect(decision.attribution).toEqual({
      scenario: 'empty-forecast',
      ruleId: null,
      action: 'miss',
      bodyChanged: false,
    });
  });

  it('serves respond and abort exactly as overlay mode does', () => {
    const engine = new ScenarioEngine(
      spec(
        [
          { id: 'served', match: { url: '**/a' }, respond: { status: 200, body: { ok: true } } },
          { id: 'blocked', match: { url: '**/b' }, abort: true },
        ],
        'mock',
      ),
    );
    expect(engine.handle({ method: 'GET', url: 'https://x.test/a' }).action).toEqual({
      kind: 'fulfill',
      delayMs: 0,
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
    });
    expect(engine.handle({ method: 'GET', url: 'https://x.test/b' }).action).toMatchObject({
      reason: 'rule',
    });
  });

  it('treats a delay-only rule as a miss, attributed to the rule that left it unserved', () => {
    const engine = new ScenarioEngine(
      spec([{ id: 'slow', match: { url: '**' }, delay: 500 }], 'mock'),
    );
    const decision = engine.handle(get);
    expect(decision.action).toEqual({ kind: 'abort', delayMs: 500, reason: 'no-recording' });
    expect(decision.attribution).toEqual({
      scenario: 'empty-forecast',
      ruleId: 'slow',
      action: 'miss',
      bodyChanged: false,
    });
  });

  it('refuses a patch verb that got past validation, saying what to use instead', () => {
    const engine = new ScenarioEngine(
      spec([{ id: 'forecast-empty', match: { url: '**' }, patch: { a: 1 } }], 'mock'),
    );
    expect(() => engine.handle(get)).toThrow(
      "scenario 'empty-forecast' rule 'forecast-empty' uses patch, which is not valid in a " +
        'mock-mode scenario: there is no recorded response to patch',
    );
    try {
      engine.handle(get);
    } catch (error) {
      expect(ScenarioError.is(error)).toBe(true);
      const scenarioError = error as ScenarioError;
      expect(scenarioError.code).toBe('scenario-patch-in-mock');
      expect(scenarioError.hint).toBe(
        "use 'respond' to serve a whole body, or set mode: overlay and record the traffic",
      );
    }
  });
});

describe('run failures name the responsible rule (§8)', () => {
  const patchRule: ScenarioRule = {
    id: 'forecast-empty',
    match: { url: '**/v1/forecast**' },
    patch: { hourly: null },
  };

  it('fails when a patch rule matched a request the recording has no response for', () => {
    const engine = new ScenarioEngine(spec([patchRule]));
    try {
      engine.handle(get, undefined);
      expect.unreachable('expected the engine to fail');
    } catch (error) {
      const scenarioError = error as ScenarioError;
      expect(scenarioError.code).toBe('scenario-no-recorded-response');
      expect(scenarioError.message).toBe(
        `scenario 'empty-forecast' rule 'forecast-empty' matched GET ${FORECAST}, but the ` +
          'recording has no response for it, so there is nothing for patch to patch',
      );
      expect(scenarioError.ruleId).toBe('forecast-empty');
      expect(scenarioError.url).toBe(FORECAST);
      expect(scenarioError.kind).toBe('scenario-failed');
      expect(scenarioError.exitCode).toBe(1);
    }
  });

  it('fails when the recorded body is not JSON, naming the content type', () => {
    const engine = new ScenarioEngine(spec([patchRule]));
    const png: RecordedResponse = {
      status: 200,
      headers: { 'content-type': 'image/png' },
      mediaType: 'image/png',
      text: 'PNG',
    };
    try {
      engine.handle(get, png);
      expect.unreachable('expected the engine to fail');
    } catch (error) {
      const scenarioError = error as ScenarioError;
      expect(scenarioError.code).toBe('scenario-patch-non-json');
      expect(scenarioError.message).toBe(
        `scenario 'empty-forecast' rule 'forecast-empty' cannot apply patch to GET ${FORECAST}: ` +
          "the recorded response declares 'image/png', and patch/patchOps are only valid against " +
          'JSON content types',
      );
      expect(scenarioError.hint).toBe("use 'respond' to replace a non-JSON body outright");
    }
  });

  it('says "no content type" rather than quoting an empty one', () => {
    const engine = new ScenarioEngine(spec([patchRule]));
    expect(() =>
      engine.handle(get, { status: 200, headers: {}, mediaType: '', text: '{}' }),
    ).toThrow(/the recorded response declares no content type, and patch\/patchOps are only valid/);
  });

  it('fails when a JSON-typed recording holds no body', () => {
    const engine = new ScenarioEngine(spec([patchRule]));
    try {
      engine.handle(get, { ...recordedJson({}), text: undefined });
      expect.unreachable('expected the engine to fail');
    } catch (error) {
      const scenarioError = error as ScenarioError;
      expect(scenarioError.code).toBe('scenario-empty-recorded-body');
      expect(scenarioError.message).toBe(
        `scenario 'empty-forecast' rule 'forecast-empty' cannot apply patch to GET ${FORECAST}: ` +
          'the recorded response has no body to patch',
      );
    }
  });

  it('fails when a JSON-typed recording does not parse', () => {
    const engine = new ScenarioEngine(spec([patchRule]));
    try {
      engine.handle(get, { ...recordedJson({}), text: '{"hourly":' });
      expect.unreachable('expected the engine to fail');
    } catch (error) {
      const scenarioError = error as ScenarioError;
      expect(scenarioError.code).toBe('scenario-unparseable-body');
      expect(scenarioError.message).toContain(
        "scenario 'empty-forecast' rule 'forecast-empty' cannot apply patch to GET",
      );
      expect(scenarioError.message).toContain('the recorded body is not valid JSON');
    }
  });

  it('fails an inapplicable RFC 6902 op, quoting the operation that failed', () => {
    const engine = new ScenarioEngine(
      spec([
        {
          id: 'first-day-removed',
          match: { url: '**' },
          patchOps: [{ op: 'remove', path: '/daily/time/9' }],
        },
      ]),
    );
    try {
      engine.handle(get, recordedJson({ daily: { time: ['a'] } }));
      expect.unreachable('expected the engine to fail');
    } catch (error) {
      const scenarioError = error as ScenarioError;
      expect(scenarioError.code).toBe('scenario-patch-op-failed');
      expect(scenarioError.message).toBe(
        `scenario 'empty-forecast' rule 'first-day-removed' could not apply patchOps to GET ` +
          `${FORECAST}: patchOps[0] remove /daily/time/9: array index 9 is out of range for an ` +
          'array of length 1',
      );
    }
  });

  it('refuses to start when a rule glob does not compile, at exit 2', () => {
    try {
      new ScenarioEngine(spec([{ id: 'broken', match: { url: '**/v1/[forecast' }, abort: true }]));
      expect.unreachable('expected the constructor to throw');
    } catch (error) {
      const scenarioError = error as ScenarioError;
      expect(scenarioError.code).toBe('scenario-invalid-glob');
      expect(scenarioError.exitCode).toBe(2);
      expect(scenarioError.kind).toBe('scenario-invalid');
      expect(scenarioError.message).toBe(
        "scenario 'empty-forecast' rule 'broken': invalid url glob '**/v1/[forecast': " +
          "unterminated character class starting at index 6 — add a closing ']' or escape it as '\\['",
      );
    }
  });

  it('carries the CLI error shape', () => {
    const error = new ScenarioError({
      code: 'scenario-patch-non-json',
      message: 'boom',
      scenario: 's',
      hint: 'try this',
    });
    expect(error.toCliError()).toEqual({
      code: 'scenario-patch-non-json',
      message: 'boom',
      exitCode: 1,
      hint: 'try this',
    });
  });
});

describe('nth across a run', () => {
  const engine = () =>
    new ScenarioEngine(
      spec([
        { id: 'second-forecast', match: { url: '**/v1/forecast**', nth: 2 }, respond: { status: 503 } },
      ]),
    );

  it('applies the rule to the nth identical request only', () => {
    const e = engine();
    expect(e.handle(get).attribution.action).toBe('passthrough');
    expect(e.handle(get).attribution.ruleId).toBe('second-forecast');
    expect(e.handle(get).attribution.action).toBe('passthrough');
  });

  it('counts per (method, url), so a different url has its own numbering', () => {
    const e = engine();
    e.handle({ method: 'GET', url: 'https://x.test/other' });
    expect(e.handle(get).attribution.ruleId).toBeNull();
    expect(e.handle(get).attribution.ruleId).toBe('second-forecast');
  });

  it('starts numbering again after reset', () => {
    const e = engine();
    e.handle(get);
    e.handle(get);
    e.reset();
    expect(e.handle(get).attribution.ruleId).toBeNull();
    expect(e.unmatchedRuleIds()).toEqual(['second-forecast']);
  });
});

describe('warnings (§8)', () => {
  const rules: ScenarioRule[] = [
    { id: 'forecast-empty', match: { url: '**/v1/forecast**' }, respond: { status: 200 } },
    { id: 'geocode-fails', match: { url: '**/v1/search**' }, respond: { status: 500 } },
    { id: 'no-analytics', match: { url: '**/analytics/**' }, abort: true },
  ];

  it('reports nothing when every rule matched', () => {
    const engine = new ScenarioEngine(spec(rules));
    engine.handle(get);
    engine.handle({ method: 'GET', url: 'https://geo.test/v1/search?name=lisbon' });
    engine.handle({ method: 'POST', url: 'https://x.test/analytics/collect' });
    expect(engine.matchedRuleIds()).toEqual(['forecast-empty', 'geocode-fails', 'no-analytics']);
    expect(engine.unmatchedRuleIds()).toEqual([]);
    expect(engine.warnings()).toEqual([]);
  });

  it('names a single silent rule and says the recording is what was served', () => {
    const engine = new ScenarioEngine(spec(rules));
    engine.handle(get);
    engine.handle({ method: 'GET', url: 'https://geo.test/v1/search?name=lisbon' });
    expect(engine.unmatchedRulesWarning()).toEqual({
      kind: 'scenario-rule-unmatched',
      message:
        "scenario 'empty-forecast': rule 'no-analytics' never matched a request during this run — " +
        'those requests were served from the recording unchanged, so the screens you are looking ' +
        'at are the recorded state, not the patched one. Check the url glob.',
      rules: ['no-analytics'],
    });
  });

  it('lists every silent rule in file order when more than one went unused', () => {
    const engine = new ScenarioEngine(spec(rules));
    engine.handle({ method: 'POST', url: 'https://x.test/analytics/collect' });
    expect(engine.unmatchedRulesWarning()).toEqual({
      kind: 'scenario-rule-unmatched',
      message:
        "scenario 'empty-forecast': 2 rules never matched a request (forecast-empty, " +
        'geocode-fails) during this run — those requests were served from the recording unchanged, ' +
        'so the screens you are looking at are the recorded state, not the patched one. Check the ' +
        'url glob.',
      rules: ['forecast-empty', 'geocode-fails'],
    });
  });

  it('says something different in mock mode, where nothing served the request at all', () => {
    const engine = new ScenarioEngine(spec(rules, 'mock'));
    engine.handle(get);
    engine.handle({ method: 'GET', url: 'https://geo.test/v1/search?name=lisbon' });
    expect(engine.unmatchedRulesWarning()?.message).toBe(
      "scenario 'empty-forecast': rule 'no-analytics' never matched a request during this run — " +
        'nothing was served in their place, so the screens you are looking at are missing those ' +
        'responses. Check the url glob.',
    );
  });

  it('reports mock-mode misses with their urls and counts', () => {
    const engine = new ScenarioEngine(spec([rules[0] as ScenarioRule], 'mock'));
    engine.handle(get);
    engine.handle({ method: 'GET', url: 'https://x.test/a' });
    engine.handle({ method: 'GET', url: 'https://x.test/a' });
    engine.handle({ method: 'POST', url: 'https://x.test/b' });
    expect(engine.missWarning()).toEqual({
      kind: 'mock-miss',
      message:
        "scenario 'empty-forecast' (mock mode): 3 requests across 2 urls matched no rule and were " +
        'aborted — a mock-mode run serves only what its rules serve',
      urls: ['GET https://x.test/a', 'POST https://x.test/b'],
    });
  });

  it('uses singular wording for a single miss', () => {
    const engine = new ScenarioEngine(spec([rules[0] as ScenarioRule], 'mock'));
    engine.handle({ method: 'GET', url: 'https://x.test/a' });
    expect(engine.missWarning()?.message).toBe(
      "scenario 'empty-forecast' (mock mode): 1 request across 1 url matched no rule and was " +
        'aborted — a mock-mode run serves only what its rules serve',
    );
  });

  it('caps the listed urls and says how many it left out', () => {
    const engine = new ScenarioEngine(spec([rules[0] as ScenarioRule], 'mock'));
    for (let i = 0; i < 23; i += 1) engine.handle({ method: 'GET', url: `https://x.test/${i}` });
    const warning = engine.missWarning();
    expect(warning?.urls).toHaveLength(20);
    expect(warning?.message).toContain('23 requests across 23 urls matched no rule and were aborted (3 more not listed)');
  });

  it('produces no miss warning in overlay mode, where unmatched requests are served', () => {
    const engine = new ScenarioEngine(spec(rules));
    engine.handle({ method: 'GET', url: 'https://x.test/nothing-matches-this' });
    expect(engine.missWarning()).toBeNull();
  });

  it('orders warnings unmatched-rules first, then misses', () => {
    const engine = new ScenarioEngine(spec(rules, 'mock'));
    engine.handle({ method: 'GET', url: 'https://x.test/a' });
    expect(engine.warnings().map((warning) => warning.kind)).toEqual([
      'scenario-rule-unmatched',
      'mock-miss',
    ]);
  });

  it('clears its bookkeeping on reset', () => {
    const engine = new ScenarioEngine(spec(rules, 'mock'));
    engine.handle({ method: 'GET', url: 'https://x.test/a' });
    engine.handle(get);
    engine.reset();
    expect(engine.matchedRuleIds()).toEqual([]);
    expect(engine.missedRequests()).toEqual([]);
  });
});

describe('resolveDecision is pure', () => {
  it('answers the same way for the same inputs, with no engine involved', () => {
    const rule: ScenarioRule = { id: 'r', match: { url: '**' }, patch: { a: 2 } };
    const params = {
      scenario: 'empty-forecast',
      mode: 'overlay' as ScenarioMode,
      request: get,
      selected: { rule, index: 0, occurrence: 1 },
      recorded: recordedJson({ a: 1, b: 2 }),
    };
    expect(resolveDecision(params)).toEqual(resolveDecision(params));
    expect(resolveDecision(params).attribution).toEqual({
      scenario: 'empty-forecast',
      ruleId: 'r',
      action: 'patch',
      bodyChanged: true,
    });
  });

  it('does not mutate the recorded response it patches', () => {
    const recorded = recordedJson({ a: 1 });
    const snapshot = structuredClone(recorded);
    resolveDecision({
      scenario: 's',
      mode: 'overlay',
      request: get,
      selected: { rule: { id: 'r', match: { url: '**' }, patch: { a: 9 } }, index: 0, occurrence: 1 },
      recorded,
    });
    expect(recorded).toEqual(snapshot);
  });
});
