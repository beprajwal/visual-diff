/**
 * Scenario execution in the runner (mocking spec §5, §8, §11).
 *
 * Two assertions carry this file:
 *
 *  - **`mock` never falls through.** `route.fallback()` with nothing registered behind it continues
 *    to the live network, which is the bug D13 exists to prevent, so the mock matrix below asserts
 *    the *absence* of that call for every kind of request.
 *  - **A rule that did nothing says so.** The never-matched warning is what stands between a user
 *    and a screenshot of the recorded state they believe is the empty state (§8), so its text is
 *    asserted, not merely its presence.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT, SCENARIO_NONE, type ScenarioSpec } from '../types.js';
import { ScenarioEngine } from '../mocking/index.js';
import { paths } from '../store/index.js';

import { RunnerError } from './errors.js';
import { indexHar, type HarIndex } from './har.js';
import {
  MOCK_ONLY_SPEC,
  ScenarioRuntime,
  assertRecordScenarioExclusive,
  assertRunnableScenarioName,
  buildScenarioRuntime,
  isAppOriginUrl,
  mockMissMessage,
  resolveScenario,
  scenarioFile,
  toRunnerError,
  unmatchedRuleIds,
  unmatchedRulesMessage,
  type RouteLike,
} from './scenario.js';

/* ------------------------------------------------------------------ fakes */

type Verdict =
  | { kind: 'none' }
  | { kind: 'abort'; errorCode?: string }
  | { kind: 'continue' }
  | { kind: 'fallback' }
  | { kind: 'fulfill'; status?: number; headers?: Record<string, string>; body?: string };

class FakeRoute implements RouteLike {
  verdict: Verdict = { kind: 'none' };
  readonly calls: string[] = [];
  /** One object per route, as Playwright's `Request` is: the runtime keys attribution on it. */
  readonly raw: { url(): string; method(): string };

  constructor(
    readonly method: string,
    readonly url: string,
  ) {
    this.raw = { url: () => url, method: () => method };
  }

  request(): { url(): string; method(): string } {
    return this.raw;
  }

  async abort(errorCode?: string): Promise<void> {
    this.calls.push('abort');
    this.verdict = errorCode === undefined ? { kind: 'abort' } : { kind: 'abort', errorCode };
  }

  async continue(): Promise<void> {
    this.calls.push('continue');
    this.verdict = { kind: 'continue' };
  }

  async fallback(): Promise<void> {
    this.calls.push('fallback');
    this.verdict = { kind: 'fallback' };
  }

  async fulfill(options: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
  }): Promise<void> {
    this.calls.push('fulfill');
    this.verdict = {
      kind: 'fulfill',
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { body: options.body.toString() }),
    };
  }
}

const FORECAST_URL = 'https://api.example.test/v1/forecast?lat=1&lon=2';
const SEARCH_URL = 'https://api.example.test/v1/search?name=lisbon';
const APP_URL = 'http://127.0.0.1:5173/index.html';

const FORECAST_BODY = { hourly: { time: ['00:00', '01:00'], temperature_2m: [17.4, 17.1] } };

function harSource(
  entries: Array<{ url: string; method?: string; status?: number; mimeType?: string; text?: string }>,
): string {
  return JSON.stringify({
    log: {
      version: '1.2',
      entries: entries.map((entry) => ({
        request: { method: entry.method ?? 'GET', url: entry.url },
        response: {
          status: entry.status ?? 200,
          headers: [
            { name: 'Content-Type', value: entry.mimeType ?? 'application/json' },
            { name: 'Content-Length', value: String((entry.text ?? '').length) },
          ],
          content: { mimeType: entry.mimeType ?? 'application/json', text: entry.text ?? '' },
        },
      })),
    },
  });
}

const forecastHar: HarIndex = indexHar(
  harSource([{ url: FORECAST_URL, text: JSON.stringify(FORECAST_BODY) }]),
);

function spec(overrides: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return { version: 1, scenario: 'empty-forecast', mode: 'overlay', rules: [], ...overrides };
}

