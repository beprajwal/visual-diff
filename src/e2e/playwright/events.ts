/**
 * `e2e/playwright` — the trace event vocabulary.
 *
 * Every `*.trace` entry is NDJSON: one JSON object per line, the first of which is always
 * `context-options` and carries the format version and the capture-condition fingerprint. The rest
 * are the event types below. Only the fields the reader uses are declared; the archive carries
 * more, and an unknown `type` is skipped rather than treated as corruption, because a newer
 * *supported* version may add events that do not change how the ones we read behave.
 *
 * Two shapes here are not obvious from the format's name:
 *
 * - `frame-snapshot` wraps its payload in a `snapshot` key, unlike every other event.
 * - `screencast-frame.width`/`height` are the **logical viewport**, never the image size. See
 *   `../jpeg.ts` — reading them as pixel dimensions is the format's most expensive trap.
 */

export interface TraceViewportSize {
  width: number;
  height: number;
}

export interface ContextOptionsEvent {
  type: 'context-options';
  /** Absent means version 6 by Playwright's own modernizer rule, which is below our floor. */
  version?: number;
  origin?: 'library' | 'testRunner';
  browserName?: string;
  channel?: string;
  playwrightVersion?: string;
  platform?: string;
  /** Epoch milliseconds at the moment `monotonicTime` was taken; the two together are the clock. */
  wallTime?: number;
  monotonicTime?: number;
  sdkLanguage?: string;
  testIdAttributeName?: string;
  contextId?: string;
  testTimeout?: number;
  /**
   * `tracing.start({ title })` / `startChunk({ title })` for a library trace; the runner's
   * `relPath:line › describe › test` for the library half of a runner archive. The runner's own
   * `test.trace` carries no title at all.
   */
  title?: string;
  options?: {
    viewport?: TraceViewportSize | null;
    deviceScaleFactor?: number;
    colorScheme?: string;
    locale?: string;
    isMobile?: boolean;
    hasTouch?: boolean;
    reducedMotion?: string;
    channel?: string;
  };
}

export interface BeforeActionEvent {
  type: 'before';
  callId: string;
  startTime: number;
  class: string;
  method: string;
  params?: Record<string, unknown>;
  /** Present from v8. In v7 the same string lives under `apiName` — see `modernize.ts`. */
  title?: string;
  apiName?: string;
  stepId?: string;
  parentId?: string;
  pageId?: string;
  beforeSnapshot?: string;
}

export interface AfterActionEvent {
  type: 'after';
  callId: string;
  endTime: number;
  afterSnapshot?: string;
  error?: { error?: { message?: string; stack?: string }; message?: string } | null;
  result?: unknown;
}

export interface InputActionEvent {
  type: 'input';
  callId: string;
  point?: { x: number; y: number };
  inputSnapshot?: string;
}

export interface FrameSnapshotPayload {
  callId?: string;
  snapshotName: string;
  pageId: string;
  frameId: string;
  frameUrl: string;
  doctype?: string;
  /** Recursive `["TAG", {attrs}, ...children]`, with `[[back, node]]` subtree back-references. */
  html: unknown;
  viewport: TraceViewportSize;
  timestamp: number;
  wallTime?: number;
  isMainFrame?: boolean;
}

export interface FrameSnapshotEvent {
  type: 'frame-snapshot';
  snapshot: FrameSnapshotPayload;
}

export interface ScreencastFrameEvent {
  type: 'screencast-frame';
  pageId: string;
  /** Resource entry name, of the form `<pageGuid>-<epochMs>.jpeg`. */
  sha1: string;
  /** The logical viewport. NOT the image's pixel size. */
  width: number;
  height: number;
  /** Monotonic milliseconds. */
  timestamp: number;
  /** Epoch milliseconds of the compositor swap; the preferred key for frame association. */
  frameSwapWallTime?: number;
}

export interface ConsoleTraceEvent {
  type: 'console';
  messageType?: string;
  text?: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
  time: number;
  pageId?: string;
}

/** Page lifecycle and page errors: `{ class: 'BrowserContext', method: 'page' | 'pageError' }`. */
export interface BrowserContextEvent {
  type: 'event';
  time: number;
  class: string;
  method: string;
  params?: Record<string, unknown>;
  pageId?: string;
}

export interface LogTraceEvent {
  type: 'log';
  callId: string;
  time?: number;
  message?: string;
}

export type TraceEvent =
  | ContextOptionsEvent
  | BeforeActionEvent
  | AfterActionEvent
  | InputActionEvent
  | FrameSnapshotEvent
  | ScreencastFrameEvent
  | ConsoleTraceEvent
  | BrowserContextEvent
  | LogTraceEvent;

/** An event whose `type` this build does not model. Skipped, never an error. */
export interface UnknownTraceEvent {
  type: string;
  [key: string]: unknown;
}

export type AnyTraceEvent = TraceEvent | UnknownTraceEvent;

/** One `resource-snapshot` line of a `*.network` file: a HAR entry with Playwright's extras. */
export interface ResourceSnapshotEvent {
  type?: 'resource-snapshot';
  snapshot: {
    pageref?: string;
    _frameref?: string;
    startedDateTime?: string;
    time?: number;
    request?: { method?: string; url?: string };
    response?: { status?: number; content?: { _sha1?: string; mimeType?: string } };
    _monotonicTime?: number;
    _resourceType?: string;
  };
}

/* ------------------------------------------------------------------ guards */

export function isContextOptions(event: AnyTraceEvent): event is ContextOptionsEvent {
  return event.type === 'context-options';
}

export function isBefore(event: AnyTraceEvent): event is BeforeActionEvent {
  return event.type === 'before';
}

export function isAfter(event: AnyTraceEvent): event is AfterActionEvent {
  return event.type === 'after';
}

export function isInput(event: AnyTraceEvent): event is InputActionEvent {
  return event.type === 'input';
}

export function isFrameSnapshot(event: AnyTraceEvent): event is FrameSnapshotEvent {
  return (
    event.type === 'frame-snapshot' &&
    typeof (event as FrameSnapshotEvent).snapshot === 'object' &&
    (event as FrameSnapshotEvent).snapshot !== null
  );
}

export function isScreencastFrame(event: AnyTraceEvent): event is ScreencastFrameEvent {
  return event.type === 'screencast-frame' && typeof (event as ScreencastFrameEvent).sha1 === 'string';
}

export function isConsole(event: AnyTraceEvent): event is ConsoleTraceEvent {
  return event.type === 'console';
}

export function isBrowserContextEvent(event: AnyTraceEvent): event is BrowserContextEvent {
  return event.type === 'event';
}

/** The error message an `after` event carries, whichever of the two shapes it used. */
export function errorMessageOf(event: AfterActionEvent): string | undefined {
  const error = event.error;
  if (error === undefined || error === null) return undefined;
  const nested = error.error?.message;
  if (typeof nested === 'string' && nested !== '') return nested;
  const direct = (error as { message?: string }).message;
  return typeof direct === 'string' && direct !== '' ? direct : undefined;
}
