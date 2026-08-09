/**
 * Scenario execution (mocking spec §5, §8, §11; D10–D13).
 *
 * The scenario *language* lives in `src/scenario/` (parse, validate, names) and the *decision* lives
 * in `src/mocking/` (match, merge patch, JSON Patch, the overlay engine). Both are pure: no browser,
 * no clock, no store. This file is the only place they meet a live `BrowserContext`, and it owns the
 * four things neither of them can:
 *
 *  1. **Where the spec comes from.** On historical replay the scenario is read out of git history at
 *     the target SHA, exactly as the flow spec is under D4 — so replaying an old revision uses the
 *     scenario committed then. A scenario absent at that SHA is rejected cleanly.
 *  2. **Executing a decision.** Abort, fulfil, or pass through — plus `delay`, which defers *route
 *     fulfilment* and never sleeps the runner, because viewports replay concurrently (§11).
 *  3. **Never reaching the live network.** `mock` has no recording behind it, so `route.fallback()`
 *     — which continues to the network when nothing is registered behind it — is never called in
 *     that mode. This is the fallthrough bug D13 names, and the switch below is total so a new
 *     action cannot be added without deciding what it does about the network.
 *  4. **Aggregating across viewports.** One engine per viewport (see {@link ScenarioRuntime}), so
 *     "this rule never matched" is only true when it matched in *no* viewport.
 */

import { readFile } from 'node:fs/promises';

import {
  EXIT,
  SCENARIO_NONE,
  type ScenarioAttribution,
  type ScenarioMode,
  type ScenarioName,
  type ScenarioSpec,
} from '../types.js';
import {
  formatIssues,
  parseScenarioSource,
  scenarioNameIssue,
  scenarioRepoPath,
} from '../scenario/index.js';
import {
  ScenarioEngine,
  ScenarioError,
  bodyBytes,
  needsRecordedResponse,
  scenarioFile,
  type MockAction,
  type MockRequest,
} from '../mocking/index.js';

import { RunnerError } from './errors.js';
import { showFileAtRev } from './git.js';
import type { HarIndex } from './har.js';

/* ------------------------------------------------------------------ paths */

/**
 * Re-exported, not reimplemented. `.visual-diff/scenarios/<name>.yaml` is defined once in
 * `mocking/paths.ts`; a second spelling here is how the runner and `vdiff scenario check` would
 * eventually come to disagree about which file a name refers to.
 */
export { scenarioFile };

/**
 * Reject a scenario name that cannot be a filename, and the reserved one, before anything touches
 * the disk. `none` is what `meta.json` records for a run captured without a scenario (§6), so a
 * scenario file of that name would make `meta.scenario` unable to say which of the two it meant.
 */
export function assertRunnableScenarioName(name: ScenarioName): ScenarioName {
  const issue = scenarioNameIssue(name);
  if (issue === null) return name;
  throw new RunnerError({
    code: issue.code,
    message: issue.message,
    exitCode: EXIT.CONFIG_ERROR,
    kind: 'scenario-invalid',
    hint: 'pick another name, or drop --scenario to run without one',
  });
}

/* ------------------------------------------------------------------ resolution */

/** A validated scenario, with where it was read from, ready to build runtimes from. */
export interface ScenarioPlan {
  name: ScenarioName;
  mode: ScenarioMode;
  spec: ScenarioSpec;
  /** Human-readable origin: the file path, or `<repo path>@<sha7>` on historical replay. */
  file: string;
}

export interface ResolveScenarioOptions {
  name: ScenarioName;
  /** Project root — the directory containing `.visual-diff`. */
  root: string;
  /** Repository root, for reading out of history. */
  gitRoot: string;
  /** Set on historical replay: the SHA whose committed specs this run uses (D4). */
  sha?: string;
  /** Injectable for tests; defaults to `git show`. */
  readAtRev?: (gitRoot: string, sha: string, path: string) => Promise<string | null>;
}

/**
 * Read and validate the scenario this run will use.
 *
 * On the slow path the source comes from `git show <sha>:.visual-diff/scenarios/<name>.yaml`, the
 * same rule flow specs follow under D4: replaying an old revision with today's scenario would
 * compare a revision against a scenario that never met it.
 */
