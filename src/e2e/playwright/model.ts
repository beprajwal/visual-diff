/**
 * `e2e/playwright` — from trace events to steps.
 *
 * This is the part of the reader that decides what a *step* is, which D26 makes load-bearing: step
 * ids are what the diff aligns runs by, so the rule has to be stable under edits that do not change
 * what the test does.
 *
 * ### The rule
 *
 * Actions form a forest through `parentId`, and in a runner archive a library action links into the
 * runner's tree through `stepId` (a library `Frame.setContent` carries `stepId: "pw:api@39"`, and
 * `pw:api@39` is the runner action titled "Set content"). Once that link is followed, **a step is
 * the root of an action's parent chain**, which lands exactly where a reader would want it:
 *
 * - a `test.step('open the dashboard')` in a runner suite,
 * - a `tracing.group('open the dashboard')` in a library one — the only way to get step titles
 *   without the runner,
 * - and the action itself when it is neither grouped nor stepped.
 *
 * Two kinds of root are excluded. **Runner infrastructure** — anything under `Test.hook` or
 * `Test.fixture` — is setup, not a user-visible step: "Before Hooks", `Fixture "page"` and the
 * `Create page` beneath it are not screens anyone wants diffed. **Tracing lifecycle calls**
 * (`tracing.start`, `tracing.stopChunk`, …) are our own machinery. Both are counted and reported as
 * a notice rather than dropped silently.
 *
 * A surviving root becomes a step only if it, or something beneath it, touched a page. That is what
 * separates `Attach "note"` — a real titled action with nothing visual about it — from a click.
 *
 * ### Titles
 *
 * `titleSource` records where a step's name came from, because the three sources have very
 * different stability. `test-step` and `group` are names a human wrote. `action` is either a title
 * Playwright synthesized from a locator (`Click getByRole('button', { name: 'Fetch' })`) or, in a
 * library trace with no groups, a description this module builds from class, method and selector.
 * Both move when the selector moves, which is precisely the drift D26 warns about — so the reader
 * reports it rather than presenting a selector as if it were a name.
 */

import {
  errorMessageOf,
  isAfter,
  isBefore,
  isConsole,
  isFrameSnapshot,
  isInput,
  isScreencastFrame,
  type AnyTraceEvent,
  type ContextOptionsEvent,
  type ResourceSnapshotEvent,
} from './events.js';
import { ScreencastIndex } from './frames.js';
import { SnapshotIndex } from './snapshots.js';
import type { E2eConsoleEntry, E2eNetworkEntry, E2eStepTitleSource } from '../types.js';

/** One `<prefix>.trace` file with its siblings, already parsed. */
export interface ParsedPrefix {
  prefix: string;
  options: ContextOptionsEvent;
  events: AnyTraceEvent[];
  network: ResourceSnapshotEvent[];
}

/**
 * Converts a context's monotonic clock to epoch milliseconds.
 *
 * Every prefix carries its own `wallTime`/`monotonicTime` pair, and a runner archive's `test.trace`
 * is written by a different process from its library halves, so times are only comparable once
 * converted. Everything downstream of this module works in epoch milliseconds.
 */
export interface Clock {
  toEpoch(monotonic: number): number;
}

export function clockFor(options: ContextOptionsEvent): Clock {
  const wallTime = options.wallTime;
  const monotonicTime = options.monotonicTime;
  if (typeof wallTime !== 'number' || typeof monotonicTime !== 'number') {
    // No pair: monotonic values are all we have, and they are at least internally consistent.
    return { toEpoch: (monotonic) => monotonic };
  }
  return { toEpoch: (monotonic) => wallTime + (monotonic - monotonicTime) };
}

export interface TraceAction {
  callId: string;
  class: string;
  method: string;
  title?: string;
  params: Record<string, unknown>;
  parentId?: string;
  stepId?: string;
  pageId?: string;
  beforeSnapshot?: string;
  inputSnapshot?: string;
  afterSnapshot?: string;
  error?: string;
  /** Monotonic, within this prefix. */
  startTime: number;
  endTime: number;
  /** Epoch milliseconds. */
  startedAtMs: number;
  finishedAtMs: number;
  prefix: string;
}

