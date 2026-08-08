/**
 * One viewport's replay (spec §7).
 *
 * Viewports are independent full replays in separate browser contexts (`run.ts` drives the pool):
 * reusing one context across viewports carries scroll position, focus and storage, which makes
 * mobile results depend on desktop having run first.
 *
 * Steps are stateful and sequential, so a failure invalidates everything downstream: the error, the
 * DOM at failure and a screenshot are recorded, the remaining steps become `blocked`, and the run
 * is `partial`. `--continue-on-error` re-anchors at the next `goto` step, for flows whose tail is
 * independent.
 */

import type { Browser, BrowserContext, Locator, Page } from 'playwright';

import {
  DEFAULTS,
  type A11ySnapshot,
  type ConsoleEntry,
  type ConsoleLevel,
  type DomSnapshot,
  type Expectation,
  type FlowSpec,
  type HarMatch,
  type NetworkEntry,
  type NetworkMode,
  type Rect,
  type Step,
  type StepFailure,
  type StepId,
  type StepStatus,
  type StepVerb,
  type Viewport,
  type ViewportId,
} from '../types.js';
import { newContext, settle } from './browser.js';
import { collectArgs, collectDom, toA11ySnapshot, toDomSnapshot } from './capture.js';
import { RunnerError, errorMessage, errorStack } from './errors.js';

export interface ShotBytes {
  screenshot: Uint8Array;
  dom: DomSnapshot;
  a11y: A11ySnapshot;
  width: number;
  height: number;
}

export interface StepOutcome {
  id: StepId;
  index: number;
  status: StepStatus;
  shoot: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  resolvedSelector?: string;
  shot?: ShotBytes;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  harMisses: number;
  failure?: StepFailure;
  /** Failure artefacts, written by run.ts so paths stay the store's business. */
  failureShot?: { screenshot: Uint8Array; dom: DomSnapshot };
}

export interface ViewportReplay {
  viewport: ViewportId;
  steps: StepOutcome[];
  harHits: number;
  harMisses: number;
  missedUrls: string[];
}

export interface ReplayOptions {
  browser: Browser;
  viewport: Viewport;
  flow: FlowSpec;
  baseUrl: string;
  network: NetworkMode;
  har?: string;
  continueOnError?: boolean;
  deviceScaleFactor?: number;
  maxDomNodes?: number;
  /** Per-action timeout. */
  timeoutMs?: number;
}

