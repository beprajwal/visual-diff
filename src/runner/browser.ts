/**
 * Browser and context construction (spec §7, "Determinism").
 *
 * Every knob in this file exists to keep the determinism test (§11.1) green: replay the same
 * revision twice and get zero findings. Fixed viewport and `deviceScaleFactor: 2`, headless
 * Chromium, injected animation/transition/caret kill-switch, `prefers-reduced-motion: reduce`,
 * `TZ=UTC`, locale `en-US`, a frozen clock and a seeded `Math.random` installed *before* any
 * application code, and overlay scrollbars disabled.
 *
 * Playwright is imported lazily so `vdiff init`, `vdiff runs` and `vdiff diff` never pay for it,
 * and so a missing Chromium download becomes the one-line message §10 asks for rather than a stack
 * trace.
 *
 * The dependency is `playwright-core`, not `playwright`: the package is distributed for `npx`
 * (spec §12), and `playwright` bundles a test runner this tool never uses and historically ships an
 * install hook that downloads several hundred megabytes of browsers before `vdiff --help` can
 * print. `vdiff install-browser` fetches Chromium on demand instead. The two packages expose the
 * same `chromium` API and share one browser registry, so a browser installed by either is found by
 * both.
 */

import type { Browser, BrowserContext, BrowserContextOptions, Page, Request } from 'playwright-core';

import { DEFAULTS, EXIT, type NetworkMode, type Viewport } from '../types.js';
import {
  CHROMIUM_LAUNCH_ARGS,
  LOCALE,
  TIMEZONE,
  buildInitScript,
} from './determinism.js';
import { RunnerError } from './errors.js';
import { isAppOriginUrl, type ScenarioRuntime } from './scenario.js';

export interface PlaywrightModule {
  chromium: {
    launch(options?: { headless?: boolean; args?: readonly string[] }): Promise<Browser>;
  };
}

/**
 * How a user gets Chromium, phrased so it is correct however they reached this binary. `npx` is
 * first because it is the documented entry point and needs no prior install; the bare form is what
 * a global or dev-dependency install has on PATH.
 */
export const INSTALL_BROWSER_HINT =
  'run `npx @beprajwal/visual-diff install-browser` (or `vdiff install-browser` if @beprajwal/visual-diff is already installed)';

/** Resolved lazily; `vdiff run` is the only command that ever loads Playwright. */
export async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import('playwright-core')) as unknown as PlaywrightModule;
  } catch (cause) {
    throw new RunnerError({
      code: 'playwright-missing',
      message: 'playwright-core is not installed',
      kind: 'browser-missing',
      hint: 'reinstall @beprajwal/visual-diff, or run `npm install` in a source checkout',
      cause,
    });
  }
}

export async function launchChromium(): Promise<Browser> {
  const playwright = await loadPlaywright();
  try {
    return await playwright.chromium.launch({ headless: true, args: [...CHROMIUM_LAUNCH_ARGS] });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/Executable doesn't exist|please run the following command|browserType.launch/i.test(message)) {
      throw new RunnerError({
        code: 'chromium-missing',
        message: 'Chromium is not installed',
        kind: 'browser-missing',
        hint: INSTALL_BROWSER_HINT,
        cause,
      });
    }
    throw new RunnerError({
      code: 'browser-launch-failed',
      message: `could not launch Chromium: ${message}`,
      kind: 'browser-missing',
      cause,
    });
  }
}

export interface ContextOptions {
  viewport: Viewport;
  deviceScaleFactor?: number;
  network: NetworkMode;
  /** Absolute HAR path. **Required** for 'record' and 'replay'; absent is a hard error. */
  har?: string;
  baseUrl?: string;
  /**
   * This viewport's scenario state (mocking spec §5, §8). **Required** for 'mock', which has no
   * recording behind it: without a runtime, `mock` would install no interception at all and become
   * the live-network mode wearing a mock label.
   */
  scenario?: ScenarioRuntime;
  /**
   * Called with the URL of every request the **dev server** answered rather than the recording
   * (see {@link routeAppOriginOnly}). The caller uses it to keep `network.json`'s HAR verdicts
   * honest: a module the dev server served is `bypassed`, not a HAR `hit`.
   */
  onAppOriginServed?: (url: string) => void;
}

