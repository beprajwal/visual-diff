import { describe, expect, it } from 'vitest';

import {
  CAPTURED_ATTRS,
  DEFAULTS,
  DIFF_ENGINE_VERSION,
  EXIT,
  FINDING_KINDS,
  FLOW_DIFF_STATUSES,
  FORBIDDEN_STEP_VERBS,
  JSON_PATCH_OPS,
  NETWORK_MODES,
  PAIR_LABELS,
  RESPONSE_VERBS,
  SCENARIO_ACTIONS,
  SCENARIO_MODES,
  SCENARIO_NONE,
  SEVERITIES,
  SEVERITY_ORDER,
  STEP_VERBS,
  STYLE_PROPS,
  type FlowNetwork,
  type JsonPatchOperation,
  type MergePatch,
  type NetworkEntry,
  type PairScenarios,
  type RespondSpec,
  type RunMeta,
  type RunOptions,
  type RunWarning,
  type ScenarioCheckResult,
  type ScenarioListResult,
  type ScenarioNewResult,
  type ScenarioRule,
  type ScenarioSpec,
  type ScenarioSummary,
} from './types.js';

/**
 * These are contract assertions, not smoke tests. Every value below is named literally by the
 * design spec; if one of them moves, a stored run, a stored diff, or the agent-facing JSON API
 * changes meaning. The test pins them to the spec so the change has to be deliberate.
 */

describe('flow vocabulary (spec §6, D8)', () => {
  it('is exactly the closed verb list from the spec, in spec order', () => {
    expect([...STEP_VERBS]).toEqual([
      'goto',
      'click',
      'fill',
      'press',
      'hover',
      'scroll',
      'waitFor',
      'viewport',
      'mask',
      'shoot',
      'expect',
    ]);
  });

  it('names sleep-like verbs as forbidden rather than merely omitting them', () => {
    expect([...FORBIDDEN_STEP_VERBS]).toContain('sleep');
    expect([...FORBIDDEN_STEP_VERBS]).toEqual([
      'sleep',
      'wait',
      'waitForTimeout',
      'pause',
      'delay',
    ]);
  });

  it('keeps allowed and forbidden verbs disjoint', () => {
    const allowed = new Set<string>(STEP_VERBS);
    const overlap = FORBIDDEN_STEP_VERBS.filter((verb) => allowed.has(verb));
    expect(overlap).toEqual([]);
  });

  it('has no duplicate verbs', () => {
    expect(new Set<string>(STEP_VERBS).size).toBe(STEP_VERBS.length);
  });
});

describe('capture subsets (spec §7, §12)', () => {
  it('captures a closed, duplicate-free style subset', () => {
    expect(STYLE_PROPS.length).toBeGreaterThan(0);
    expect(new Set<string>(STYLE_PROPS).size).toBe(STYLE_PROPS.length);
  });

  it('includes the style properties the spec names explicitly', () => {
    for (const prop of [
      'color',
      'backgroundColor',
      'fontFamily',
      'fontSize',
      'borderRadius',
      'boxShadow',
      'display',
      'position',
      'opacity',
      'zIndex',
      'margin',
      'padding',
    ]) {
      expect(STYLE_PROPS).toContain(prop);
    }
  });

  it('retains every data-test attribute spelling, since testId is the strongest node key', () => {
    expect(CAPTURED_ATTRS).toContain('data-test');
    expect(CAPTURED_ATTRS).toContain('data-testid');
    expect(CAPTURED_ATTRS).toContain('data-test-id');
    expect(new Set<string>(CAPTURED_ATTRS).size).toBe(CAPTURED_ATTRS.length);
  });

  it('retains the accessibility attributes the a11y findings depend on', () => {
    for (const attr of ['role', 'aria-label', 'aria-labelledby', 'aria-hidden']) {
      expect(CAPTURED_ATTRS).toContain(attr);
    }
  });
});

describe('finding taxonomy (spec §8)', () => {
  it('is exactly the seven finding kinds', () => {
    expect([...FINDING_KINDS]).toEqual([
      'content',
      'style',
      'layout',
      'structural',
      'a11y',
      'console',
      'network',
    ]);
  });

  it('is exactly the six flow-diff buckets, so every step lands in one', () => {
    expect([...FLOW_DIFF_STATUSES]).toEqual([
      'matched',
      'added',
      'removed',
      'spec-changed',
      'failed',
      'blocked',
    ]);
  });

  it('orders severity high < med < low and covers every severity', () => {
    expect(Object.keys(SEVERITY_ORDER).sort()).toEqual([...SEVERITIES].sort());
    expect(SEVERITY_ORDER.high).toBeLessThan(SEVERITY_ORDER.med);
    expect(SEVERITY_ORDER.med).toBeLessThan(SEVERITY_ORDER.low);
  });

  it('sorts a mixed finding list high-first without dropping anything', () => {
    const severities = [...SEVERITIES, ...SEVERITIES].sort(
      (a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b],
    );
    expect(severities).toEqual(['high', 'high', 'med', 'med', 'low', 'low']);
  });
});

