/**
 * Context construction and the settle gate.
 *
 * The load-bearing assertion in this file is negative: for every reachable network mode, the
 * context either records, intercepts, or refuses to open — it never quietly reaches the live
 * network (spec §7, D9).
 */

import { describe, expect, it, vi } from 'vitest';

import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright-core';

import { EXIT, type NetworkMode, type Viewport } from '../types.js';
import {
  contextOptions,
  describeSettle,
  inFlightRequests,
  newContext,
  requireHarPath,
  settle,
} from './browser.js';
import { buildInitScript } from './determinism.js';
import { RunnerError } from './errors.js';

const viewport: Viewport = { id: '1280x800', width: 1280, height: 800 };

/* ------------------------------------------------------------------ fakes */

interface FakeRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

class FakeContext {
  readonly initScripts: string[] = [];
  readonly harRoutes: Array<{ har: string; options: unknown }> = [];
  readonly listeners = new Map<string, Array<(arg: unknown) => void>>();
  routePattern: string | undefined;
  handler: ((route: FakeRoute) => unknown) | undefined;

  async addInitScript(script: { content: string }): Promise<void> {
    this.initScripts.push(script.content);
  }

  async routeFromHAR(har: string, options: unknown): Promise<void> {
    this.harRoutes.push({ har, options });
  }

  async route(pattern: string, handler: (route: FakeRoute) => unknown): Promise<void> {
    this.routePattern = pattern;
    this.handler = handler;
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

/** Drives one URL through whatever handler `newContext` installed. */
async function driveRoute(context: FakeContext, url: string): Promise<'continue' | 'abort' | 'none'> {
  if (context.handler === undefined) return 'none';
  let verdict: 'continue' | 'abort' = 'continue';
  const route: FakeRoute = {
    request: () => ({ url: () => url }),
    continue: async () => {
      verdict = 'continue';
    },
    abort: async () => {
      verdict = 'abort';
    },
  };
  await context.handler(route);
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
  it('replay intercepts from the HAR and aborts anything not in it', async () => {
    const fake = new FakeBrowser();
    const context = await newContext(browserOf(fake), {
      viewport,
      network: 'replay',
      har: '/tmp/checkout.har',
    });
    const created = context as unknown as FakeContext;
    expect(created.harRoutes).toEqual([
      { har: '/tmp/checkout.har', options: { notFound: 'abort', update: false } },
    ]);
    expect(fake.optionsSeen[0]?.recordHar).toBeUndefined();
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
