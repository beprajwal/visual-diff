/**
 * `e2e/` — the format-agnostic ingestion contract (e2e spec §2, §4, §7).
 *
 * E2E mode reads artifacts a test suite already produced and turns them into runs. The spec is
 * explicit that only a Playwright reader ships, but that "the ingestion layer stays format-agnostic
 * internally so a second reader can be added without reshaping the pipeline" (§2). This file is
 * that seam: everything below `E2eSourceReader` is Playwright-specific, everything above it is
 * expressed in the vocabulary the store and the diff engine already speak.
 *
 * The intermediate structure is deliberately *not* the store's `RunMeta`/`StepResult` shape. A
 * reader answers what the archive contained; deciding what a run looks like on disk belongs to the
 * ingest layer. The one place the two meet is `to-shots.ts`, which converts an ingested step into
 * the shot payload the diff engine consumes.
 *
 * ### Why capabilities are a first-class field
 *
 * §4 states the material gap plainly: a trace has no computed styles and no accessibility tree, so
 * the layered diff degrades and `findings.json` must mark these runs "so the report can explain the
 * reduced detail rather than appear to have missed something". A boolean buried in a reader would
 * not survive that trip, so every ingest carries an explicit `E2eCapabilities` naming what was
 * present, what was absent, and — for the entries that are conditional on how tracing was
 * configured — why.
 */

import type { IsoDate, Sha256, Size, StepId, ViewportId } from '../types.js';

/* ------------------------------------------------------------------ formats */

/**
 * Archive formats the ingestion layer knows. A union of one today; the point of naming it is that
 * `E2eIngest.format` is a value a second reader can add to without any consumer changing shape.
 */
export const E2E_SOURCE_FORMATS = ['playwright'] as const;
export type E2eSourceFormat = (typeof E2E_SOURCE_FORMATS)[number];

/* ------------------------------------------------------------------ capabilities (§4) */

/**
 * The capture facts a trace cannot supply, named so `findings.json` can label the degraded diff.
 *
 * `computed-styles` and `accessibility-tree` are unconditional: no Playwright trace at any version
 * under any configuration carries either (§4). The rest are conditional on how the suite configured
 * tracing, which is why they are reported per archive rather than assumed.
 */
export const E2E_MISSING_CAPABILITIES = [
  /** §4: the `computed-style subset` row. Property-level findings are impossible. */
  'computed-styles',
  /** §4: no accessibility tree in the archive. */
  'accessibility-tree',
  /**
   * Snapshots carry attributes only — no box metrics, no `getComputedStyle` output — so every node
   * arrives without geometry. Pixel regions still work; attributing a region to the element under
   * it does not, because there are no rects to intersect.
   */
  'element-geometry',
  /** `tracing.start({ snapshots: false })`: no `frame-snapshot` events, so no DOM at all. */
  'dom-snapshots',
  /** Network is gated on `snapshots`: with snapshots off, `trace.network` is a zero-byte file. */
  'network',
  /**
   * Screenshots in a trace are the viewport composite at whatever scroll offset the page was at,
   * never a full-page capture. Always reported, because a trace can never provide one.
   */
  'full-page-screenshots',
  /**
   * §7 correction: there is no git metadata in a trace archive at any version. `captureGitInfo`
   * writes to the *reporter's* metadata, never into the zip, so revision is unknown unless the
   * caller supplies it.
   */
  'revision',
  /** The project name exists only in the output directory name, never inside the archive. */
  'project-name',
  /** Likewise the retry index: `…-chromium-desktop-retry2` is the only place it appears. */
  'retry-index',
] as const;
export type E2eMissingCapability = (typeof E2E_MISSING_CAPABILITIES)[number];

/** What this archive actually provided, and what it did not (§4). */
export interface E2eCapabilities {
  /** At least one screenshot was recorded. False is an ingest failure per §8, not a degradation. */
  screenshots: boolean;
  /** DOM snapshots were recorded (`snapshots: true`). */
  domSnapshots: boolean;
  /** Network entries were recorded — only ever true when `domSnapshots` is. */
  network: boolean;
  /** Console and page errors. Recorded unconditionally whenever tracing is active. */
  console: boolean;
  /** Always false: §4's `computed-style subset` row, and the reason the layered diff degrades. */
  computedStyles: false;
  /** Always false: no accessibility tree is present in a trace. */
  accessibilityTree: false;
  /** Always false: snapshots carry attributes, never box metrics. */
  elementGeometry: false;
  /** Everything absent, in a stable order, for the report's degraded-diff label. */
  missing: E2eMissingCapability[];
}

/* ------------------------------------------------------------------ capture metadata (§7) */

/**
 * The capture-condition fingerprint, read from the archive and nothing else.
 *
 * Every optional field is optional because the archive genuinely may not carry it. Three facts §7
 * assumes are *never* carried and so have no field here at all: git revision, project name and
 * retry index. They appear in `capabilities.missing` instead, so a caller that wants them has to
 * supply them rather than read an invented `unknown` and believe it came from the trace.
 */