describe('exit codes (spec §9)', () => {
  it('maps success, run failure and config error to 0, 1, 2', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.RUN_FAILURE).toBe(1);
    expect(EXIT.CONFIG_ERROR).toBe(2);
  });
});

describe('defaults (spec §6, §7, §12)', () => {
  it('pins the capture defaults the determinism test depends on', () => {
    expect(DEFAULTS.deviceScaleFactor).toBe(2);
    expect(DEFAULTS.maxDomNodes).toBe(5000);
    expect(DEFAULTS.viewportConcurrency).toBe(2);
    expect(DEFAULTS.readyTimeoutMs).toBe(90_000);
    expect(DEFAULTS.serverLogTailLines).toBe(50);
  });

  it('pins the noise-control defaults', () => {
    expect(DEFAULTS.diff.minRegionArea).toBe(64);
    expect(DEFAULTS.diff.maxRegions).toBe(40);
    expect(DEFAULTS.diff.antialiasTolerance).toBeCloseTo(0.1, 10);
    expect(DEFAULTS.diff.ignore).toEqual([]);
  });

  it('ships both spec viewports and keeps them parseable as WIDTHxHEIGHT', () => {
    expect(DEFAULTS.viewports).toEqual(['1280x800', '390x844']);
    for (const id of DEFAULTS.viewports) {
      expect(id).toMatch(/^\d+x\d+$/);
    }
  });

  it('keeps 20 runs and scrubs HARs unless explicitly disabled', () => {
    expect(DEFAULTS.retention.keepRuns).toBe(20);
    expect(DEFAULTS.network.scrub).toBe(true);
    expect(DEFAULTS.network.redact).toEqual([]);
  });

  it('always drops the three credential headers, lower-cased for header matching', () => {
    expect(DEFAULTS.alwaysRedactHeaders).toEqual(['authorization', 'cookie', 'set-cookie']);
    for (const header of DEFAULTS.alwaysRedactHeaders) {
      expect(header).toBe(header.toLowerCase());
    }
  });

  it('exposes a diff engine version usable as part of the cache key', () => {
    expect(DIFF_ENGINE_VERSION).toBe('1');
    expect(typeof DIFF_ENGINE_VERSION).toBe('string');
  });
});

/*
 * Scenario contracts (API mocking spec). Same rule as above: every literal here is named by the
 * spec, and several of these assertions are compile-time — a `@ts-expect-error` that stops erroring
 * is itself a type error, so "exactly one response verb per rule" is enforced by `npm run
 * typecheck`, not merely by the validator.
 */

describe('network modes (mocking spec D13)', () => {
  it('adds mock alongside the slice-1 three, keeping the originals intact', () => {
    expect([...NETWORK_MODES]).toEqual(['record', 'replay', 'off', 'mock']);
    expect(new Set<string>(NETWORK_MODES).size).toBe(NETWORK_MODES.length);
  });

  it('is a structural label rather than an implicit fallback, so mock is namable in meta.json', () => {
    expect(NETWORK_MODES).toContain('mock');
  });
});

describe('scenario vocabulary (mocking spec §5)', () => {
  it('has exactly two modes: overlay patches a recording, mock has none', () => {
    expect([...SCENARIO_MODES]).toEqual(['overlay', 'mock']);
  });

  it('has exactly four response verbs, with delay deliberately absent as a modifier', () => {
    expect([...RESPONSE_VERBS]).toEqual(['patch', 'patchOps', 'respond', 'abort']);
    expect(RESPONSE_VERBS).not.toContain('delay');
  });

  it('reserves "none" as the scenario of a run captured without one', () => {
    expect(SCENARIO_NONE).toBe('none');
    expect(DEFAULTS.scenarioNone).toBe(SCENARIO_NONE);
  });

  it('defaults an omitted scenario mode to overlay', () => {
    expect(DEFAULTS.scenarioMode).toBe('overlay');
    expect(SCENARIO_MODES).toContain(DEFAULTS.scenarioMode);
  });
});