/**
 * The HAR path a record/replay context cannot run without.
 *
 * Spec §7 and D9: "Silent fallthrough to the live network is the failure mode that quietly destroys
 * determinism, so it is never allowed." A context asked for 'record' with no `recordHar`, or for
 * 'replay' with no `routeFromHAR`, reaches the real network unconstrained while `meta.json` claims
 * the HAR mode — a non-deterministic run presented as a frozen one. So the missing path is refused
 * here rather than tolerated, with the exit code §9 reserves for a configuration error.
 */
export function requireHarPath(options: ContextOptions): string {
  const har = options.har;
  if (har !== undefined && har.trim() !== '') return har;
  throw new RunnerError({
    code: 'har-path-missing',
    message: `network mode '${options.network}' needs a HAR file, but no path was resolved`,
    exitCode: EXIT.CONFIG_ERROR,
    kind: 'flow-invalid',
    hint: "declare `network.har` in the flow spec, or use `--no-net` to block the network — never fall through to it",
  });
}

/** Context options shared by every replay. Split out so a test can assert them without a browser. */
export function contextOptions(options: ContextOptions): BrowserContextOptions {
  const scale = options.deviceScaleFactor ?? DEFAULTS.deviceScaleFactor;
  const base: BrowserContextOptions = {
    viewport: { width: options.viewport.width, height: options.viewport.height },
    deviceScaleFactor: scale,
    locale: LOCALE,
    timezoneId: TIMEZONE,
    reducedMotion: 'reduce',
    colorScheme: 'light',
    forcedColors: 'none',
    serviceWorkers: 'block',
    bypassCSP: true,
  };
  if (options.baseUrl !== undefined) base.baseURL = options.baseUrl;
  if (options.network === 'record') {
    // Recording is the one mode that legitimately reaches the live network — but only because
    // every response is being written to `recordHar`. Without it the run is a live-network run
    // wearing a `record` label, so there is no such thing as recording "best effort".
    base.recordHar = { path: requireHarPath(options), mode: 'minimal', content: 'embed' };
  }
  return base;
}

/** URLs of the requests a context has started and not yet finished or failed. */
const IN_FLIGHT = new WeakMap<BrowserContext, Map<Request, string>>();

/**
 * Requests outstanding on `page`'s context right now.
 *
 * Tracked on the *context* rather than the page so the settle gate can name what it is waiting on
 * without the caller threading a second bookkeeping structure through every step.
 */
export function inFlightRequests(page: Page): string[] {
  const live = IN_FLIGHT.get(page.context());
  return live === undefined ? [] : [...live.values()];
}

function trackInFlight(context: BrowserContext): void {
  const live = new Map<Request, string>();
  IN_FLIGHT.set(context, live);
  context.on('request', (request) => live.set(request, request.url()));
  context.on('requestfinished', (request) => live.delete(request));
  context.on('requestfailed', (request) => live.delete(request));
}

/**
 * The scenario runtime a `mock` context cannot run without (mocking spec D13).
 *
 * `mock` is the one mode with neither a HAR nor a blanket block behind it: all of its interception
 * is the scenario route. A mock context opened without a runtime installs nothing, so every request
 * would reach the live network while `meta.json` claims `mock` — the same lie `requireHarPath`
 * exists to prevent, so it is refused the same way.
 */