export interface E2eCaptureMetadata {
  /** `playwright`, and the version that wrote the archive when it recorded one. */
  tool: E2eSourceFormat;
  toolVersion?: string;
  /** The integer on the `context-options` line, e.g. 8. */
  formatVersion: number;
  /** Whether the archive was written by the library or by `@playwright/test`. */
  origin: 'library' | 'testRunner' | 'unknown';
  browser?: string;
  channel?: string;
  platform?: string;
  /** The logical viewport, which is *not* the screenshot's pixel size. See `E2eShot`. */
  viewport?: Size;
  deviceScaleFactor?: number;
  colorScheme?: string;
  locale?: string;
  /** Wall-clock start of the traced context. */
  startedAt?: IsoDate;
}

/* ------------------------------------------------------------------ steps, shots, DOM */

/** A DOM node recovered from a snapshot: tag, attributes, text. No geometry, no styles (§4). */
export interface E2eDomNode {
  /** Structural path in the same `html>body>div:nth-of-type(2)` form the runner's capture uses. */
  path: string;
  parent: string | null;
  depth: number;
  /** Lower-cased tag name. */
  tag: string;
  /** First present `data-test*` attribute value — the strongest node-matching key. */
  testId?: string;
  role?: string;
  /** Direct text content, concatenated and trimmed. */
  text?: string;
  /** Author attributes, with Playwright's `__playwright_*_` sentinels stripped out. */
  attrs: Record<string, string>;
  /** Live values Playwright records as sentinel attributes: value, checked, selected, scroll. */
  state?: E2eNodeState;
  /** True for the element the action targeted (`__playwright_target__`). */
  target?: boolean;
}

export interface E2eNodeState {
  value?: string;
  checked?: boolean;
  selected?: boolean;
  scrollTop?: number;
  scrollLeft?: number;
}

/** A DOM snapshot with its delta chain resolved: self-contained, in document order. */
export interface E2eDom {
  /** The trace's own name for this snapshot, e.g. `after@call@20`. */
  name: string;
  url: string;
  /** The logical viewport recorded with the snapshot. */
  viewport: Size;
  capturedAt: IsoDate;
  nodes: E2eDomNode[];
}

/**
 * One screenshot, resolved to a real image.
 *
 * `width`/`height` are read from the JPEG header, never from the `screencast-frame` event, whose
 * `width`/`height` report the *logical viewport*: a 900x600 viewport yields a 798x532 image, and a
 * `deviceScaleFactor` of 2 changes neither number. `scale` is the ratio the diff engine needs to
 * map CSS pixels onto the image.
 */
export interface E2eShot {
  /** Entry name inside the archive, e.g. `resources/page@…-1786379958907.jpeg`. */
  resource: string;
  /**
   * The image itself, so an ingest is self-contained and no caller has to keep the archive open.
   * Steps that resolve to the same frame share one buffer — see `shared`.
   */
  bytes: Uint8Array;
  encoding: 'jpeg';
  /** True pixel dimensions, from the image itself. */
  width: number;
  height: number;
  /** The logical viewport this frame composited. */
  viewport: Size;
  /** Image pixels per CSS pixel — `width / viewport.w`, typically well below 1. */
  scale: number;
  capturedAt: IsoDate;
  /**
   * Milliseconds from the step's snapshot point to the frame that was chosen. Negative means the
   * frame predates the snapshot, which is normal: screencast frames are throttled to ~5 fps and the
   * nearest frame in *either* direction is the one Playwright itself picks.
   */
  skewMs: number;
  /**
   * True when another step resolved to this same frame. Many-to-one is by design — a ten-action
   * trace routinely serves seventeen snapshot points from five distinct frames — so the report must
   * not present a repeated image as a defect.
   */
  shared: boolean;
}

export interface E2eConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  url?: string;
  line?: number;
  ts: IsoDate;
}

export interface E2eNetworkEntry {
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  durationMs: number | null;
  ts: IsoDate;
}

/** One ingested step: the unit a shot, a DOM snapshot and a step id hang off. */
export interface E2eStep {
  /** Normalized, collision-disambiguated, and safe as a directory name (§6 step layout, D26). */
  id: StepId;
  /** The title as the archive recorded it, before normalization. */
  title: string;
  /** Zero-based position within the test, for ordering only — never for alignment (D26). */
  index: number;
  /** Where the step came from, so a drifted id can be explained rather than merely observed. */
  origin: E2eStepOrigin;
  startedAt: IsoDate;
  finishedAt: IsoDate;
  durationMs: number;
  status: 'ok' | 'failed';
  /** The error message the trace recorded, when the action failed. */
  error?: string;
  /** Page URL at the step's snapshot point, when a snapshot was recorded. */
  url?: string;
  shot: E2eShot | null;
  dom: E2eDom | null;
  console: E2eConsoleEntry[];
  network: E2eNetworkEntry[];
}