describe('JSON Patch (RFC 6902, mocking spec §5, §11)', () => {
  it('is exactly the six RFC 6902 operations', () => {
    expect([...JSON_PATCH_OPS]).toEqual(['add', 'remove', 'replace', 'move', 'copy', 'test']);
  });

  it('requires value on add, replace and test, and from on move and copy', () => {
    const ops: JsonPatchOperation[] = [
      { op: 'add', path: '/daily/time/0', value: '2026-08-10' },
      { op: 'remove', path: '/daily/time/0' },
      { op: 'replace', path: '/daily/weather_code/0', value: 95 },
      { op: 'move', path: '/b', from: '/a' },
      { op: 'copy', path: '/b', from: '/a' },
      { op: 'test', path: '/a', value: null },
    ];

    expect(ops.map((op) => op.op)).toEqual([...JSON_PATCH_OPS]);
  });

  it('rejects an op missing the member the RFC requires', () => {
    // @ts-expect-error move without `from` is a malformed RFC 6902 op (mocking spec §8)
    const malformed: JsonPatchOperation = { op: 'move', path: '/b' };
    expect(malformed.op).toBe('move');
  });

  it('rejects an operation name outside the six', () => {
    // @ts-expect-error `merge` is not an RFC 6902 op
    const malformed: JsonPatchOperation = { op: 'merge', path: '/a', value: 1 };
    expect(malformed.path).toBe('/a');
  });
});