export async function resolveScenario(options: ResolveScenarioOptions): Promise<ScenarioPlan> {
  const name = assertRunnableScenarioName(options.name);
  const repoPath = scenarioRepoPath(name);

  let source: string;
  let file: string;
  if (options.sha === undefined) {
    file = scenarioFile(options.root, name);
    try {
      source = await readFile(file, 'utf8');
    } catch {
      throw new RunnerError({
        code: 'scenario-missing',
        message: `no scenario spec at ${file}`,
        exitCode: EXIT.CONFIG_ERROR,
        kind: 'scenario-missing',
        hint: `create it with \`vdiff scenario new ${name}\``,
      });
    }
  } else {
    const sha = options.sha;
    const read = options.readAtRev ?? showFileAtRev;
    const fromHistory = await read(options.gitRoot, sha, repoPath);
    if (fromHistory === null) {
      throw new RunnerError({
        code: 'scenario-missing-at-rev',
        message: `scenario "${name}" did not exist at ${sha.slice(0, 7)}: ${repoPath}`,
        exitCode: EXIT.CONFIG_ERROR,
        kind: 'scenario-missing',
        hint: 'pick a revision where the scenario was committed, or replay HEAD',
      });
    }
    source = fromHistory;
    file = `${repoPath}@${sha.slice(0, 7)}`;
  }

  const parsed = parseScenarioSource(source, { file, expectScenarioName: name });
  if (!parsed.ok) {
    // §8 asks for file, line and offending key; `formatIssues` is the scenario layer's own renderer
    // for exactly that, so the run path and `vdiff scenario check` say the same thing.
    throw new RunnerError({
      code: parsed.issues[0]?.code ?? 'scenario-invalid',
      message: formatIssues(parsed.issues),
      exitCode: EXIT.CONFIG_ERROR,
      kind: 'scenario-invalid',
    });
  }

  return { name, mode: parsed.value.mode, spec: parsed.value, file };
}

/* ------------------------------------------------------------------ the per-viewport runtime */

/**
 * The slice of Playwright's `Route` this runtime uses.
 *
 * Structural on purpose: every branch below is exercised with no browser, and a real `Route`
 * satisfies it. `fallback()` is listed but only ever called in `overlay` mode, where `routeFromHAR`
 * is registered behind it — in `mock` mode there is nothing behind it and it would continue to the
 * live network.
 */
export interface RouteLike {
  request(): { url(): string; method(): string };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
  fallback(): Promise<void>;
  fulfill(options: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
  }): Promise<void>;
}

/**
 * Requests that reach the app itself rather than the network — the line `network: off` already
 * draws (spec §7), reused verbatim so the two modes cannot drift apart.
 */
const LOOPBACK_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