export function requireScenarioRuntime(options: ContextOptions): ScenarioRuntime {
  const runtime = options.scenario;
  if (runtime !== undefined) return runtime;
  throw new RunnerError({
    code: 'scenario-runtime-missing',
    message: "network mode 'mock' needs a scenario runtime, but none was built",
    exitCode: EXIT.CONFIG_ERROR,
    kind: 'scenario-invalid',
    hint: 'this is a wiring bug: mock mode installs no other interception, so it may never open a context without one',
  });
}

/**
 * Settle what this context will do about the network *before* it is opened, so a mode that cannot
 * be honoured never produces a live context at all — not even briefly.
 */
function assertNetworkPlan(options: ContextOptions): void {
  if (options.network === 'record' && options.scenario !== undefined) {
    // Also refused by the CLI at exit 2 (mocking spec §2). Repeated here because this is the last
    // point before a context exists: a recording made through a scenario would be committed and
    // replayed forever with nothing in it to say which parts were real.
    throw new RunnerError({
      code: 'record-with-scenario',
      message: "network mode 'record' cannot be combined with a scenario",
      exitCode: EXIT.CONFIG_ERROR,
      kind: 'scenario-invalid',
    });
  }
  switch (options.network) {
    case 'record':
      requireHarPath(options);
      return;
    case 'replay':
      requireHarPath(options);
      return;
    case 'mock':
      requireScenarioRuntime(options);
      return;
    case 'off':
      return;
    default: {
      // Unreachable while `NetworkMode` stays closed; a new mode must decide what it does about
      // the network before it is allowed to open a context.
      const unknown: never = options.network;
      throw new RunnerError({
        code: 'network-mode-unknown',
        message: `unknown network mode '${String(unknown)}': refusing to run against the live network`,
        exitCode: EXIT.CONFIG_ERROR,
        kind: 'flow-invalid',
      });
    }
  }
}

/**
 * The one line the runner draws around the machine: the app's own origin reaches the dev server,
 * everything else is refused. `network: off` is nothing but this handler, and `replay` installs it
 * underneath the recording as the floor `notFound: 'fallback'` lands on.
 *
 * `onAppOriginServed` is how the caller learns that a request was answered by the dev server rather
 * than by the recording. Without it a replay cannot tell the two apart after the fact — Playwright
 * reports both as an ordinary finished request — and would report every module the dev server
 * served as a HAR hit.
 */
async function routeAppOriginOnly(
  context: BrowserContext,
  onAppOriginServed?: (url: string) => void,
): Promise<void> {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isAppOriginUrl(url)) {
      onAppOriginServed?.(url);
      return route.continue();
    }
    return route.abort('blockedbyclient');
  });
}

export async function newContext(browser: Browser, options: ContextOptions): Promise<BrowserContext> {
  assertNetworkPlan(options);

  const context = await browser.newContext(contextOptions(options));
  try {
    trackInFlight(context);
    await context.addInitScript({ content: buildInitScript() });

    if (options.network === 'replay') {
      // Two handlers, and the order of the two is the whole design.
      //
      // The backstop goes on **first**, so Playwright — which consults handlers in reverse
      // registration order — reaches it **last**. Then the recording goes on top with
      // `notFound: 'fallback'`, which hands a request the HAR cannot answer *down the handler
      // chain* rather than out to the network.
      //
      // Slice-1 recorded everything the page asked for, the dev server's own document included, so
      // a replay of a slice-1 recording answers every request from the HAR and the backstop never
      // fires — the guarantee that zero requests reach the dev server is unchanged. A recording
      // made *against* an API (mocking spec §9) cannot contain the dev server: its port is
      // ephemeral, so the URLs would differ on every run. Those requests fall to the backstop and
      // are served by the dev server, which is where the code under test actually lives.
      //
      // What must never happen is a request leaving the machine, and it cannot: the backstop is
      // registered unconditionally and aborts everything that is not app-origin, so `fallback`
      // always has somewhere to land. Bare `notFound: 'fallback'` with no handler beneath it would
      // be the live-network fallthrough D13 names.
      await routeAppOriginOnly(context, options.onAppOriginServed);
      await context.routeFromHAR(requireHarPath(options), { notFound: 'fallback', update: false });
    } else if (options.network === 'off') {
      await routeAppOriginOnly(context);
    }
    // 'record' falls through to the live network on purpose — and only because `contextOptions`
    // already attached the `recordHar` that captures every byte of it.
    //
    // 'mock' installs nothing here: the scenario route below is its whole interception, which is
    // why `assertNetworkPlan` refuses a mock context without a runtime.

    if (options.scenario !== undefined) {
      // Registered **after** `routeFromHAR` so Playwright consults it **first** — handlers run in
      // reverse registration order. That ordering is what lets an overlay rule patch or replace a
      // response while `route.fallback()` hands every unclaimed request down to the recording,
      // untouched (mocking spec §5, "The two modes").
      const runtime = options.scenario;
      await context.route('**/*', (route) => runtime.handle(route));
    }
  } catch (error) {
    // A context whose interception failed to install is a context onto the live network. Close it.
    await context.close().catch(() => undefined);
    throw error;
  }

  return context;
}