interface DriveResult {
  route: FakeRoute;
  runtime: ScenarioRuntime;
}

function runtimeFor(
  scenarioSpec: ScenarioSpec,
  options: { har?: HarIndex; sleep?: (ms: number) => Promise<void> } = {},
): ScenarioRuntime {
  return new ScenarioRuntime({
    engine: new ScenarioEngine(scenarioSpec),
    ...(options.har === undefined ? {} : { har: options.har }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

async function drive(
  runtime: ScenarioRuntime,
  url: string,
  method = 'GET',
): Promise<DriveResult> {
  const route = new FakeRoute(method, url);
  await runtime.handle(route);
  return { route, runtime };
}

/* ------------------------------------------------------------------ names */

describe('assertRunnableScenarioName', () => {
  it('accepts a usable name unchanged', () => {
    expect(assertRunnableScenarioName('empty-forecast')).toBe('empty-forecast');
  });

  it('refuses the reserved name, because meta.json records it for a run with no scenario', () => {
    let thrown: unknown;
    try {
      assertRunnableScenarioName(SCENARIO_NONE);
    } catch (error) {
      thrown = error;
    }
    expect(RunnerError.is(thrown)).toBe(true);
    const error = thrown as RunnerError;
    expect(error.code).toBe('reserved-scenario-name');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.kind).toBe('scenario-invalid');
    expect(error.message).toContain("'none' is a reserved scenario name");
    expect(error.message).toContain('meta.json');
    expect(error.hint).toContain('drop --scenario');
  });

  it('refuses a name that could escape its directory', () => {
    expect(() => assertRunnableScenarioName('../etc/passwd')).toThrow(/invalid scenario name/);
  });
});

describe('scenarioFile', () => {
  it('is .visual-diff/scenarios/<name>.yaml, alongside flows', () => {
    expect(scenarioFile('/repo', 'empty-forecast')).toBe(
      `${paths.vdiffDir('/repo')}/scenarios/empty-forecast.yaml`,
    );
  });
});

/* ------------------------------------------------------------------ resolution */

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectWith(name: string, source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vdiff-scenario-'));
  tempDirs.push(root);
  const file = scenarioFile(root, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source, 'utf8');
  return root;
}

const VALID_SOURCE = `version: 1
scenario: empty-forecast
mode: overlay
rules:
  - id: forecast-empty
    match: { url: "**/v1/forecast**" }
    patch: { hourly: { temperature_2m: [] } }
`;

describe('resolveScenario', () => {
  it('reads and validates the committed spec on the fast path', async () => {
    const root = await projectWith('empty-forecast', VALID_SOURCE);
    const plan = await resolveScenario({ name: 'empty-forecast', root, gitRoot: root });
    expect(plan.name).toBe('empty-forecast');
    expect(plan.mode).toBe('overlay');
    expect(plan.spec.rules.map((rule) => rule.id)).toEqual(['forecast-empty']);
    expect(plan.file).toBe(scenarioFile(root, 'empty-forecast'));
  });

  it('names the file it looked for when the scenario does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vdiff-scenario-'));
    tempDirs.push(root);
    let thrown: unknown;
    try {
      await resolveScenario({ name: 'empty-forecast', root, gitRoot: root });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as RunnerError;
    expect(RunnerError.is(thrown)).toBe(true);
    expect(error.code).toBe('scenario-missing');
    expect(error.kind).toBe('scenario-missing');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.message).toBe(`no scenario spec at ${scenarioFile(root, 'empty-forecast')}`);
    expect(error.hint).toBe('create it with `vdiff scenario new empty-forecast`');
  });

  /* D4: the scenario a historical replay uses is the one committed at that SHA, not today's. */
  it('reads the spec out of git history at the target SHA', async () => {
    const seen: Array<[string, string, string]> = [];
    const plan = await resolveScenario({
      name: 'empty-forecast',
      root: '/project',
      gitRoot: '/repo',
      sha: '1234567890abcdef',
      readAtRev: async (gitRoot, sha, path) => {
        seen.push([gitRoot, sha, path]);
        return VALID_SOURCE;
      },
    });
    expect(seen).toEqual([
      ['/repo', '1234567890abcdef', '.visual-diff/scenarios/empty-forecast.yaml'],
    ]);
    expect(plan.file).toBe('.visual-diff/scenarios/empty-forecast.yaml@1234567');
  });

  it('rejects a scenario absent at that SHA cleanly, as a missing flow is under D4', async () => {
    let thrown: unknown;
    try {
      await resolveScenario({
        name: 'empty-forecast',
        root: '/project',
        gitRoot: '/repo',
        sha: '1234567890abcdef',
        readAtRev: async () => null,
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as RunnerError;
    expect(error.code).toBe('scenario-missing-at-rev');
    expect(error.kind).toBe('scenario-missing');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.message).toBe(
      'scenario "empty-forecast" did not exist at 1234567: .visual-diff/scenarios/empty-forecast.yaml',
    );
    expect(error.hint).toContain('replay HEAD');
  });

  it('reports file, line and offending key for an invalid spec (§8)', async () => {
    const root = await projectWith(
      'broken',
      `version: 1
scenario: broken
rules:
  - id: two-verbs
    match: { url: "**/v1/forecast**" }
    patch: { a: 1 }
    abort: true
`,
    );
    let thrown: unknown;
    try {
      await resolveScenario({ name: 'broken', root, gitRoot: root });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as RunnerError;
    expect(RunnerError.is(thrown)).toBe(true);
    expect(error.kind).toBe('scenario-invalid');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.message).toContain('broken.yaml:');
    expect(error.message).toMatch(/rules\[0\]/);
  });

  it('refuses a spec whose `scenario:` disagrees with its filename (§8)', async () => {
    const root = await projectWith(
      'empty-forecast',
      VALID_SOURCE.replace('scenario: empty-forecast', 'scenario: something-else'),
    );
    await expect(resolveScenario({ name: 'empty-forecast', root, gitRoot: root })).rejects.toThrow(
      /something-else/,
    );
  });

  it('refuses the reserved name before touching the disk', async () => {
    await expect(
      resolveScenario({ name: SCENARIO_NONE, root: '/nowhere', gitRoot: '/nowhere' }),
    ).rejects.toThrow(/reserved scenario name/);
  });
});

/* ------------------------------------------------------------------ overlay execution */

describe('ScenarioRuntime in overlay mode', () => {
  it('hands an unmatched request to the recording and attributes it as a passthrough', async () => {
    const runtime = runtimeFor(spec(), { har: forecastHar });
    const { route } = await drive(runtime, SEARCH_URL);
    expect(route.verdict).toEqual({ kind: 'fallback' });
    expect(runtime.attributionFor({}, 'GET', SEARCH_URL)).toEqual({
      scenario: 'empty-forecast',
      ruleId: null,
      action: 'passthrough',
      bodyChanged: false,
    });
  });

  it('aborts a request an `abort` rule claimed, and does not call it a HAR miss', async () => {
    const runtime = runtimeFor(
      spec({
        rules: [{ id: 'no-analytics', match: { url: '**/v1/search**' }, abort: true }],
      }),
    );
    const { route } = await drive(runtime, SEARCH_URL);
    expect(route.verdict).toEqual({ kind: 'abort', errorCode: 'blockedbyclient' });
    expect(runtime.attributionFor({}, 'GET', SEARCH_URL)?.action).toBe('abort');
    expect(runtime.ruleFailures()).toEqual([]);
  });

  it('serves a `respond` rule wholesale, JSON-typed without the header being spelled out', async () => {
    const runtime = runtimeFor(
      spec({
        rules: [
          {
            id: 'geocode-fails',
            match: { method: 'GET', url: '**/v1/search**' },
            respond: { status: 500, body: { error: 'upstream_unavailable' } },
          },
        ],
      }),
    );
    const { route } = await drive(runtime, SEARCH_URL);
    expect(route.verdict).toMatchObject({
      kind: 'fulfill',
      status: 500,
      body: '{"error":"upstream_unavailable"}',
    });
    expect((route.verdict as { headers: Record<string, string> }).headers['content-type']).toBe(
      'application/json',
    );
    expect(runtime.attributionFor({}, 'GET', SEARCH_URL)).toMatchObject({
      ruleId: 'geocode-fails',
      action: 'respond',
      bodyChanged: true,
    });
  });

  it('applies a merge patch to the recorded body and drops the headers it invalidates', async () => {
    const runtime = runtimeFor(
      spec({
        rules: [
          {
            id: 'forecast-empty',
            match: { url: '**/v1/forecast**' },
            patch: { hourly: { temperature_2m: [] } },
          },
        ],
      }),
      { har: forecastHar },
    );
    const { route } = await drive(runtime, FORECAST_URL);
    const verdict = route.verdict as { kind: string; status: number; headers: Record<string, string>; body: string };
    expect(verdict.kind).toBe('fulfill');
    expect(verdict.status).toBe(200);
    expect(JSON.parse(verdict.body)).toEqual({
      hourly: { time: ['00:00', '01:00'], temperature_2m: [] },
    });
    // A stale content-length truncates the body in the browser, silently, as a blank region.
    expect(verdict.headers['content-length']).toBeUndefined();
    expect(runtime.attributionFor({}, 'GET', FORECAST_URL)).toMatchObject({
      ruleId: 'forecast-empty',
      action: 'patch',
      bodyChanged: true,
    });
  });

  it('applies patchOps for the array surgery merge patch cannot express', async () => {
    const runtime = runtimeFor(
      spec({
        rules: [
          {
            id: 'first-hour-removed',
            match: { url: '**/v1/forecast**' },
            patchOps: [{ op: 'remove', path: '/hourly/time/0' }],
          },
        ],
      }),
      { har: forecastHar },
    );
    const { route } = await drive(runtime, FORECAST_URL);
    const body = JSON.parse((route.verdict as { body: string }).body) as typeof FORECAST_BODY;
    expect(body.hourly.time).toEqual(['01:00']);
    expect(runtime.attributionFor({}, 'GET', FORECAST_URL)?.action).toBe('patchOps');
  });

  it('reports bodyChanged: false when a patch changed nothing, so the report does not overclaim', async () => {
    const runtime = runtimeFor(
      spec({
        rules: [
          {
            id: 'no-op',
            match: { url: '**/v1/forecast**' },
            patch: { hourly: { time: ['00:00', '01:00'] } },
          },
        ],
      }),
      { har: forecastHar },
    );
    await drive(runtime, FORECAST_URL);
    expect(runtime.attributionFor({}, 'GET', FORECAST_URL)?.bodyChanged).toBe(false);
  });

  /* §8: "rule matched a request with no recorded response — run fails, naming rule and URL". */
  it('fails the run — naming rule and URL — when the recording has nothing to patch', async () => {
    const runtime = runtimeFor(
      spec({
        rules: [{ id: 'forecast-empty', match: { url: '**/v1/**' }, patch: { a: 1 } }],
      }),
      { har: forecastHar },
    );
    const { route } = await drive(runtime, SEARCH_URL);
    const failure = runtime.ruleFailures()[0];
    expect(failure?.code).toBe('scenario-no-recorded-response');
    expect(failure?.message).toContain("rule 'forecast-empty'");
    expect(failure?.message).toContain(SEARCH_URL);
    // Failing must never mean releasing the request: it is aborted, not sent.
    expect(route.verdict).toEqual({ kind: 'abort', errorCode: 'blockedbyclient' });
    expect(route.calls).not.toContain('fallback');
  });

  it('fails the run — naming the content type — when the recorded body is not JSON', async () => {
    const har = indexHar(
      harSource([{ url: FORECAST_URL, mimeType: 'text/html', text: '<!doctype html>' }]),
    );
    const runtime = runtimeFor(
      spec({ rules: [{ id: 'forecast-empty', match: { url: '**/v1/forecast**' }, patch: { a: 1 } }] }),
      { har },
    );
    await drive(runtime, FORECAST_URL);
    const failure = runtime.ruleFailures()[0];
    expect(failure?.code).toBe('scenario-patch-non-json');
    expect(failure?.message).toContain("rule 'forecast-empty'");
    expect(failure?.message).toContain("'text/html'");
  });

  it('fails the run when a patchOp cannot be applied to the recorded body', async () => {
    const runtime = runtimeFor(
      spec({
        rules: [
          {
            id: 'bad-op',
            match: { url: '**/v1/forecast**' },
            patchOps: [{ op: 'remove', path: '/daily/time/0' }],
          },
        ],
      }),
      { har: forecastHar },
    );
    await drive(runtime, FORECAST_URL);
    expect(runtime.ruleFailures()[0]?.code).toBe('scenario-patch-op-failed');
    expect(runtime.ruleFailures()[0]?.message).toContain("rule 'bad-op'");
  });
});

/* ------------------------------------------------------------------ delay (§11) */

describe('delay', () => {
  it('defers the fulfilment, and passes the recorded response through late', async () => {
    const slept: number[] = [];
    const runtime = runtimeFor(
      spec({
        rules: [{ id: 'slow-forecast', match: { url: '**/v1/forecast**' }, delay: 3000 }],
      }),
      {
        har: forecastHar,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    const { route } = await drive(runtime, FORECAST_URL);
    expect(slept).toEqual([3000]);
    expect(route.verdict).toEqual({ kind: 'fallback' });
    expect(runtime.attributionFor({}, 'GET', FORECAST_URL)).toMatchObject({
      ruleId: 'slow-forecast',
      action: 'delay',
      bodyChanged: false,
    });
  });

  /*
   * §11: "`delay` is implemented by deferring the route fulfilment, not by sleeping the runner, so
   * concurrent viewports are unaffected." Two runtimes standing in for two viewports must overlap;
   * a runner-level sleep would serialize them.
   */
  it('does not serialize concurrent viewports', async () => {
    const order: string[] = [];
    const build = (label: string): ScenarioRuntime =>
      runtimeFor(
        spec({ rules: [{ id: 'slow', match: { url: '**/v1/**' }, delay: 20 }] }),
        {
          har: forecastHar,
          sleep: async (ms) => {
            order.push(`${label}:start`);
            await new Promise((resolve) => setTimeout(resolve, ms));
            order.push(`${label}:end`);
          },
        },
      );

    await Promise.all([drive(build('a'), FORECAST_URL), drive(build('b'), FORECAST_URL)]);
    // Both delays are in flight at once: the second starts before the first ends.
    expect(order.slice(0, 2).sort()).toEqual(['a:start', 'b:start']);
  });

  it('composes with a verb rather than replacing it', async () => {
    const slept: number[] = [];
    const runtime = runtimeFor(
      spec({
        rules: [
          {
            id: 'slow-500',
            match: { url: '**/v1/search**' },
            delay: 500,
            respond: { status: 503 },
          },
        ],
      }),
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    const { route } = await drive(runtime, SEARCH_URL);
    expect(slept).toEqual([500]);
    expect(route.verdict).toMatchObject({ kind: 'fulfill', status: 503 });
  });
});

/* ------------------------------------------------------------------ mock mode (D13) */

describe('ScenarioRuntime in mock mode', () => {
  const mockSpec = (rules: ScenarioSpec['rules'] = []): ScenarioSpec =>
    spec({ scenario: 'no-backend', mode: 'mock', rules });

  it('aborts an unmatched request and reports it as a miss — there is no recording behind it', async () => {
    const runtime = runtimeFor(mockSpec());
    const { route } = await drive(runtime, FORECAST_URL);
    expect(route.verdict).toEqual({ kind: 'abort', errorCode: 'blockedbyclient' });
    expect(runtime.attributionFor({}, 'GET', FORECAST_URL)).toEqual({
      scenario: 'no-backend',
      ruleId: null,
      action: 'miss',
      bodyChanged: false,
    });
  });

  it('lets the app itself load: mock replaces the network, not the dev server', async () => {
    const runtime = runtimeFor(mockSpec());
    const { route } = await drive(runtime, APP_URL);
    expect(route.verdict).toEqual({ kind: 'continue' });
    expect(runtime.attributionFor({}, 'GET', APP_URL)?.action).toBe('passthrough');
  });

  it('still lets a rule claim a same-origin URL, so the app assets are not a blanket exemption', async () => {
    const runtime = runtimeFor(
      mockSpec([
        {
          id: 'local-api',
          match: { url: '**/api/**' },
          respond: { status: 200, body: { items: [] } },
        },
      ]),
    );
    const { route } = await drive(runtime, 'http://127.0.0.1:5173/api/items');
    expect(route.verdict).toMatchObject({ kind: 'fulfill', status: 200, body: '{"items":[]}' });
  });

  it('serves a `respond` rule with no recording at all', async () => {
    const runtime = runtimeFor(
      mockSpec([
        {
          id: 'forecast',
          match: { url: '**/v1/forecast**' },
          respond: { status: 200, body: FORECAST_BODY },
        },
      ]),
    );
    const { route } = await drive(runtime, FORECAST_URL);
    expect(JSON.parse((route.verdict as { body: string }).body)).toEqual(FORECAST_BODY);
  });

  /*
   * The guard this file exists for. `route.fallback()` with nothing registered behind it continues
   * to the live network — the fallthrough D13 names. In mock mode there is nothing behind it, so
   * the call must never happen, whatever the request or the rule.
   */
  it.each([
    ['unmatched remote', FORECAST_URL, [] as ScenarioSpec['rules']],
    ['app origin', APP_URL, [] as ScenarioSpec['rules']],
    ['delay-only rule', FORECAST_URL, [{ id: 'slow', match: { url: '**' }, delay: 1 }] as ScenarioSpec['rules']],
    ['abort rule', FORECAST_URL, [{ id: 'no', match: { url: '**' }, abort: true }] as ScenarioSpec['rules']],
    [
      'respond rule',
      FORECAST_URL,
      [{ id: 'yes', match: { url: '**' }, respond: { status: 204 } }] as ScenarioSpec['rules'],
    ],
  ])('never falls through to the live network: %s', async (_label, url, rules) => {
    const runtime = runtimeFor(mockSpec(rules), { sleep: async () => undefined });
    const { route } = await drive(runtime, url);
    expect(route.calls).not.toContain('fallback');
    expect(route.verdict.kind).not.toBe('none');
  });

  it('attributes a delay-only rule that had nothing to serve to the rule, not to the glob', async () => {
    const runtime = runtimeFor(mockSpec([{ id: 'slow', match: { url: '**/v1/**' }, delay: 1 }]), {
      sleep: async () => undefined,
    });
    await drive(runtime, FORECAST_URL);
    expect(runtime.attributionFor({}, 'GET', FORECAST_URL)).toMatchObject({
      ruleId: 'slow',
      action: 'miss',
    });
  });
});

describe('buildScenarioRuntime', () => {
  it('builds the rule-less mock runtime when a run has no scenario at all', async () => {
    const runtime = buildScenarioRuntime();
    expect(runtime.scenario).toBe(SCENARIO_NONE);
    expect(runtime.mode).toBe('mock');
    expect(MOCK_ONLY_SPEC.rules).toEqual([]);
    const { route } = await drive(runtime, FORECAST_URL);
    expect(route.verdict).toEqual({ kind: 'abort', errorCode: 'blockedbyclient' });
    expect((await drive(runtime, APP_URL)).route.verdict).toEqual({ kind: 'continue' });
  });

  it('builds one engine per call, so two viewports never share an `nth` counter', async () => {
    const rules: ScenarioSpec['rules'] = [
      { id: 'second-only', match: { url: '**/v1/search**', nth: 2 }, respond: { status: 418 } },
    ];
    const plan = { name: 'x', mode: 'overlay' as const, spec: spec({ rules }), file: 'x.yaml' };
    const desktop = buildScenarioRuntime({ plan });
    const mobile = buildScenarioRuntime({ plan });

    // Each viewport's first request is *its* first occurrence, so neither triggers `nth: 2`.
    expect((await drive(desktop, SEARCH_URL)).route.verdict).toEqual({ kind: 'fallback' });
    expect((await drive(mobile, SEARCH_URL)).route.verdict).toEqual({ kind: 'fallback' });
    // And each viewport's second request does.
    expect((await drive(desktop, SEARCH_URL)).route.verdict).toMatchObject({ status: 418 });
    expect((await drive(mobile, SEARCH_URL)).route.verdict).toMatchObject({ status: 418 });
  });
});

/* ------------------------------------------------------------------ attribution plumbing */

describe('attributionFor', () => {
  it('finds the attribution by request identity, which is the exact route', async () => {
    const runtime = runtimeFor(spec());
    const route = new FakeRoute('GET', SEARCH_URL);
    await runtime.handle(route);
    // Identity, not the (method, url) queue: the same request answered twice would consume it.
    expect(runtime.attributionFor(route.raw, 'GET', SEARCH_URL)?.action).toBe('passthrough');
    expect(runtime.attributionFor(route.raw, 'GET', SEARCH_URL)?.action).toBe('passthrough');
  });

  it('falls back to (method, url) in order, so attribution is never silently lost', async () => {
    const runtime = runtimeFor(
      spec({
        rules: [
          { id: 'first', match: { url: '**/v1/search**', nth: 1 }, respond: { status: 500 } },
          { id: 'second', match: { url: '**/v1/search**', nth: 2 }, abort: true },
        ],
      }),
    );
    await drive(runtime, SEARCH_URL);
    await drive(runtime, SEARCH_URL);
    // An unrelated object forces the queue path; the two requests come back in the order they ran.
    expect(runtime.attributionFor({}, 'GET', SEARCH_URL)?.ruleId).toBe('first');
    expect(runtime.attributionFor({}, 'GET', SEARCH_URL)?.ruleId).toBe('second');
    expect(runtime.attributionFor({}, 'GET', SEARCH_URL)).toBeUndefined();
  });

  it('is undefined for a request this runtime never saw', () => {
    expect(runtimeFor(spec()).attributionFor({}, 'GET', 'https://elsewhere.test/')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ run-level reporting */

describe('unmatchedRuleIds', () => {
  const threeRules = spec({
    rules: [
      { id: 'a', match: { url: '**/a' }, abort: true },
      { id: 'b', match: { url: '**/b' }, abort: true },
      { id: 'c', match: { url: '**/c' }, abort: true },
    ],
  });

  it('is empty when every rule matched somewhere', () => {
    expect(unmatchedRuleIds(threeRules, [['a', 'b'], ['c']])).toEqual([]);
  });

  /* A rule keyed to a request the mobile layout never makes has still done its job on desktop. */
  it('counts a rule as matched when any viewport matched it', () => {
    expect(unmatchedRuleIds(threeRules, [['a'], ['a', 'b']])).toEqual(['c']);
  });

  it('reports every rule in file order when no viewport matched anything', () => {
    expect(unmatchedRuleIds(threeRules, [[], []])).toEqual(['a', 'b', 'c']);
  });
});

describe('unmatchedRulesMessage', () => {
  it('says what was served instead, for an overlay scenario — the §8 warning', () => {
    const message = unmatchedRulesMessage('empty-forecast', 'overlay', ['forecast-empty']);
    expect(message).toContain("scenario 'empty-forecast'");
    expect(message).toContain("rule 'forecast-empty' never matched a request");
    expect(message).toContain('served from the recording unchanged');
    expect(message).toContain('the recorded state, not the patched one');
    expect(message).toContain('Check the url glob.');
  });

  it('says the opposite for a mock scenario, where nothing was served at all', () => {
    const message = unmatchedRulesMessage('no-backend', 'mock', ['a', 'b']);
    expect(message).toContain('2 rules never matched a request (a, b)');
    expect(message).toContain('nothing was served in their place');
  });
});

describe('mockMissMessage', () => {
  it('says a mock run serves only what its rules serve', () => {
    expect(mockMissMessage('no-backend', 1)).toBe(
      "scenario 'no-backend' (mock mode): 1 request matched no rule and were aborted — " +
        'a mock-mode run serves only what its rules serve',
    );
    expect(mockMissMessage('no-backend', 4)).toContain('4 requests matched no rule');
  });

  /* `network: mock` is a mode, not a synonym for "a scenario is in force": with no scenario there
   * are no rules to name, and reporting misses against the reserved name would read as a bug. */
  it('names no scenario for a mock run captured without one', () => {
    expect(mockMissMessage(SCENARIO_NONE, 3)).toBe(
      'mock mode with no scenario: 3 requests were aborted because there was no rule to serve ' +
        'them and no recording to fall back to',
    );
  });
});

/* ------------------------------------------------------------------ guards */

describe('assertRecordScenarioExclusive', () => {
  it('is a hard error at exit 2: a HAR blending reality and a scenario is neither (§2)', () => {
    let thrown: unknown;
    try {
      assertRecordScenarioExclusive({ flow: 'forecast', network: 'record', scenario: 'empty-forecast' });
    } catch (error) {
      thrown = error;
    }
    expect(RunnerError.is(thrown)).toBe(true);
    const error = thrown as RunnerError;
    expect(error.code).toBe('record-with-scenario');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.kind).toBe('scenario-invalid');
    expect(error.message).toBe(
      '--record cannot be combined with --scenario empty-forecast: recording captures reality ' +
        'and a scenario alters it, so a HAR blending both is neither',
    );
    expect(error.hint).toBe(
      'record the flow first with `vdiff run forecast --record`, then replay it under the scenario',
    );
  });

  it.each([
    ['recording without a scenario', { flow: 'f', network: 'record' }],
    ['a scenario without recording', { flow: 'f', network: 'replay', scenario: 's' }],
    ['neither', { flow: 'f' }],
  ])('allows %s', (_label, options) => {
    expect(() => assertRecordScenarioExclusive(options)).not.toThrow();
  });
});

describe('isAppOriginUrl', () => {
  it('draws the same line `network: off` draws, so the two modes cannot drift', () => {
    expect(isAppOriginUrl('http://localhost:5173/index.html')).toBe(true);
    expect(isAppOriginUrl('http://127.0.0.1:4321/api')).toBe(true);
    expect(isAppOriginUrl('http://[::1]:8080/')).toBe(true);
    expect(isAppOriginUrl('data:text/plain,hi')).toBe(true);
    expect(isAppOriginUrl('blob:http://localhost/abc')).toBe(true);
    expect(isAppOriginUrl('https://api.example.test/v1/forecast')).toBe(false);
    // Not a loopback host merely because the name starts with one.
    expect(isAppOriginUrl('https://localhost.evil.test/')).toBe(false);
  });
});


describe('toRunnerError', () => {
  it('carries the scenario failure onto the runner error with no translation table', async () => {
    const runtime = runtimeFor(
      spec({ rules: [{ id: 'forecast-empty', match: { url: '**' }, patch: { a: 1 } }] }),
      { har: forecastHar },
    );
    await drive(runtime, SEARCH_URL);
    const failure = runtime.ruleFailures()[0];
    expect(failure).toBeDefined();
    const error = toRunnerError(failure as NonNullable<typeof failure>);
    expect(error.code).toBe('scenario-no-recorded-response');
    expect(error.kind).toBe('scenario-failed');
    expect(error.exitCode).toBe(EXIT.RUN_FAILURE);
    expect(error.message).toBe(failure?.message);
  });
});