/** PNG dimensions straight from the IHDR chunk — no image decoder needed to size a shot. */
export function pngSize(data: Uint8Array): { width: number; height: number } {
  if (data.length < 24) return { width: 0, height: 0 };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function consoleLevel(type: string): ConsoleLevel {
  switch (type) {
    case 'error':
    case 'warning':
      return type === 'error' ? 'error' : 'warn';
    case 'info':
    case 'debug':
      return type;
    default:
      return 'log';
  }
}

/** The verb a step failed on, for `step.json#failure.verb`. */
export function verbOf(step: Step): StepVerb | undefined {
  if (step.goto !== undefined) return 'goto';
  if (step.click !== undefined) return 'click';
  if (step.fill !== undefined) return 'fill';
  if (step.press !== undefined) return 'press';
  if (step.hover !== undefined) return 'hover';
  if (step.scroll !== undefined) return 'scroll';
  if (step.waitFor !== undefined) return 'waitFor';
  if (step.expect !== undefined) return 'expect';
  if (step.viewport !== undefined) return 'viewport';
  return undefined;
}

/** The selector a step resolved against, for the D4 drift signal. */
export function selectorOf(step: Step): string | undefined {
  return (
    step.click ??
    step.hover ??
    step.waitFor ??
    step.scroll?.selector ??
    (step.fill === undefined ? undefined : Object.keys(step.fill)[0])
  );
}

function isoNow(): string {
  return new Date().toISOString();
}

async function checkExpectation(page: Page, expectation: Expectation, timeoutMs: number): Promise<void> {
  const locator: Locator = page.locator(expectation.selector);
  if (expectation.hidden === true) {
    await locator.first().waitFor({ state: 'hidden', timeout: timeoutMs });
    return;
  }
  if (expectation.visible !== false) {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
  }
  if (expectation.count !== undefined) {
    const actual = await locator.count();
    if (actual !== expectation.count) {
      throw new Error(
        `expect ${expectation.selector}: expected ${expectation.count} matches, found ${actual}`,
      );
    }
  }
  if (expectation.text !== undefined) {
    const text = (await locator.first().textContent()) ?? '';
    if (!text.includes(expectation.text)) {
      throw new Error(
        `expect ${expectation.selector}: expected text containing ${JSON.stringify(expectation.text)}, found ${JSON.stringify(text.trim())}`,
      );
    }
  }
}

async function performStep(page: Page, step: Step, timeoutMs: number): Promise<void> {
  if (step.viewport !== undefined) {
    const [width, height] = step.viewport.split('x').map(Number);
    if (Number.isInteger(width) && Number.isInteger(height) && width && height) {
      await page.setViewportSize({ width, height });
    }
  }
  if (step.goto !== undefined) {
    await page.goto(step.goto, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }
  if (step.click !== undefined) {
    await page.locator(step.click).first().click({ timeout: timeoutMs });
  }
  if (step.fill !== undefined) {
    for (const [selector, value] of Object.entries(step.fill)) {
      await page.locator(selector).first().fill(value, { timeout: timeoutMs });
    }
  }
  if (step.press !== undefined) {
    await page.keyboard.press(step.press);
  }
  if (step.hover !== undefined) {
    await page.locator(step.hover).first().hover({ timeout: timeoutMs });
  }
  if (step.scroll !== undefined) {
    const scroll = step.scroll;
    if (scroll.selector !== undefined) {
      await page.locator(scroll.selector).first().scrollIntoViewIfNeeded({ timeout: timeoutMs });
    } else if (scroll.to === 'bottom') {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    } else if (scroll.to === 'top') {
      await page.evaluate(() => window.scrollTo(0, 0));
    } else {
      const x = scroll.x ?? 0;
      const y = scroll.y ?? 0;
      await page.evaluate(([px, py]) => window.scrollTo(px ?? 0, py ?? 0), [x, y] as const);
    }
  }
  if (step.waitFor !== undefined) {
    await page.locator(step.waitFor).first().waitFor({ state: 'visible', timeout: timeoutMs });
  }
  for (const expectation of step.expect ?? []) {
    await checkExpectation(page, expectation, timeoutMs);
  }
}

async function captureShot(
  page: Page,
  step: Step,
  viewport: ViewportId,
  options: ReplayOptions,
  inFlight: () => number,
): Promise<ShotBytes> {
  const masks = step.mask ?? [];
  await settle(page, inFlight);

  const screenshot = await page.screenshot({
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    scale: 'device',
    mask: masks.map((selector) => page.locator(selector)),
    maskColor: '#ff00ff',
  });

  const raw = await page.evaluate(collectDom, collectArgs(masks, options.maxDomNodes));
  const dom = toDomSnapshot(raw, {
    step: step.id,
    viewport,
    masks,
    deviceScaleFactor: options.deviceScaleFactor ?? DEFAULTS.deviceScaleFactor,
    capturedAt: isoNow(),
  });
  const size = pngSize(screenshot);
  return {
    screenshot,
    dom,
    a11y: toA11ySnapshot(dom.nodes, step.id, viewport),
    width: size.width,
    height: size.height,
  };
}

async function captureFailure(
  page: Page,
  step: Step,
  viewport: ViewportId,
  options: ReplayOptions,
): Promise<{ screenshot: Uint8Array; dom: DomSnapshot } | undefined> {
  try {
    const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled' });
    const raw = await page.evaluate(collectDom, collectArgs([], options.maxDomNodes));
    const dom = toDomSnapshot(raw, {
      step: step.id,
      viewport,
      masks: [],
      deviceScaleFactor: options.deviceScaleFactor ?? DEFAULTS.deviceScaleFactor,
      capturedAt: isoNow(),
    });
    return { screenshot, dom };
  } catch {
    // The page may be gone entirely; a missing failure artefact must not mask the real error.
    return undefined;
  }
}

/** Index of the next `goto` step at or after `from`, or -1 — the `--continue-on-error` anchor. */
export function nextAnchor(steps: readonly Step[], from: number): number {
  for (let i = from; i < steps.length; i += 1) {
    if (steps[i]?.goto !== undefined) return i;
  }
  return -1;
}

export async function replayViewport(options: ReplayOptions): Promise<ViewportReplay> {
  const { flow, viewport } = options;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const contextOpts = {
    viewport,
    network: options.network,
    baseUrl: options.baseUrl,
    ...(options.har === undefined ? {} : { har: options.har }),
    ...(options.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: options.deviceScaleFactor }),
  };

  const context: BrowserContext = await newContext(options.browser, contextOpts);
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  let currentStep: StepId = flow.steps[0]?.id ?? '';
  let inFlight = 0;
  const consoleEntries: ConsoleEntry[] = [];
  const networkEntries: NetworkEntry[] = [];
  const missedUrls: string[] = [];
  const startedAtByRequest = new WeakMap<object, number>();

  const recordNetwork = (
    url: string,
    method: string,
    resourceType: string,
    status: number | null,
    harMatch: HarMatch,
    durationMs: number | null,
    failure?: string,
  ): void => {
    const entry: NetworkEntry = {
      step: currentStep,
      viewport: viewport.id,
      method,
      url,
      status,
      resourceType,
      harMatch,
      durationMs,
    };
    if (failure !== undefined) entry.failure = failure;
    networkEntries.push(entry);
  };

  page.on('console', (message) => {
    const location = message.location();
    const entry: ConsoleEntry = {
      step: currentStep,
      viewport: viewport.id,
      level: consoleLevel(message.type()),
      text: message.text(),
      ts: isoNow(),
    };
    if (location.url !== '') entry.url = location.url;
    if (location.lineNumber > 0) entry.line = location.lineNumber;
    consoleEntries.push(entry);
  });

  page.on('pageerror', (error) => {
    consoleEntries.push({
      step: currentStep,
      viewport: viewport.id,
      level: 'error',
      text: error.message,
      ts: isoNow(),
    });
  });

  page.on('request', (request) => {
    inFlight += 1;
    startedAtByRequest.set(request, Date.now());
  });

  page.on('requestfinished', (request) => {
    inFlight = Math.max(0, inFlight - 1);
    const started = startedAtByRequest.get(request);
    void request
      .response()
      .then((response) =>
        recordNetwork(
          request.url(),
          request.method(),
          request.resourceType(),
          response === null ? null : response.status(),
          options.network === 'record' ? 'recorded' : options.network === 'replay' ? 'hit' : 'bypassed',
          started === undefined ? null : Date.now() - started,
        ),
      )
      .catch(() => {
        /* the context may be closing; a lost timing is not a run failure */
      });
  });

  page.on('requestfailed', (request) => {
    inFlight = Math.max(0, inFlight - 1);
    const started = startedAtByRequest.get(request);
    const failure = request.failure()?.errorText ?? 'request failed';
    const miss = options.network === 'replay';
    if (miss) missedUrls.push(request.url());
    recordNetwork(
      request.url(),
      request.method(),
      request.resourceType(),
      null,
      miss ? 'miss' : options.network === 'record' ? 'recorded' : 'bypassed',
      started === undefined ? null : Date.now() - started,
      failure,
    );
  });

  const outcomes: StepOutcome[] = [];
  let blocked = false;

  try {
    for (let index = 0; index < flow.steps.length; index += 1) {
      const step = flow.steps[index] as Step;
      currentStep = step.id;
      const shoot = step.shoot !== false;
      const consoleBefore = consoleEntries.length;
      const networkBefore = networkEntries.length;
      const startedAt = isoNow();
      const startMs = Date.now();

      if (blocked) {
        outcomes.push({
          id: step.id,
          index,
          status: 'blocked',
          shoot,
          startedAt,
          finishedAt: startedAt,
          durationMs: 0,
          console: [],
          network: [],
          harMisses: 0,
        });
        continue;
      }

      let failure: StepFailure | undefined;
      let shot: ShotBytes | undefined;
      let failureShot: { screenshot: Uint8Array; dom: DomSnapshot } | undefined;

      try {
        await performStep(page, step, timeoutMs);
        if (shoot) shot = await captureShot(page, step, viewport.id, options, () => inFlight);
      } catch (error) {
        failure = { message: errorMessage(error) };
        const verb = verbOf(step);
        if (verb !== undefined) failure.verb = verb;
        const selector = selectorOf(step);
        if (selector !== undefined) failure.selector = selector;
        const stack = errorStack(error);
        if (stack !== undefined) failure.stack = stack;
        failureShot = await captureFailure(page, step, viewport.id, options);
        blocked = true;
      }

      const finishedAt = isoNow();
      const stepConsole = consoleEntries.slice(consoleBefore);
      const stepNetwork = networkEntries.slice(networkBefore);
      const outcome: StepOutcome = {
        id: step.id,
        index,
        status: failure === undefined ? 'ok' : 'failed',
        shoot,
        startedAt,
        finishedAt,
        durationMs: Date.now() - startMs,
        console: stepConsole,
        network: stepNetwork,
        harMisses: stepNetwork.filter((entry) => entry.harMatch === 'miss').length,
      };
      const resolved = selectorOf(step);
      if (resolved !== undefined) outcome.resolvedSelector = resolved;
      if (shot !== undefined) outcome.shot = shot;
      if (failure !== undefined) outcome.failure = failure;
      if (failureShot !== undefined) outcome.failureShot = failureShot;
      outcomes.push(outcome);

      if (blocked && options.continueOnError === true) {
        const anchor = nextAnchor(flow.steps, index + 1);
        if (anchor > index) {
          for (let skipped = index + 1; skipped < anchor; skipped += 1) {
            const step2 = flow.steps[skipped] as Step;
            const ts = isoNow();
            outcomes.push({
              id: step2.id,
              index: skipped,
              status: 'blocked',
              shoot: step2.shoot !== false,
              startedAt: ts,
              finishedAt: ts,
              durationMs: 0,
              console: [],
              network: [],
              harMisses: 0,
            });
          }
          index = anchor - 1;
          blocked = false;
        }
      }
    }
  } finally {
    await page.close().catch(() => undefined);
    // Closing the context is what flushes a recorded HAR to disk.
    await context.close().catch(() => undefined);
  }

  const harMisses = networkEntries.filter((entry) => entry.harMatch === 'miss').length;
  const harHits = networkEntries.filter((entry) => entry.harMatch === 'hit').length;
  return { viewport: viewport.id, steps: outcomes, harHits, harMisses, missedUrls };
}

/** Rects a viewport reported as masked; used by the run-level warning surface. */
export function maskRectsOf(replay: ViewportReplay): Rect[] {
  return replay.steps.flatMap((step) => step.shot?.dom.masks ?? []);
}

/** Guard against a flow whose steps all got dropped before replay. */
export function assertReplayable(flow: FlowSpec): void {
  if (flow.steps.length === 0) {
    throw new RunnerError({
      code: 'empty-flow',
      message: `flow "${flow.flow}" has no steps to replay`,
      kind: 'flow-invalid',
    });
  }
}