export interface TraceStep {
  root: TraceAction;
  /** The root and everything beneath it, in start order. */
  subtree: TraceAction[];
  title: string;
  titleSource: E2eStepTitleSource;
  pageId?: string;
  /** The snapshot this step is illustrated by: the last one its subtree recorded. */
  snapshotName?: string;
  selector?: string;
  startedAtMs: number;
  finishedAtMs: number;
  error?: string;
}

export interface TraceModel {
  /** Every action, in start order, including the excluded ones. */
  actions: TraceAction[];
  steps: TraceStep[];
  snapshots: SnapshotIndex;
  screencast: ScreencastIndex;
  console: (E2eConsoleEntry & { pageId?: string; atMs: number })[];
  network: (E2eNetworkEntry & { pageId?: string; atMs: number })[];
  /** Actions dropped as runner setup or tracing machinery. */
  skippedInfrastructure: number;
  /** The title-bearing `context-options`, if any prefix carried one. */
  title?: string;
}

const TRACING_STEP_METHOD = 'tracingGroup';

/** Class/method pairs that are our own machinery rather than anything the test did. */
function isTracingLifecycle(action: TraceAction): boolean {
  return action.class === 'Tracing' && action.method !== TRACING_STEP_METHOD;
}

function isRunnerInfrastructure(action: TraceAction): boolean {
  return action.class === 'Test' && (action.method === 'hook' || action.method === 'fixture');
}

/* ------------------------------------------------------------------ assembly */

export function buildTraceModel(prefixes: readonly ParsedPrefix[]): TraceModel {
  const snapshots = new SnapshotIndex();
  const screencast = new ScreencastIndex();
  const consoleEntries: (E2eConsoleEntry & { pageId?: string; atMs: number })[] = [];
  const networkEntries: (E2eNetworkEntry & { pageId?: string; atMs: number })[] = [];
  const byCallId = new Map<string, TraceAction>();
  let title: string | undefined;

  for (const prefix of prefixes) {
    const clock = clockFor(prefix.options);
    if (title === undefined && typeof prefix.options.title === 'string' && prefix.options.title !== '') {
      title = prefix.options.title;
    }

    for (const event of prefix.events) {
      if (isBefore(event)) {
        const action: TraceAction = {
          callId: event.callId,
          class: event.class,
          method: event.method,
          params: event.params ?? {},
          startTime: event.startTime,
          endTime: event.startTime,
          startedAtMs: clock.toEpoch(event.startTime),
          finishedAtMs: clock.toEpoch(event.startTime),
          prefix: prefix.prefix,
        };
        if (event.title !== undefined) action.title = event.title;
        if (event.parentId !== undefined) action.parentId = event.parentId;
        if (event.stepId !== undefined) action.stepId = event.stepId;
        if (event.pageId !== undefined) action.pageId = event.pageId;
        if (event.beforeSnapshot !== undefined) action.beforeSnapshot = event.beforeSnapshot;
        byCallId.set(event.callId, action);
        continue;
      }
      if (isAfter(event)) {
        const action = byCallId.get(event.callId);
        if (action === undefined) continue;
        action.endTime = event.endTime;
        action.finishedAtMs = clock.toEpoch(event.endTime);
        if (event.afterSnapshot !== undefined) action.afterSnapshot = event.afterSnapshot;
        const message = errorMessageOf(event);
        if (message !== undefined) action.error = message;
        continue;
      }
      if (isInput(event)) {
        const action = byCallId.get(event.callId);
        if (action !== undefined && event.inputSnapshot !== undefined) {
          action.inputSnapshot = event.inputSnapshot;
        }
        continue;
      }
      if (isFrameSnapshot(event)) {
        snapshots.add(event.snapshot);
        continue;
      }
      if (isScreencastFrame(event)) {
        screencast.add(event);
        continue;
      }
      if (isConsole(event)) {
        const atMs = clock.toEpoch(event.time);
        const entry: E2eConsoleEntry & { pageId?: string; atMs: number } = {
          level: consoleLevel(event.messageType),
          text: event.text ?? '',
          ts: new Date(atMs).toISOString(),
          atMs,
        };
        if (event.location?.url !== undefined) entry.url = event.location.url;
        if (event.location?.lineNumber !== undefined) entry.line = event.location.lineNumber;
        if (event.pageId !== undefined) entry.pageId = event.pageId;
        consoleEntries.push(entry);
        continue;
      }
      // `event` lines carry page lifecycle and page errors; a page error is a console error by any
      // reasonable reading, and is recorded unconditionally whenever tracing is on.
      if (event.type === 'event') {
        const pageError = readPageError(event);
        if (pageError !== undefined) {
          const atMs = clock.toEpoch(pageError.time);
          consoleEntries.push({
            level: 'error',
            text: pageError.message,
            ts: new Date(atMs).toISOString(),
            atMs,
            ...(pageError.pageId === undefined ? {} : { pageId: pageError.pageId }),
          });
        }
      }
    }

    for (const resource of prefix.network) {
      const snapshot = resource.snapshot;
      if (snapshot === undefined || snapshot === null) continue;
      const monotonic = snapshot._monotonicTime;
      const started = snapshot.startedDateTime;
      const atMs =
        typeof monotonic === 'number'
          ? clock.toEpoch(monotonic)
          : typeof started === 'string'
            ? Date.parse(started)
            : Number.NaN;
      if (Number.isNaN(atMs)) continue;
      const entry: E2eNetworkEntry & { pageId?: string; atMs: number } = {
        method: snapshot.request?.method ?? 'GET',
        url: snapshot.request?.url ?? '',
        status: typeof snapshot.response?.status === 'number' ? snapshot.response.status : null,
        resourceType: snapshot._resourceType ?? 'other',
        durationMs: typeof snapshot.time === 'number' ? snapshot.time : null,
        ts: new Date(atMs).toISOString(),
        atMs,
      };
      if (snapshot.pageref !== undefined) entry.pageId = snapshot.pageref;
      networkEntries.push(entry);
    }
  }

  const actions = [...byCallId.values()].sort(byStart);
  linkRunnerSteps(byCallId, actions);
  const { steps, skippedInfrastructure } = deriveSteps(byCallId, actions);

  consoleEntries.sort((a, b) => a.atMs - b.atMs);
  networkEntries.sort((a, b) => a.atMs - b.atMs);

  const model: TraceModel = {
    actions,
    steps,
    snapshots,
    screencast,
    console: consoleEntries,
    network: networkEntries,
    skippedInfrastructure,
  };
  if (title !== undefined) model.title = title;
  return model;
}

