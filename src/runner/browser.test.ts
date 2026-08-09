/**
 * Context construction and the settle gate.
 *
 * The load-bearing assertion in this file is negative: for every reachable network mode, the
 * context either records, intercepts, or refuses to open — it never quietly reaches the live
 * network (spec §7, D9).
 */

import { describe, expect, it, vi } from 'vitest';

import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright-core';

import { EXIT, type NetworkMode, type ScenarioSpec, type Viewport } from '../types.js';
import {
  contextOptions,
  describeSettle,
  inFlightRequests,
  newContext,
  requireHarPath,
  requireScenarioRuntime,
  settle,
} from './browser.js';
import { buildInitScript } from './determinism.js';
import { RunnerError } from './errors.js';
import { buildScenarioRuntime, type ScenarioPlan } from './scenario.js';

const viewport: Viewport = { id: '1280x800', width: 1280, height: 800 };

const overlaySpec: ScenarioSpec = {
  version: 1,
  scenario: 'empty-forecast',
  mode: 'overlay',
  rules: [{ id: 'forecast-empty', match: { url: '**/v1/forecast**' }, patch: { hourly: null } }],
};
const overlayPlan: ScenarioPlan = {
  name: 'empty-forecast',
  mode: 'overlay',
  spec: overlaySpec,
  file: '.visual-diff/scenarios/empty-forecast.yaml',
};

/* ------------------------------------------------------------------ fakes */

interface FakeRoute {
  request(): { url(): string; method(): string };
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
  fallback(): Promise<void>;
  fulfill(options: { status?: number; headers?: Record<string, string>; body?: string | Buffer }): Promise<void>;
}

class FakeContext {
  readonly initScripts: string[] = [];
  readonly harRoutes: Array<{ har: string; options: unknown }> = [];
  readonly listeners = new Map<string, Array<(arg: unknown) => void>>();
  /** Every interception installed, in registration order — Playwright consults them in reverse. */
  readonly installed: string[] = [];
  /** Every `route()` handler, in registration order. `handler` is the last one registered. */
  readonly handlers: Array<(route: FakeRoute) => unknown> = [];
  routePattern: string | undefined;
  handler: ((route: FakeRoute) => unknown) | undefined;

  async addInitScript(script: { content: string }): Promise<void> {
    this.initScripts.push(script.content);
  }

  async routeFromHAR(har: string, options: unknown): Promise<void> {
    this.harRoutes.push({ har, options });
    this.installed.push('routeFromHAR');
  }

  async route(pattern: string, handler: (route: FakeRoute) => unknown): Promise<void> {
    this.routePattern = pattern;
    this.handler = handler;
    this.handlers.push(handler);
    this.installed.push('route');
  }

  closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }

  on(event: string, fn: (arg: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, arg: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(arg);
  }
}

class FakeBrowser {
  readonly contexts: FakeContext[] = [];
  readonly optionsSeen: BrowserContextOptions[] = [];

  async newContext(options: BrowserContextOptions): Promise<FakeContext> {
    this.optionsSeen.push(options);
    const context = new FakeContext();
    this.contexts.push(context);
    return context;
  }
}

function browserOf(fake: FakeBrowser): Browser {
  return fake as unknown as Browser;
}

type RouteVerdict = 'continue' | 'abort' | 'fallback' | 'fulfill' | 'none';

/**
 * Drives one URL through a handler `newContext` installed — the last registered by default, which
 * is the one Playwright consults first. `index` selects an earlier one: `replay` registers the
 * app-origin backstop at 0 and the recording lands on it via `notFound: 'fallback'`.
 */
async function driveRoute(context: FakeContext, url: string, index?: number): Promise<RouteVerdict> {
  const handler = index === undefined ? context.handler : context.handlers[index];
  if (handler === undefined) return 'none';
  let verdict: RouteVerdict = 'continue';
  const request = { url: () => url, method: () => 'GET' };
  const route: FakeRoute = {
    request: () => request,
    continue: async () => {
      verdict = 'continue';
    },
    abort: async () => {
      verdict = 'abort';
    },
    fallback: async () => {
      verdict = 'fallback';
    },
    fulfill: async () => {
      verdict = 'fulfill';
    },
  };
  await handler(route);
  return verdict;
}