export function isAppOriginUrl(url: string): boolean {
  return url.startsWith('data:') || url.startsWith('blob:') || LOOPBACK_URL.test(url);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface ScenarioRuntimeOptions {
  engine: ScenarioEngine;
  /** Recorded responses, consulted only by `patch`/`patchOps`. Absent in `mock` mode. */
  har?: HarIndex;
  /** Injectable so a `delay` test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One viewport's scenario state.
 *
 * **One runtime, and therefore one engine, per viewport — never one per run.** `nth` counts
 * occurrences of a request, and viewports replay concurrently in separate contexts (spec §7): a
 * shared counter would let the desktop viewport's second request consume the mobile viewport's
 * `nth: 2` rule, so the same flow under the same scenario would render differently depending on
 * scheduling. That is precisely the non-determinism this tool exists to rule out (§10.1). Per
 * viewport, every viewport sees the same sequence; the run-level view is assembled by
 * {@link unmatchedRuleIds} and the miss counters in `run.ts`.
 */
export class ScenarioRuntime {
  readonly scenario: ScenarioName;
  readonly mode: ScenarioMode;

  private readonly engine: ScenarioEngine;
  private readonly har: HarIndex | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Keyed on the Playwright `Request` object, which the route and the page event share. */
  private readonly byRequest = new WeakMap<object, ScenarioAttribution>();
  /** Fallback queue, in case a host does not preserve request identity across the two APIs. */
  private readonly byKey = new Map<string, ScenarioAttribution[]>();

  private readonly failures: ScenarioError[] = [];

  constructor(options: ScenarioRuntimeOptions) {
    this.engine = options.engine;
    this.scenario = options.engine.scenario;
    this.mode = options.engine.mode;
    this.har = options.har;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Ids of the rules that matched at least one request in this viewport, in file order. */
  matchedRuleIds(): readonly string[] {
    return this.engine.matchedRuleIds();
  }

  /** Rules that could not be applied; any one of them fails the run (mocking spec §8). */
  ruleFailures(): readonly ScenarioError[] {
    return this.failures;
  }

  /**
   * The attribution recorded for a request, for `network.json` (mocking spec §8).
   *
   * The object-identity lookup is the exact one. The `(method, url)` queue behind it exists because
   * losing attribution silently would leave the report unable to explain a changed response, which
   * is the whole of D11's "a rule id is attribution for free".
   */
  attributionFor(request: object, method: string, url: string): ScenarioAttribution | undefined {
    const exact = this.byRequest.get(request);
    if (exact !== undefined) return exact;
    return this.byKey.get(`${method.toUpperCase()} ${url}`)?.shift();
  }

  private record(
    request: object,
    method: string,
    url: string,
    attribution: ScenarioAttribution,
  ): void {
    this.byRequest.set(request, attribution);
    const key = `${method.toUpperCase()} ${url}`;
    const queue = this.byKey.get(key);
    if (queue === undefined) this.byKey.set(key, [attribution]);
    else queue.push(attribution);
  }

  /**
   * Apply the scenario to one request.
   *
   * Never throws. A route handler that rejects leaves the request hanging until the step times out,
   * which would report a scenario problem as a flow failure; instead the failure is collected (and
   * fails the run afterwards, naming the rule) and the request is aborted rather than released to
   * the network.
   */
  async handle(route: RouteLike): Promise<void> {
    const raw = route.request();
    const url = raw.url();
    const method = raw.method();
    const request: MockRequest = { method, url };

    let action: MockAction;
    try {
      const selected = this.engine.select(request);

      // The app's own assets, in `mock` mode, with no rule claiming them. `mock` replaces the
      // *network*, not the dev server that is serving the code under test — aborting here would
      // abort the document itself and there would be nothing to screenshot. Handled before
      // `resolve` so these never enter the miss bookkeeping: a page's own scripts and stylesheets
      // are not what the mock-miss warning is about. A rule that *does* claim a same-origin URL
      // still wins, because `select` ran first.
      if (selected === null && this.mode === 'mock' && isAppOriginUrl(url)) {
        this.record(raw, method, url, {
          scenario: this.scenario,
          ruleId: null,
          action: 'passthrough',
          bodyChanged: false,
        });
        await route.continue();
        return;
      }

      const recorded = needsRecordedResponse(selected) ? this.har?.find(method, url) : undefined;
      const decision = this.engine.resolve(request, selected, recorded);
      this.record(raw, method, url, decision.attribution);
      action = decision.action;
    } catch (error) {
      this.failures.push(asScenarioError(error, this.scenario, method, url));
      this.record(raw, method, url, {
        scenario: this.scenario,
        ruleId: null,
        action: 'abort',
        bodyChanged: false,
      });
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }

    try {
      // Deferring *route fulfilment*, never the runner: viewports replay concurrently and a sleep
      // here must not become a sleep there (mocking spec §11).
      if (action.delayMs > 0) await this.sleep(action.delayMs);

      switch (action.kind) {
        case 'abort':
          await route.abort('blockedbyclient');
          return;
        case 'fulfill':
          await route.fulfill({
            status: action.response.status,
            headers: action.response.headers,
            body: bodyBytes(action.response),
          });
          return;
        case 'passthrough':
          // Only reachable in `overlay` mode: `mock` resolves every unmatched request to an abort,
          // and its app-origin requests returned above. `fallback()` hands the request to the
          // `routeFromHAR` route registered behind this one — in `mock` there is nothing behind it,
          // so it would continue to the live network (D13).
          if (this.mode === 'mock') {
            await route.continue();
            return;
          }
          await route.fallback();
          return;
      }
    } catch (error) {
      this.failures.push(asScenarioError(error, this.scenario, method, url));
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  }
}

function asScenarioError(
  error: unknown,
  scenario: ScenarioName,
  method: string,
  url: string,
): ScenarioError {
  if (ScenarioError.is(error)) return error;
  return new ScenarioError({
    code: 'scenario-patch-op-failed',
    scenario,
    url,
    message:
      `scenario '${scenario}' failed while handling ${method} ${url}: ` +
      (error instanceof Error ? error.message : String(error)),
  });
}

/** Re-throw a scenario failure as the runner's error type. The fields line up one-to-one. */
export function toRunnerError(error: ScenarioError): RunnerError {
  return new RunnerError({
    code: error.code,
    message: error.message,
    exitCode: error.exitCode,
    kind: error.kind,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    cause: error,
  });
}

/* ------------------------------------------------------------------ building runtimes */

/** The empty scenario a `mock` run captured without one uses (D13). */
export const MOCK_ONLY_SPEC: ScenarioSpec = {
  version: 1,
  scenario: SCENARIO_NONE,
  mode: 'mock',
  rules: [],
};

export interface BuildRuntimeOptions {
  /** Absent for a `mock` run with no scenario, which still needs a runtime. */
  plan?: ScenarioPlan;
  har?: HarIndex;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One runtime for one viewport (see {@link ScenarioRuntime} on why it is never shared).
 *
 * With no plan this builds the rule-less `mock` runtime: `network: mock` is a mode in its own right,
 * not a synonym for "a scenario is in force", so it has to be honest with no rules at all — the app
 * loads from the dev server and every other request is aborted and reported as a miss. It is also
 * what lets `newContext` insist a mock context always carries a runtime, so `mock` can never become
 * the mode that quietly reaches the network.
 */
export function buildScenarioRuntime(options: BuildRuntimeOptions = {}): ScenarioRuntime {
  const spec = options.plan?.spec ?? MOCK_ONLY_SPEC;
  return new ScenarioRuntime({
    engine: new ScenarioEngine(spec),
    ...(options.har === undefined ? {} : { har: options.har }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

/* ------------------------------------------------------------------ run-level reporting */

/**
 * Rule ids no viewport matched, in file order.
 *
 * Aggregation is the runner's job because engines are per-viewport: a rule keyed to a request the
 * mobile layout never makes has still done its job in the desktop one, so "never matched" means
 * matched in *no* viewport.
 */
export function unmatchedRuleIds(
  spec: ScenarioSpec,
  matchedPerViewport: ReadonlyArray<readonly string[]>,
): string[] {
  const matched = new Set<string>();
  for (const ids of matchedPerViewport) for (const id of ids) matched.add(id);
  return spec.rules.map((rule) => rule.id).filter((id) => !matched.has(id));
}

/**
 * The never-matched warning (mocking spec §8) — "the most important line in this section".
 *
 * A user looking at a screen they believe is the empty state, when a mistyped glob matched nothing
 * and they are in fact seeing the recorded full response, has been actively misled by the tool. So
 * the message names every silent rule and says what was served instead, which differs by mode:
 * overlay served the recording, mock served nothing at all.
 */
export function unmatchedRulesMessage(
  scenario: ScenarioName,
  mode: ScenarioMode,
  ruleIds: readonly string[],
): string {
  const subject =
    ruleIds.length === 1
      ? `rule '${ruleIds[0] as string}' never matched a request`
      : `${ruleIds.length} rules never matched a request (${ruleIds.join(', ')})`;
  const consequence =
    mode === 'mock'
      ? 'nothing was served in their place, so the screens you are looking at are missing those responses'
      : 'those requests were served from the recording unchanged, so the screens you are looking ' +
        'at are the recorded state, not the patched one';
  return `scenario '${scenario}': ${subject} during this run — ${consequence}. Check the url glob.`;
}

/**
 * The `mock`-mode miss warning: requests aborted with no recording to fall back to (§8, D13).
 *
 * A mock run with no scenario at all is legal — `network: mock` is a mode, not a synonym for "a
 * scenario is in force" — and it has no rules to name, so it says that rather than reporting misses
 * against the reserved name `none`.
 */
export function mockMissMessage(scenario: ScenarioName, count: number): string {
  const requests = `${count} ${count === 1 ? 'request' : 'requests'}`;
  if (scenario === SCENARIO_NONE) {
    return (
      `mock mode with no scenario: ${requests} were aborted because there was no rule to serve ` +
      'them and no recording to fall back to'
    );
  }
  return (
    `scenario '${scenario}' (mock mode): ${requests} matched no rule and were aborted — ` +
    'a mock-mode run serves only what its rules serve'
  );
}

/**
 * `--record` with `--scenario` is a hard error (mocking spec §2, §7).
 *
 * Recording captures reality and a scenario alters it, so a HAR blending both is neither: it would
 * be committed, replayed by every later run, and carry nothing to say which parts were real.
 */
export function assertRecordScenarioExclusive(options: {
  flow: string;
  network?: string;
  scenario?: ScenarioName;
}): void {
  if (options.network !== 'record' || options.scenario === undefined) return;
  throw new RunnerError({
    code: 'record-with-scenario',
    message:
      `--record cannot be combined with --scenario ${options.scenario}: recording captures reality ` +
      'and a scenario alters it, so a HAR blending both is neither',
    exitCode: EXIT.CONFIG_ERROR,
    kind: 'scenario-invalid',
    hint: `record the flow first with \`vdiff run ${options.flow} --record\`, then replay it under the scenario`,
  });
}
