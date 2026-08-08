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
 */

import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';

import { DEFAULTS, type NetworkMode, type Viewport } from '../types.js';
import {
  CHROMIUM_LAUNCH_ARGS,
  LOCALE,
  TIMEZONE,
  buildInitScript,
} from './determinism.js';
import { RunnerError } from './errors.js';

export interface PlaywrightModule {
  chromium: {
    launch(options?: { headless?: boolean; args?: readonly string[] }): Promise<Browser>;
  };
}

/** Resolved lazily; `vdiff run` is the only command that ever loads Playwright. */
export async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import('playwright')) as unknown as PlaywrightModule;
  } catch (cause) {
    throw new RunnerError({
      code: 'playwright-missing',
      message: 'playwright is not installed',
      kind: 'browser-missing',
      hint: 'run `npm install` in the visual-diff checkout, then `vdiff install-browser`',
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
        hint: 'run `vdiff install-browser`',
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
  /** Absolute HAR path; required for 'record' and 'replay'. */
  har?: string;
  baseUrl?: string;
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
  if (options.network === 'record' && options.har !== undefined) {
    base.recordHar = { path: options.har, mode: 'minimal', content: 'embed' };
  }
  return base;
}

export async function newContext(browser: Browser, options: ContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext(contextOptions(options));
  await context.addInitScript({ content: buildInitScript() });

  if (options.network === 'replay' && options.har !== undefined) {
    // `notFound: 'abort'` is the whole point: silent fallthrough to the live network is the
    // failure mode that quietly destroys determinism (spec §7), so it is never allowed.
    await context.routeFromHAR(options.har, { notFound: 'abort', update: false });
  } else if (options.network === 'off') {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
      return isLocal ? route.continue() : route.abort('blockedbyclient');
    });
  }

  return context;
}

/**
 * The pre-shoot settle gate (spec §7): `document.fonts.ready`, two idle animation frames, and no
 * in-flight requests. Not a timer — a timer is how a half-rendered frame gets captured.
 */
export async function settle(page: Page, inFlight: () => number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight() > 0 && Date.now() < deadline) {
    await page.waitForTimeout(20);
  }
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
}