/* ------------------------------------------------------------------ requireHarPath */

describe('requireHarPath', () => {
  it('returns the path when one was resolved', () => {
    expect(requireHarPath({ viewport, network: 'replay', har: '/tmp/checkout.har' })).toBe(
      '/tmp/checkout.har',
    );
  });

  it.each([undefined, '', '   '])('refuses %o as a configuration error, not a degraded run', (har) => {
    let thrown: unknown;
    try {
      requireHarPath({ viewport, network: 'record', ...(har === undefined ? {} : { har }) });
    } catch (error) {
      thrown = error;
    }
    expect(RunnerError.is(thrown)).toBe(true);
    const error = thrown as RunnerError;
    expect(error.code).toBe('har-path-missing');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.hint).toMatch(/--no-net/);
  });
});

/* ------------------------------------------------------------------ contextOptions */

describe('contextOptions', () => {
  it('pins every determinism knob spec §7 lists', () => {
    const options = contextOptions({ viewport, network: 'off' });
    expect(options).toMatchObject({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      locale: 'en-US',
      timezoneId: 'UTC',
      reducedMotion: 'reduce',
      colorScheme: 'light',
      forcedColors: 'none',
      serviceWorkers: 'block',
    });
    expect(options.recordHar).toBeUndefined();
  });

  it('records to the HAR when the mode is record', () => {
    const options = contextOptions({ viewport, network: 'record', har: '/tmp/checkout.har' });
    expect(options.recordHar).toEqual({ path: '/tmp/checkout.har', mode: 'minimal', content: 'embed' });
  });

  it('refuses a record context with no HAR rather than opening one that only hits the network', () => {
    expect(() => contextOptions({ viewport, network: 'record' })).toThrow(/needs a HAR file/);
  });

  it('leaves recordHar off for replay, which intercepts instead', () => {
    expect(contextOptions({ viewport, network: 'replay', har: '/tmp/x.har' }).recordHar).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ newContext */

describe('newContext', () => {
  it('replay intercepts from the HAR, over a backstop that refuses the live network', async () => {
    const fake = new FakeBrowser();
    const context = await newContext(browserOf(fake), {
      viewport,
      network: 'replay',
      har: '/tmp/checkout.har',
    });
    const created = context as unknown as FakeContext;
    expect(created.harRoutes).toEqual([
      { har: '/tmp/checkout.har', options: { notFound: 'fallback', update: false } },
    ]);
    // The backstop is registered *first*, so Playwright reaches it *last*: the recording is
    // consulted before it, and `notFound: 'fallback'` lands here rather than on the network.
    expect(created.installed).toEqual(['route', 'routeFromHAR']);
    expect(fake.optionsSeen[0]?.recordHar).toBeUndefined();
  });

  /*
   * `notFound: 'fallback'` is only safe because something is always underneath it. If the backstop
   * were ever dropped, a request missing from the HAR would fall through to the live network —
   * exactly the silent fallthrough spec §7 and D13 forbid — and every other assertion here would
   * still pass. So the backstop's own verdicts are asserted directly.
   */
  it('lands a request the HAR cannot answer on the dev server, never on the network', async () => {
    const fake = new FakeBrowser();
    const context = await newContext(browserOf(fake), {
      viewport,
      network: 'replay',
      har: '/tmp/checkout.har',
    });
    const created = context as unknown as FakeContext;
    await expect(driveRoute(created, 'http://localhost:5173/index.html', 0)).resolves.toBe('continue');
    await expect(driveRoute(created, 'http://127.0.0.1:4321/src/main.jsx', 0)).resolves.toBe('continue');
    await expect(driveRoute(created, 'data:text/plain,hi', 0)).resolves.toBe('continue');
    await expect(driveRoute(created, 'https://api.open-meteo.com/v1/forecast', 0)).resolves.toBe('abort');
    await expect(driveRoute(created, 'https://localhost.evil.test/', 0)).resolves.toBe('abort');
  });

  it('reports which requests the dev server answered, so they are not counted as HAR hits', async () => {
    const fake = new FakeBrowser();
    const served: string[] = [];
    const context = await newContext(browserOf(fake), {
      viewport,
      network: 'replay',
      har: '/tmp/checkout.har',
      onAppOriginServed: (url) => served.push(url),
    });
    const created = context as unknown as FakeContext;
    await driveRoute(created, 'http://localhost:5173/index.html', 0);
    await driveRoute(created, 'https://api.open-meteo.com/v1/forecast', 0);
    // Only the one the backstop actually passed through — an aborted request served nothing.
    expect(served).toEqual(['http://localhost:5173/index.html']);
  });

  it('record opens with recordHar and installs no interception', async () => {
    const fake = new FakeBrowser();
    const context = await newContext(browserOf(fake), {
      viewport,
      network: 'record',
      har: '/tmp/checkout.har',
    });
    const created = context as unknown as FakeContext;
    expect(fake.optionsSeen[0]?.recordHar).toMatchObject({ path: '/tmp/checkout.har' });
    expect(created.harRoutes).toEqual([]);
    expect(created.handler).toBeUndefined();
  });

  it('off blocks remote traffic and lets the dev server and data URLs through', async () => {
    const fake = new FakeBrowser();
    const context = await newContext(browserOf(fake), { viewport, network: 'off' });
    const created = context as unknown as FakeContext;
    expect(created.routePattern).toBe('**/*');
    await expect(driveRoute(created, 'http://localhost:5173/index.html')).resolves.toBe('continue');
    await expect(driveRoute(created, 'http://127.0.0.1:4321/api')).resolves.toBe('continue');
    await expect(driveRoute(created, 'data:text/plain,hi')).resolves.toBe('continue');
    await expect(driveRoute(created, 'https://api.example.com/cart')).resolves.toBe('abort');
  });

  // The regression this whole exercise is about: every reachable mode must intercept, record, or
  // refuse. There is no fourth outcome.
  const cases: Array<{ network: NetworkMode; har?: string }> = [
    { network: 'record' },
    { network: 'replay' },
    { network: 'record', har: '' },
    { network: 'replay', har: '   ' },
  ];

  it.each(cases)('refuses %o instead of opening a context onto the live network', async (options) => {
    const fake = new FakeBrowser();
    await expect(newContext(browserOf(fake), { viewport, ...options })).rejects.toThrow(
      /needs a HAR file/,
    );
    // Nothing may be left half-built that a caller could still drive a page through.
    const created = fake.contexts[0] as FakeContext | undefined;
    expect(created?.harRoutes ?? []).toEqual([]);
    expect(created?.handler).toBeUndefined();
    expect(fake.optionsSeen[0]?.recordHar).toBeUndefined();
  });

  it('refuses a network mode it does not recognise, before opening anything', async () => {
    const fake = new FakeBrowser();
    await expect(
      newContext(browserOf(fake), { viewport, network: 'sideload' as NetworkMode, har: '/tmp/x.har' }),
    ).rejects.toThrow(/refusing to run against the live network/);
    expect(fake.contexts).toEqual([]);
  });

  it('closes the context when interception fails to install, rather than leaking one onto the network', async () => {
    const fake = new FakeBrowser();
    const broken = new FakeContext();
    broken.routeFromHAR = async (): Promise<void> => {
      throw new Error('HAR file is corrupt');
    };
    fake.newContext = async (): Promise<FakeContext> => {
      fake.contexts.push(broken);
      return broken;
    };

    await expect(
      newContext(browserOf(fake), { viewport, network: 'replay', har: '/tmp/checkout.har' }),
    ).rejects.toThrow(/HAR file is corrupt/);
    expect(broken.closed).toBe(true);
  });

  it('installs the determinism init script before any application code', async () => {
    const fake = new FakeBrowser();
    const context = await newContext(browserOf(fake), { viewport, network: 'off' });
    expect((context as unknown as FakeContext).initScripts).toEqual([buildInitScript()]);
  });

  /* ---------------------------------------------------------------- scenarios (mocking D13) */

  it('registers the scenario route after the HAR route, so it is consulted first', async () => {
    const fake = new FakeBrowser();
    const context = await newContext(browserOf(fake), {
      viewport,
      network: 'replay',
      har: '/tmp/checkout.har',
      scenario: buildScenarioRuntime({ plan: overlayPlan }),
    });
    const created = context as unknown as FakeContext;
    // Reverse registration order is Playwright's: last registered wins, and `route.fallback()`
    // from the scenario handler is what reaches the recording. Three layers now, consulted from
    // the right: scenario, then the recording, then the app-origin backstop.
    expect(created.installed).toEqual(['route', 'routeFromHAR', 'route']);
    expect(created.routePattern).toBe('**/*');
  });

  it('mock installs the scenario route and nothing else — it is the whole interception', async () => {
    const fake = new FakeBrowser();
    const context = await newContext(browserOf(fake), {
      viewport,
      network: 'mock',
      scenario: buildScenarioRuntime(),
    });
    const created = context as unknown as FakeContext;
    expect(created.installed).toEqual(['route']);
    expect(created.harRoutes).toEqual([]);
    expect(fake.optionsSeen[0]?.recordHar).toBeUndefined();
    // The app loads; the network does not.
    await expect(driveRoute(created, 'http://127.0.0.1:5173/index.html')).resolves.toBe('continue');
    await expect(driveRoute(created, 'https://api.example.com/v1/forecast')).resolves.toBe('abort');
  });

  /*
   * `mock` is the one mode with neither a HAR nor a blanket block behind it: its whole interception
   * is the scenario route, so a mock context opened without a runtime installs nothing at all and
   * every request reaches the live network while meta.json says `mock`.
   */
  it('refuses a mock context with no scenario runtime, before opening one', async () => {
    const fake = new FakeBrowser();
    let thrown: unknown;
    try {
      await newContext(browserOf(fake), { viewport, network: 'mock' });
    } catch (error) {
      thrown = error;
    }
    expect(RunnerError.is(thrown)).toBe(true);
    const error = thrown as RunnerError;
    expect(error.code).toBe('scenario-runtime-missing');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.message).toContain("network mode 'mock' needs a scenario runtime");
    expect(fake.contexts).toEqual([]);
  });

  it('requireScenarioRuntime returns the runtime when one was built', () => {
    const runtime = buildScenarioRuntime();
    expect(requireScenarioRuntime({ viewport, network: 'mock', scenario: runtime })).toBe(runtime);
  });

  /* §2: recording captures reality and a scenario alters it, so a HAR blending both is neither. */
  it('refuses to record through a scenario, before opening a context', async () => {
    const fake = new FakeBrowser();
    await expect(
      newContext(browserOf(fake), {
        viewport,
        network: 'record',
        har: '/tmp/checkout.har',
        scenario: buildScenarioRuntime({ plan: overlayPlan }),
      }),
    ).rejects.toThrow(/cannot be combined with a scenario/);
    expect(fake.contexts).toEqual([]);
  });
});

/* ------------------------------------------------------------------ in-flight tracking */

describe('inFlightRequests', () => {
  it('names the requests a context started and has not finished', async () => {
    const fake = new FakeBrowser();
    const context = await newContext(browserOf(fake), { viewport, network: 'off' });
    const created = context as unknown as FakeContext;
    const page = { context: () => context } as unknown as Page;

    const a = { url: () => 'http://localhost:5173/api/cart' };
    const b = { url: () => 'http://localhost:5173/api/user' };
    created.emit('request', a);
    created.emit('request', b);
    expect(inFlightRequests(page).sort()).toEqual([
      'http://localhost:5173/api/cart',
      'http://localhost:5173/api/user',
    ]);

    created.emit('requestfinished', a);
    expect(inFlightRequests(page)).toEqual(['http://localhost:5173/api/user']);
    created.emit('requestfailed', b);
    expect(inFlightRequests(page)).toEqual([]);
  });

  it('is empty for a context it never wrapped', () => {
    const page = { context: () => ({}) as BrowserContext } as unknown as Page;
    expect(inFlightRequests(page)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ settle */

function fakePage(): { page: Page; waits: number; evaluated: () => number } {
  let waits = 0;
  let evaluated = 0;
  const page = {
    waitForTimeout: async (): Promise<void> => {
      waits += 1;
    },
    evaluate: async (): Promise<void> => {
      evaluated += 1;
    },
    context: () => ({}) as BrowserContext,
  };
  return {
    page: page as unknown as Page,
    get waits() {
      return waits;
    },
    evaluated: () => evaluated,
  };
}

describe('settle', () => {
  it('reports a clean gate when the in-flight count reaches zero', async () => {
    const { page, evaluated } = fakePage();
    let remaining = 3;
    const report = await settle(page, () => {
      remaining -= 1;
      return Math.max(0, remaining);
    });
    expect(report.settled).toBe(true);
    expect(report.inFlight).toBe(0);
    expect(report.urls).toEqual([]);
    // The font and frame gate still runs: settling is not the same as being painted.
    expect(evaluated()).toBe(1);
  });

  it('reports the outstanding requests instead of pretending the capture was clean', async () => {
    const { page, evaluated } = fakePage();
    const report = await settle(page, () => 2, {
      timeoutMs: 0,
      inFlightUrls: () => ['http://localhost:5173/api/cart', 'http://localhost:5173/api/cart', '/px.gif'],
    });
    expect(report.settled).toBe(false);
    expect(report.inFlight).toBe(2);
    expect(report.urls).toEqual(['http://localhost:5173/api/cart', '/px.gif']);
    expect(report.waitedMs).toBeGreaterThanOrEqual(0);
    // The screenshot is still taken — the deadline is a bound on waiting, not a run failure.
    expect(evaluated()).toBe(1);
  });

  it('does not extend the deadline; it just tells the truth about losing the race', async () => {
    const { page } = fakePage();
    const started = Date.now();
    const report = await settle(page, () => 1, { timeoutMs: 30 });
    expect(report.settled).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('caps the reported URLs so a warning stays readable', async () => {
    const { page } = fakePage();
    const urls = Array.from({ length: 40 }, (_, i) => `http://localhost:5173/api/${i}`);
    const report = await settle(page, () => 40, { timeoutMs: 0, inFlightUrls: () => urls, maxUrls: 5 });
    expect(report.urls).toHaveLength(5);
  });

  it('names outstanding requests from the context tracker when the caller supplies none', async () => {
    const fake = new FakeBrowser();
    const context = await newContext(browserOf(fake), { viewport, network: 'off' });
    (context as unknown as FakeContext).emit('request', { url: () => 'http://localhost:5173/slow' });
    const page = {
      waitForTimeout: async (): Promise<void> => undefined,
      evaluate: async (): Promise<void> => undefined,
      context: () => context,
    } as unknown as Page;

    const report = await settle(page, () => 1, { timeoutMs: 0 });
    expect(report.urls).toEqual(['http://localhost:5173/slow']);
  });

  it('still accepts a bare timeout, as the original signature did', async () => {
    const { page } = fakePage();
    const report = await settle(page, () => 0, 50);
    expect(report.settled).toBe(true);
  });

  it('survives a namer that throws, because a warning must not become a failure', async () => {
    const { page } = fakePage();
    const report = await settle(page, () => 1, {
      timeoutMs: 0,
      inFlightUrls: () => {
        throw new Error('context closed');
      },
    });
    expect(report).toMatchObject({ settled: false, inFlight: 1, urls: [] });
  });

  it('propagates a page-side failure rather than reporting a settled gate', async () => {
    const page = {
      waitForTimeout: async (): Promise<void> => undefined,
      evaluate: vi.fn(async () => {
        throw new Error('Execution context was destroyed');
      }),
      context: () => ({}) as BrowserContext,
    } as unknown as Page;
    await expect(settle(page, () => 0)).rejects.toThrow(/Execution context was destroyed/);
  });
});

describe('describeSettle', () => {
  it('says what was outstanding and for how long', () => {
    expect(describeSettle({ settled: false, waitedMs: 10_000, inFlight: 3, urls: ['/a'] })).toBe(
      'screenshot taken with 3 request(s) still in flight after 10000ms; this capture is not deterministic',
    );
  });
});