/** What the settle gate actually achieved, so a caller can report it instead of assuming success. */
export interface SettleReport {
  /** True when the in-flight gate closed on its own before the deadline. */
  settled: boolean;
  /** Milliseconds spent on the in-flight gate. */
  waitedMs: number;
  /** Requests still outstanding when the gate gave up; 0 when `settled`. */
  inFlight: number;
  /** URLs of those outstanding requests, capped so a warning stays readable. */
  urls: string[];
}

export interface SettleOptions {
  /** How long the in-flight gate waits before giving up and reporting. */
  timeoutMs?: number;
  /** Names the outstanding requests. Defaults to the context-level tracker. */
  inFlightUrls?: () => readonly string[];
  /** Cap on `urls`, matching the run-level HAR-miss warning. */
  maxUrls?: number;
}

/**
 * The pre-shoot settle gate (spec §7): `document.fonts.ready`, two idle animation frames, and no
 * in-flight requests. Not a timer — a timer is how a half-rendered frame gets captured.
 *
 * The deadline exists so a page that never goes quiet cannot hang a run, but losing the race is a
 * fact about the capture, not a detail to swallow: a screenshot taken with requests outstanding is
 * a non-deterministic capture. So the gate **returns what happened**. Callers must surface an
 * unsettled report on the step result and in the run warnings, exactly like a HAR miss — the
 * deadline is never extended, because the point is honesty, not patience.
 */
export async function settle(
  page: Page,
  inFlight: () => number,
  options: number | SettleOptions = {},
): Promise<SettleReport> {
  const opts: SettleOptions = typeof options === 'number' ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxUrls = opts.maxUrls ?? 20;
  const namer = opts.inFlightUrls ?? ((): readonly string[] => inFlightRequests(page));

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  while (inFlight() > 0 && Date.now() < deadline) {
    await page.waitForTimeout(20);
  }
  const outstanding = inFlight();
  const waitedMs = Date.now() - startedAt;

  await page.evaluate(async () => {
    if (document.fonts !== undefined) {
      try {
        await document.fonts.ready;
      } catch {
        /* fonts API unavailable or rejected: the frame gate below still applies */
      }
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  if (outstanding <= 0) return { settled: true, waitedMs, inFlight: 0, urls: [] };

  let urls: string[] = [];
  try {
    urls = [...new Set(namer())].slice(0, maxUrls);
  } catch {
    /* naming is diagnostic; a closed context must not turn a warning into a failure */
  }
  return { settled: false, waitedMs, inFlight: outstanding, urls };
}

/** One-line description of an unsettled gate, for `step.json` and the run warning list. */
export function describeSettle(report: SettleReport): string {
  return (
    `screenshot taken with ${report.inFlight} request(s) still in flight after ${report.waitedMs}ms; ` +
    'this capture is not deterministic'
  );
}