function byStart(a: TraceAction, b: TraceAction): number {
  if (a.startedAtMs !== b.startedAtMs) return a.startedAtMs - b.startedAtMs;
  return a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0;
}

/**
 * Follows the runner link: a library action with no parent of its own belongs under the runner
 * action its `stepId` names. This is what merges the two halves of a runner archive into one tree,
 * and it is the only way a library action ever acquires a human-written step title.
 */
function linkRunnerSteps(byCallId: Map<string, TraceAction>, actions: readonly TraceAction[]): void {
  for (const action of actions) {
    if (action.parentId !== undefined) continue;
    const stepId = action.stepId;
    if (stepId === undefined || stepId === action.callId) continue;
    const target = byCallId.get(stepId);
    if (target !== undefined && target !== action) action.parentId = stepId;
  }
}

interface DerivedSteps {
  steps: TraceStep[];
  skippedInfrastructure: number;
}

function deriveSteps(
  byCallId: Map<string, TraceAction>,
  actions: readonly TraceAction[],
): DerivedSteps {
  const rootOf = new Map<string, TraceAction>();
  const excluded = new Set<string>();

  for (const action of actions) {
    const chain: TraceAction[] = [];
    let current: TraceAction | undefined = action;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.callId)) {
      seen.add(current.callId);
      chain.push(current);
      current = current.parentId === undefined ? undefined : byCallId.get(current.parentId);
    }
    const root = chain[chain.length - 1] as TraceAction;
    rootOf.set(action.callId, root);
    if (chain.some((link) => isRunnerInfrastructure(link) || isTracingLifecycle(link))) {
      excluded.add(action.callId);
    }
  }

  const subtrees = new Map<string, TraceAction[]>();
  let skipped = 0;
  for (const action of actions) {
    if (excluded.has(action.callId)) {
      skipped += 1;
      continue;
    }
    const root = rootOf.get(action.callId);
    if (root === undefined) continue;
    const subtree = subtrees.get(root.callId);
    if (subtree === undefined) subtrees.set(root.callId, [action]);
    else subtree.push(action);
  }

  const steps: TraceStep[] = [];
  for (const [rootId, subtree] of subtrees) {
    const root = byCallId.get(rootId);
    if (root === undefined) continue;
    subtree.sort(byStart);
    // A step has to have happened to a page; otherwise there is nothing to shoot and nothing to
    // diff. `Attach "note"` is the canonical example of a real titled action that has not.
    const withPage = subtree.find((action) => action.pageId !== undefined);
    if (withPage === undefined) continue;

    const snapshotHolder = [...subtree]
      .reverse()
      .find(
        (action) =>
          action.afterSnapshot !== undefined ||
          action.inputSnapshot !== undefined ||
          action.beforeSnapshot !== undefined,
      );
    const failed = subtree.find((action) => action.error !== undefined);
    const titled = titleOf(root, subtree);

    const step: TraceStep = {
      root,
      subtree,
      title: titled.title,
      titleSource: titled.source,
      startedAtMs: Math.min(...subtree.map((action) => action.startedAtMs), root.startedAtMs),
      finishedAtMs: Math.max(...subtree.map((action) => action.finishedAtMs), root.finishedAtMs),
    };
    step.pageId = withPage.pageId as string;
    const snapshotName =
      snapshotHolder === undefined
        ? undefined
        : (snapshotHolder.afterSnapshot ?? snapshotHolder.inputSnapshot ?? snapshotHolder.beforeSnapshot);
    if (snapshotName !== undefined) step.snapshotName = snapshotName;
    const selector = selectorOf(root) ?? selectorOf(withPage);
    if (selector !== undefined) step.selector = selector;
    if (failed?.error !== undefined) step.error = failed.error;
    steps.push(step);
  }

  steps.sort((a, b) => a.startedAtMs - b.startedAtMs);
  return { steps, skippedInfrastructure: skipped };
}