describe('scenario rules (mocking spec §5)', () => {
  it('accepts each response verb on its own', () => {
    const rules: ScenarioRule[] = [
      {
        id: 'forecast-empty',
        match: { method: 'GET', url: '**/v1/forecast**' },
        patch: { hourly: { temperature_2m: [] } },
      },
      {
        id: 'first-day-removed',
        match: { url: '**/v1/forecast**' },
        patchOps: [
          { op: 'remove', path: '/daily/time/0' },
          { op: 'replace', path: '/daily/weather_code/0', value: 95 },
        ],
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
      { id: 'no-analytics', match: { url: '**/analytics/**' }, abort: true },
    ];

    expect(rules.map((rule) => rule.id)).toEqual([
      'forecast-empty',
      'first-day-removed',
      'geocode-fails',
      'no-analytics',
    ]);
  });

  it('accepts delay as a modifier on its own, passing the recorded response through late', () => {
    const slow: ScenarioRule = { id: 'slow-air-quality', match: { url: '**/v1/air-quality**' }, delay: 3000 };
    expect(slow.delay).toBe(3000);
  });

  it('accepts delay composed with a response verb', () => {
    const both: ScenarioRule = {
      id: 'slow-and-empty',
      match: { url: '**/v1/forecast**' },
      delay: 3000,
      patch: { hourly: null },
    };
    expect(both.delay).toBe(3000);
  });

  it('makes two response verbs on one rule a type error, not an invented precedence order', () => {
    // @ts-expect-error exactly one response verb per rule (mocking spec §5, §8)
    const twoVerbs: ScenarioRule = { id: 'two', match: { url: '**' }, patch: { a: 1 }, abort: true };
    expect(twoVerbs.id).toBe('two');
  });

  it('makes a rule that does nothing at all a type error', () => {
    // @ts-expect-error a rule needs a response verb or, at minimum, a delay
    const inert: ScenarioRule = { id: 'inert', match: { url: '**' } };
    expect(inert.id).toBe('inert');
  });

  it('requires match.url, since the glob is what a rule is', () => {
    // @ts-expect-error `match.url` is required (mocking spec §5, §8)
    const noUrl: ScenarioRule = { id: 'no-url', match: { method: 'GET' }, abort: true };
    expect(noUrl.id).toBe('no-url');
  });

  it('carries a scenario file with an id, a mode and ordered rules', () => {
    const spec: ScenarioSpec = {
      version: 1,
      scenario: 'empty-forecast',
      description: 'No forecast data, for checking the empty state',
      mode: 'overlay',
      rules: [{ id: 'forecast-empty', match: { url: '**/v1/forecast**' }, patch: { hourly: {} } }],
    };

    expect(spec.scenario).toBe('empty-forecast');
    expect(spec.rules).toHaveLength(1);
    expect(SCENARIO_MODES).toContain(spec.mode);
  });
});

describe('attribution and warnings (mocking spec §8)', () => {
  it('covers every response verb plus passthrough, delay and the mock-mode miss', () => {
    for (const verb of RESPONSE_VERBS) {
      expect(SCENARIO_ACTIONS).toContain(verb);
    }
    expect([...SCENARIO_ACTIONS]).toEqual([
      'passthrough',
      'patch',
      'patchOps',
      'respond',
      'abort',
      'delay',
      'miss',
    ]);
  });

  it('attributes a modified response to the scenario and rule that caused it', () => {
    const entry: NetworkEntry = {
      step: 'forecast',
      viewport: '1280x800',
      method: 'GET',
      url: 'https://api.open-meteo.com/v1/forecast?latitude=51.5',
      status: 200,
      resourceType: 'fetch',
      harMatch: 'hit',
      durationMs: 12,
      attribution: {
        scenario: 'empty-forecast',
        ruleId: 'forecast-empty',
        action: 'patch',
        bodyChanged: true,
      },
    };

    expect(entry.attribution?.ruleId).toBe('forecast-empty');
    expect(entry.attribution?.bodyChanged).toBe(true);
  });

  it('leaves attribution absent on a run with no scenario, so slice-1 network.json is unchanged', () => {
    const entry: NetworkEntry = {
      step: 'cart',
      viewport: '1280x800',
      method: 'GET',
      url: '/api/cart',
      status: 200,
      resourceType: 'fetch',
      harMatch: 'hit',
      durationMs: 4,
    };

    expect(entry.attribution).toBeUndefined();
  });

  it('names an unmatched request with no rule attached', () => {
    const unmatched: NetworkEntry['attribution'] = {
      scenario: 'empty-forecast',
      ruleId: null,
      action: 'passthrough',
      bodyChanged: false,
    };

    expect(unmatched.ruleId).toBeNull();
  });

  it('warns by rule id when a rule never matched, which is what stops the tool misleading a user', () => {
    const warning: RunWarning = {
      kind: 'scenario-rule-unmatched',
      message: "scenario 'empty-forecast': rule 'forecast-empty' never matched a request",
      rules: ['forecast-empty'],
    };

    expect(warning.kind).toBe('scenario-rule-unmatched');
    expect(warning.rules).toEqual(['forecast-empty']);
  });

  it('has a distinct warning for a mock-mode miss, where there is no HAR to have missed', () => {
    const warning: RunWarning = {
      kind: 'mock-miss',
      message: '1 request was aborted with no matching rule',
      urls: ['https://api.open-meteo.com/v1/air-quality'],
    };

    expect(warning.kind).toBe('mock-miss');
  });
});

describe('pair labelling (mocking spec §6)', () => {
  it('names exactly the two pairings that are permitted but must not read as regressions', () => {
    expect([...PAIR_LABELS]).toEqual(['cross-scenario', 'mock-vs-recorded']);
  });

  it('labels a same-scenario pair with neither flag', () => {
    const pair: PairScenarios = {
      base: 'empty-forecast',
      head: 'empty-forecast',
      crossScenario: false,
      mockVsRecorded: false,
    };

    expect(pair.crossScenario).toBe(false);
    expect(pair.mockVsRecorded).toBe(false);
  });

  it('labels a pair of different scenarios cross-scenario', () => {
    const pair: PairScenarios = {
      base: SCENARIO_NONE,
      head: 'empty-forecast',
      crossScenario: true,
      mockVsRecorded: false,
    };

    expect(pair.crossScenario).toBe(true);
  });

  it('labels a mock run paired against a recorded one', () => {
    const pair: PairScenarios = {
      base: 'wireframe',
      head: SCENARIO_NONE,
      crossScenario: true,
      mockVsRecorded: true,
    };

    expect(pair.mockVsRecorded).toBe(true);
  });
});

describe('request matching and response bodies (mocking spec §5, §11)', () => {
  it('makes method optional and url required, since the glob is applied to the full URL', () => {
    const anyMethod: ScenarioRule = {
      id: 'any-method',
      match: { url: 'https://api.open-meteo.com/v1/forecast?*latitude*' },
      abort: true,
    };

    expect(anyMethod.match.method).toBeUndefined();
    expect(anyMethod.match.url).toContain('?');
  });

  it('selects the nth occurrence of an otherwise identical request', () => {
    const second: ScenarioRule = {
      id: 'second-poll',
      match: { method: 'GET', url: '**/v1/forecast**', nth: 2 },
      respond: { status: 503 },
    };

    expect(second.match.nth).toBe(2);
  });

  it('accepts an object, a string or a base64 blob as respond.body', () => {
    const asJson: RespondSpec = { status: 200, body: { error: 'upstream_unavailable' } };
    const asText: RespondSpec = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'nope' };
    const asBinary: RespondSpec = { status: 200, body: { base64: 'aGVsbG8=' } };

    expect(asJson.body).toEqual({ error: 'upstream_unavailable' });
    expect(asText.body).toBe('nope');
    expect(asBinary.body).toEqual({ base64: 'aGVsbG8=' });
  });

  it('allows a bodiless respond, so a bare status can be returned', () => {
    const noContent: RespondSpec = { status: 204 };
    expect(noContent.body).toBeUndefined();
  });

  it('lets a merge patch delete a key with null, per RFC 7386', () => {
    const deletion: MergePatch = { hourly: { temperature_2m: null } };
    const replacement: MergePatch = [];

    expect(deletion).toEqual({ hourly: { temperature_2m: null } });
    expect(replacement).toEqual([]);
  });
});