/**
 * How a step's title was obtained, in descending order of how stable it is.
 *
 * - `test-step` — a `test.step('…')` a human wrote. Changes only when they rename it.
 * - `group` — a `tracing.group('…')`, the library's analogue of `test.step` and the only way to get
 *   a written step name without the runner.
 * - `generated` — a display string Playwright synthesized from the locator, e.g.
 *   `Click getByRole('button', { name: 'Fetch' })`. Present only in runner archives, and it moves
 *   whenever the selector moves.
 * - `synthesized` — the archive carried no title at all, so this reader described the call from its
 *   class, method and selector. That is a *selector*, not a name, and D26's drift applies in full.
 */
export type E2eStepTitleSource = 'test-step' | 'group' | 'generated' | 'synthesized';

export interface E2eStepOrigin {
  /** `call@20` / `test.step@96` — the trace's own identifier, unique within the archive. */
  callId: string;
  /** e.g. `Frame` / `Test`. */
  class: string;
  /** e.g. `click` / `test.step`. */
  method: string;
  selector?: string;
  titleSource: E2eStepTitleSource;
  /** Page the step acted on, when it acted on one. */
  pageId?: string;
}

/* ------------------------------------------------------------------ tests and archives */

/** One ingested test: the unit that becomes a flow (D26). */
export interface E2eTest {
  /**
   * The archive's own title, verbatim. For a runner trace this is
   * `<path relative to testDir>:<line> › <describe…> › <test>` with U+203A separators; for a
   * library trace it is whatever was passed to `tracing.start({ title })`.
   */
  title: string;
  /**
   * The title with the `:line` stripped out of its leading path segment, which is the form a flow
   * key is derived from. Inserting an import above a test changes `title` and leaves this
   * unchanged — the D26 hazard, and the reason a flow key is never derived from `title` directly.
   */
  titleKey: string;
  /** Flow name derived from `titleKey`, or the `--flow` override when one was given (§6). */
  flow: string;
  /** Whether `flow` came from the archive or from the caller. */
  flowSource: 'derived' | 'override';
  steps: E2eStep[];
  /** The viewport steps were captured at, in the store's `WIDTHxHEIGHT` form. */
  viewport: ViewportId | null;
  startedAt: IsoDate;
  finishedAt: IsoDate;
}

/** A notice: something worth reporting once, which is not an error (§8). */
export interface E2eNotice {
  kind: E2eNoticeKind;
  message: string;
}

export const E2E_NOTICE_KINDS = [
  /** §8: "duplicate step titles within a test — disambiguated with a stable suffix". */
  'duplicate-step-titles',
  /** Runner infrastructure (hooks, fixtures) was skipped rather than turned into steps. */
  'skipped-infrastructure',
  /** Steps that resolved to a screenshot another step also uses. Expected, never a defect. */
  'shared-screenshots',
  /** The archive carried no step titles, so ids were synthesized from selectors (D26). */
  'synthesized-step-ids',
  /** A v7 archive was read through the `apiName` → `title` rename. */
  'modernized',
] as const;
export type E2eNoticeKind = (typeof E2E_NOTICE_KINDS)[number];

/** What one archive yielded. The intermediate structure the rest of e2e mode is written against. */
export interface E2eIngest {
  format: E2eSourceFormat;
  /** Absolute path of the archive that was read. */
  archivePath: string;
  /**
   * `sha256:<hex>` of the archive bytes. Ingestion is idempotent and keyed by this (§6): the same
   * archive read twice is the same run, whatever it was renamed to in between.
   */
  archiveHash: Sha256;
  metadata: E2eCaptureMetadata;
  capabilities: E2eCapabilities;
  tests: E2eTest[];
  notices: E2eNotice[];
}

/* ------------------------------------------------------------------ the reader seam (§2) */

export interface E2eReadOptions {
  /** `vdiff e2e --from trace <path> --flow <name>`: overrides the derived flow name (§6). */
  flow?: string;
  /**
   * Pin a title to a step id, keyed by the step's *normalized* title. This is the shape
   * `.visual-diff/e2e-map.yaml` resolves to (D26); the reader takes it as data and never reads the
   * file, so the map's parsing, its stale-entry warning (§8) and its `ignore` list stay with the
   * ingest layer.
   */
  stepIds?: Readonly<Record<string, StepId>>;
}

/**
 * A reader for one archive format (§2).
 *
 * `sniff` exists so `vdiff e2e list` and format dispatch can reject an unreadable path with the §8
 * message before any expensive parsing, and so a second reader can be selected by inspection rather
 * than by file extension.
 */
export interface E2eSourceReader {
  readonly format: E2eSourceFormat;
  /** Human name for messages, e.g. `Playwright trace archive`. */
  readonly label: string;
  /** Trace format versions this reader accepts, lowest first. */
  readonly supportedVersions: readonly number[];
  sniff(archivePath: string): Promise<E2eSniffResult>;
  read(archivePath: string, options?: E2eReadOptions): Promise<E2eIngest>;
}

export type E2eSniffResult =
  | { ok: true; format: E2eSourceFormat; formatVersion: number }
  | { ok: false; reason: string };