function titleOf(
  root: TraceAction,
  subtree: readonly TraceAction[],
): { title: string; source: E2eStepTitleSource } {
  if (root.title !== undefined && root.title !== '') {
    if (root.class === 'Test' && root.method === 'test.step') {
      return { title: root.title, source: 'test-step' };
    }
    if (root.method === TRACING_STEP_METHOD) return { title: root.title, source: 'group' };
    return { title: root.title, source: 'generated' };
  }
  // No title anywhere: describe the call. A library trace records none for page.click, page.fill or
  // the locator API, so this is the normal case for a suite that never calls tracing.group().
  const describable = subtree.find((action) => selectorOf(action) !== undefined) ?? root;
  return { title: describeAction(describable), source: 'synthesized' };
}

/** `click #go` / `goto http://localhost/` / `Frame.waitForFunction` — a description, not a name. */
export function describeAction(action: TraceAction): string {
  const selector = selectorOf(action);
  if (selector !== undefined) return `${action.method} ${selector}`;
  const url = action.params['url'];
  if (typeof url === 'string' && url !== '') return `${action.method} ${url}`;
  return `${action.class}.${action.method}`;
}

export function selectorOf(action: TraceAction): string | undefined {
  const selector = action.params['selector'];
  return typeof selector === 'string' && selector !== '' ? selector : undefined;
}

function consoleLevel(messageType: string | undefined): E2eConsoleEntry['level'] {
  switch (messageType) {
    case 'error':
      return 'error';
    case 'warning':
    case 'warn':
      return 'warn';
    case 'info':
      return 'info';
    case 'debug':
      return 'debug';
    default:
      return 'log';
  }
}

function readPageError(
  event: AnyTraceEvent,
): { message: string; time: number; pageId?: string } | undefined {
  const record = event as {
    class?: unknown;
    method?: unknown;
    time?: unknown;
    params?: Record<string, unknown>;
  };
  if (record.class !== 'BrowserContext' || record.method !== 'pageError') return undefined;
  const params = record.params ?? {};
  const error = params['error'] as { error?: { message?: string } } | undefined;
  const message = error?.error?.message;
  if (typeof message !== 'string' || message === '') return undefined;
  const pageId = params['pageId'];
  return {
    message,
    time: typeof record.time === 'number' ? record.time : 0,
    ...(typeof pageId === 'string' ? { pageId } : {}),
  };
}