describe('run identity under a scenario (mocking spec §6, §7, D12, D13)', () => {
  const meta: RunMeta = {
    runId: '0007',
    flow: 'forecast',
    scenario: 'empty-forecast',
    flowHash: 'sha256:abc',
    revision: { sha: '9f8e7d6', ref: 'main', dirty: false },
    mode: 'spawn',
    network: 'replay',
    harHits: 12,
    harMisses: 0,
    viewports: ['1280x800'],
    status: 'ok',
    failedSteps: [],
    env: {
      tool: '0.1.0',
      node: 'v20.11.0',
      playwright: '1.49.0',
      chromium: '131',
      os: 'darwin',
      deviceScaleFactor: 2,
    },
    startedAt: '2026-08-10T00:00:00.000Z',
    finishedAt: '2026-08-10T00:00:20.000Z',
    unstable: false,
    pinned: false,
    pruned: false,
    warnings: [],
  };

  it('records the scenario in meta.json rather than in the run path', () => {
    expect(meta.scenario).toBe('empty-forecast');
    expect(meta.runId).toBe('0007');
  });

  it('requires the scenario field, so no run is silently of unknown scenario', () => {
    const { scenario: _omitted, ...withoutScenario } = meta;
    // @ts-expect-error scenario is the third axis of run identity, never optional (mocking spec §6)
    const incomplete: RunMeta = withoutScenario;
    expect(incomplete.runId).toBe('0007');
  });

  it('reads a slice-1 run as the reserved none scenario', () => {
    const sliceOne: RunMeta = { ...meta, scenario: SCENARIO_NONE, network: 'off' };
    expect(sliceOne.scenario).toBe(SCENARIO_NONE);
  });

  it('labels a mock-only run structurally in meta.json', () => {
    const mocked: RunMeta = { ...meta, scenario: 'wireframe', network: 'mock', harHits: 0 };
    expect(mocked.network).toBe('mock');
  });

  it('needs no har for a mock-mode flow, unlike record and replay', () => {
    const mocked: FlowNetwork = { mode: 'mock' };
    const replayed: FlowNetwork = { mode: 'replay', har: 'weather.har' };

    expect(mocked.har).toBeUndefined();
    expect(replayed.har).toBe('weather.har');
  });

  it('carries the scenario as a run option, absent meaning none', () => {
    const under: RunOptions = { flow: 'forecast', scenario: 'empty-forecast' };
    const without: RunOptions = { flow: 'forecast' };

    expect(under.scenario).toBe('empty-forecast');
    expect(without.scenario).toBeUndefined();
  });
});

describe('scenario subcommand contracts (mocking spec §7)', () => {
  const summary: ScenarioSummary = {
    name: 'empty-forecast',
    mode: 'overlay',
    description: 'No forecast data, for checking the empty state',
    ruleCount: 2,
    path: 'scenarios/empty-forecast.yaml',
  };

  it('scaffolds a scenario at a path under the .visual-diff directory', () => {
    const created: ScenarioNewResult = {
      scenario: 'empty-forecast',
      path: 'scenarios/empty-forecast.yaml',
      mode: 'overlay',
    };

    expect(created.path).toBe(`scenarios/${created.scenario}.yaml`);
    expect(created.mode).toBe(DEFAULTS.scenarioMode);
  });

  it('reports a passing check with its warnings, failures travelling as a CliError instead', () => {
    const checked: ScenarioCheckResult = { scenario: summary, warnings: [] };

    expect(checked.scenario.name).toBe('empty-forecast');
    expect(checked.warnings).toEqual([]);
  });

  it('enumerates scenarios with their modes, which is what list exists to show', () => {
    const listed: ScenarioListResult = {
      scenarios: [summary, { name: 'wireframe', mode: 'mock', ruleCount: 5, path: 'scenarios/wireframe.yaml' }],
    };

    expect(listed.scenarios.map((entry) => entry.mode)).toEqual(['overlay', 'mock']);
    expect(listed.scenarios.every((entry) => SCENARIO_MODES.includes(entry.mode))).toBe(true);
  });
});
