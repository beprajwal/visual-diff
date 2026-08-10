/**
 * `e2e/playwright` — the Playwright trace reader (e2e spec §2, §4, §7, §8).
 *
 * One archive in, one `E2eIngest` out: the tests it contains, their steps, each step's screenshot
 * and DOM snapshot, the console and network activity around it, and an explicit statement of what
 * the archive could not provide. Everything Playwright-specific stops here; `E2eIngest` is the only
 * shape the rest of e2e mode sees, which is what makes a second reader a drop-in (§2).
 *
 * ### What it refuses, and why (§8)
 *
 * - **Not a zip / unreadable**: `archiveUnreadable`, naming the file and what went wrong.
 * - **A zip with no `.trace` entry**: `notATrace` — it is an archive, just not this kind.
 * - **A version outside 7–8**: `traceVersionUnsupported`, naming the version found and those
 *   supported. See `version.ts` for why the floor is 7 rather than "whatever modernizes".
 * - **No screenshots at all**: `noScreenshots`. This is the *default* case, not an edge case:
 *   `tracing.start()` with no options records neither screenshots nor snapshots, so a suite that
 *   enabled tracing without configuring it produces an archive with nothing to diff. §8 is explicit
 *   that a run with no shots is worse than none.
 *
 * ### The idempotency key (§6)
 *
 * `archiveHash` is a sha256 of the archive's bytes. Ingesting the same trace twice produces one
 * run whatever the file was renamed to in between, and re-recording the same test produces a
 * different hash even when every title is identical — which is the correct answer, because it is a
 * different run.
 */

import path from 'node:path';

import { hashFile } from '../../store/index.js';
import { noScreenshots, notATrace, traceCorrupt } from '../errors.js';
import { readJpegSize } from '../jpeg.js';
import { assignStepIds, flowNameFromTitle, titleKeyOf } from '../titles.js';
import { ZipArchive } from '../zip.js';
import { buildTraceModel, type ParsedPrefix, type TraceStep } from './model.js';
import { modernizeEvents } from './modernize.js';
import { discoverTracePrefixes, parseNetworkEvents, parseTraceEvents } from './parse.js';
import { assertSupportedTraceVersion, SUPPORTED_TRACE_VERSIONS } from './version.js';
import { flattenSnapshot } from './snapshots.js';
import { isContextOptions, type ContextOptionsEvent } from './events.js';
import type {
  E2eCapabilities,
  E2eCaptureMetadata,
  E2eIngest,
  E2eMissingCapability,
  E2eNotice,
  E2eReadOptions,
  E2eShot,
  E2eSniffResult,
  E2eSourceReader,
  E2eStep,
  E2eTest,
} from '../types.js';
import type { Sha256, ViewportId } from '../../types.js';

const RESOURCES_PREFIX = 'resources/';

export class PlaywrightTraceReader implements E2eSourceReader {
  readonly format = 'playwright' as const;
  readonly label = 'Playwright trace archive';
  readonly supportedVersions = SUPPORTED_TRACE_VERSIONS;

  /**
   * A cheap "is this one of ours?" check for `vdiff e2e list` and for format dispatch.
   *
   * It never throws: a failed sniff is an answer, not an error. Reading is where §8's messages are
   * raised, because reading is where a user asked for this file specifically.
   */
  async sniff(archivePath: string): Promise<E2eSniffResult> {
    let archive: ZipArchive | undefined;
    try {
      archive = await ZipArchive.open(archivePath);
      const prefixes = discoverTracePrefixes(archive.names);
      const first = prefixes[0];
      if (first === undefined) return { ok: false, reason: 'no .trace entry in the archive' };
      const text = (await archive.readText(`${first}.trace`)) ?? '';
      const line = text.split('\n', 1)[0] ?? '';
      const options = line === '' ? undefined : (JSON.parse(line) as ContextOptionsEvent);
      if (options === undefined || options.type !== 'context-options') {
        return { ok: false, reason: `${first}.trace does not begin with a context-options event` };
      }
      return { ok: true, format: this.format, formatVersion: options.version ?? 0 };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      await archive?.close();
    }
  }

  async read(archivePath: string, options: E2eReadOptions = {}): Promise<E2eIngest> {
    const absolute = path.resolve(archivePath);
    const archiveHash = await hashFile(absolute);
    const archive = await ZipArchive.open(absolute);
    try {
      return await readArchive(archive, absolute, archiveHash, options);
    } finally {
      await archive.close();
    }
  }
}

/** The reader instance the module edge exports. Stateless; one is enough. */
export const playwrightTraceReader = new PlaywrightTraceReader();

/* ------------------------------------------------------------------ the read */

async function readArchive(
  archive: ZipArchive,
  archivePath: string,
  archiveHash: Sha256,
  options: E2eReadOptions,
): Promise<E2eIngest> {
  const prefixes = discoverTracePrefixes(archive.names);
  if (prefixes.length === 0) throw notATrace(archivePath, archive.names.length);

  const parsed: ParsedPrefix[] = [];
  let formatVersion = 0;
  let modernized = false;
  let networkFilePresent = false;

  for (const prefix of prefixes) {
    const entry = `${prefix}.trace`;
    const text = (await archive.readText(entry)) ?? '';
    const events = parseTraceEvents(archivePath, entry, text);
    const head = events[0];
    if (head === undefined || !isContextOptions(head)) {
      throw traceCorrupt(
        archivePath,
        `${entry} does not begin with a context-options event, so its format version is unknown`,
      );
    }
    const version = assertSupportedTraceVersion(archivePath, head.version);
    formatVersion = Math.max(formatVersion, version);
    const upgraded = modernizeEvents(events, version);
    if (upgraded.changed) modernized = true;

    const networkEntry = `${prefix}.network`;
    let network: ParsedPrefix['network'] = [];
    if (archive.has(networkEntry)) {
      const networkText = (await archive.readText(networkEntry)) ?? '';
      if (networkText.trim() !== '') networkFilePresent = true;
      network = parseNetworkEvents(archivePath, networkEntry, networkText);
    }

    parsed.push({ prefix, options: head, events: upgraded.events, network });
  }

  const model = buildTraceModel(parsed);
  if (model.screencast.count === 0) throw noScreenshots(archivePath);

  const contextOptions = pickContextOptions(parsed);
  const metadata = readMetadata(contextOptions, formatVersion, originOf(parsed));
  const capabilities = readCapabilities({
    screenshots: model.screencast.count > 0,
    domSnapshots: model.snapshots.count > 0,
    network: networkFilePresent && model.network.length > 0,
  });

  const notices: E2eNotice[] = [];
  if (modernized) {
    notices.push({
      kind: 'modernized',
      message:
        'trace format version 7 read as version 8: action titles were taken from the pre-rename ' +
        "'apiName' field",
    });
  }
  if (model.skippedInfrastructure > 0) {
    notices.push({
      kind: 'skipped-infrastructure',
      message: `${model.skippedInfrastructure} runner hook, fixture and tracing calls were not turned into steps`,
    });
  }

  const test = await buildTest({
    archive,
    archivePath,
    model,
    metadata,
    options,
    notices,
  });

  return {
    format: 'playwright',
    archivePath,
    archiveHash,
    metadata,
    capabilities,
    tests: [test],
    notices,
  };
}

/**
 * The context-options line the capture metadata is read from.
 *
 * A runner archive has two kinds. The runner's own (`origin: 'testRunner'`) carries no browser, no
 * viewport and no title — only a test timeout. The library halves carry everything, including the
 * test title. So a library context wins whenever there is one.
 */
function pickContextOptions(prefixes: readonly ParsedPrefix[]): ContextOptionsEvent {
  const library = prefixes.find((prefix) => prefix.options.origin === 'library');
  return (library ?? prefixes[0] as ParsedPrefix).options;
}

/**
 * Whether the archive came from `@playwright/test` or from the library.
 *
 * Read across every prefix rather than off the one the metadata is taken from: a runner archive's
 * library halves each declare `origin: 'library'`, and only its `test.trace` declares the runner. An
 * archive that contains a runner-origin context *is* a runner archive, and callers use this to know
 * whether step titles and a test title can be expected at all.
 */
function originOf(prefixes: readonly ParsedPrefix[]): E2eCaptureMetadata['origin'] {
  if (prefixes.some((prefix) => prefix.options.origin === 'testRunner')) return 'testRunner';
  if (prefixes.some((prefix) => prefix.options.origin === 'library')) return 'library';
  return 'unknown';
}

function readMetadata(
  options: ContextOptionsEvent,
  formatVersion: number,
  origin: E2eCaptureMetadata['origin'],
): E2eCaptureMetadata {
  const metadata: E2eCaptureMetadata = {
    tool: 'playwright',
    formatVersion,
    origin,
  };
  if (options.playwrightVersion !== undefined) metadata.toolVersion = options.playwrightVersion;
  if (options.browserName !== undefined && options.browserName !== '') {
    metadata.browser = options.browserName;
  }
  const channel = options.channel ?? options.options?.channel;
  if (channel !== undefined && channel !== '') metadata.channel = channel;
  if (options.platform !== undefined) metadata.platform = options.platform;
  const viewport = options.options?.viewport;
  if (viewport !== null && viewport !== undefined) {
    metadata.viewport = { w: viewport.width, h: viewport.height };
  }
  if (options.options?.deviceScaleFactor !== undefined) {
    metadata.deviceScaleFactor = options.options.deviceScaleFactor;
  }
  if (options.options?.colorScheme !== undefined) metadata.colorScheme = options.options.colorScheme;
  if (options.options?.locale !== undefined) metadata.locale = options.options.locale;
  if (typeof options.wallTime === 'number') {
    metadata.startedAt = new Date(options.wallTime).toISOString();
  }
  return metadata;
}

/**
 * What the archive provided (§4).
 *
 * `revision`, `project-name` and `retry-index` are always listed as missing. That is not pessimism:
 * a trace archive contains no git metadata at any version under any configuration — `captureGitInfo`
 * writes to the *reporter's* metadata, never into the zip — and project name and retry index exist
 * only in the output directory's name. Recording them as unavailable is what stops an e2e run being
 * silently attributed to whatever happens to be checked out locally (§7).
 */
function readCapabilities(present: {
  screenshots: boolean;
  domSnapshots: boolean;
  network: boolean;
}): E2eCapabilities {
  const missing: E2eMissingCapability[] = ['computed-styles', 'accessibility-tree', 'element-geometry'];
  if (!present.domSnapshots) missing.push('dom-snapshots');
  if (!present.network) missing.push('network');
  missing.push('full-page-screenshots', 'revision', 'project-name', 'retry-index');
  return {
    screenshots: present.screenshots,
    domSnapshots: present.domSnapshots,
    network: present.network,
    console: true,
    computedStyles: false,
    accessibilityTree: false,
    elementGeometry: false,
    missing,
  };
}

interface BuildTestInput {
  archive: ZipArchive;
  archivePath: string;
  model: ReturnType<typeof buildTraceModel>;
  metadata: E2eCaptureMetadata;
  options: E2eReadOptions;
  notices: E2eNotice[];
}

async function buildTest(input: BuildTestInput): Promise<E2eTest> {
  const { archive, archivePath, model, metadata, options, notices } = input;

  // A library trace has no test concept at all: the only title-bearing field is whatever the caller
  // passed to tracing.start({ title }). Falling back to the file name is honest — it says where the
  // name came from — and keeps an untitled archive ingestible.
  const fallbackTitle = path.basename(archivePath).replace(/\.zip$/i, '');
  const title = model.title ?? fallbackTitle;
  const titleKey = titleKeyOf(title);
  const flow = options.flow ?? flowNameFromTitle(titleKey, 'e2e');

  const assigned = assignStepIds(
    model.steps.map((step) => ({ title: step.title, key: step.title })),
    options.stepIds ?? {},
  );
  if (assigned.duplicates.length > 0) {
    notices.push({
      kind: 'duplicate-step-titles',
      message: `duplicate step titles disambiguated with a numeric suffix: ${assigned.duplicates
        .map((duplicate) => `'${duplicate}'`)
        .join(', ')}`,
    });
  }
  if (model.steps.length > 0 && model.steps.every((step) => step.titleSource === 'synthesized')) {
    notices.push({
      kind: 'synthesized-step-ids',
      message:
        'the trace carries no step titles, so step ids were synthesized from each call and its ' +
        'selector; they will change when a locator changes. Wrap steps in tracing.group() or ' +
        'test.step() for stable ids, or pin them in .visual-diff/e2e-map.yaml',
    });
  }

  const bytesByResource = new Map<string, Uint8Array>();
  const shotUsage = new Map<string, number>();
  const steps: E2eStep[] = [];

  for (const [index, traceStep] of model.steps.entries()) {
    const id = assigned.ids[index] as string;
    const shot = await readShot({ archive, archivePath, model, step: traceStep, bytesByResource });
    if (shot !== null) shotUsage.set(shot.resource, (shotUsage.get(shot.resource) ?? 0) + 1);
    steps.push(buildStep({ id, index, traceStep, model, shot }));
  }

  attachActivity(steps, model);

  // `shared` can only be known once every step has chosen; a frame used twice is normal, and saying
  // so is what keeps the report from presenting a repeated image as a defect.
  let sharedCount = 0;
  for (const step of steps) {
    if (step.shot !== null && (shotUsage.get(step.shot.resource) ?? 0) > 1) {
      step.shot.shared = true;
      sharedCount += 1;
    }
  }
  if (sharedCount > 0) {
    notices.push({
      kind: 'shared-screenshots',
      message: `${sharedCount} of ${steps.length} steps share a screenshot with another step: screencast frames are throttled, so several actions legitimately resolve to one image`,
    });
  }

  // An archive whose every action was runner infrastructure yields no steps. Falling back to the
  // context's own start beats reporting a test that began at the Unix epoch.
  const contextStartedAtMs =
    metadata.startedAt === undefined ? Date.now() : Date.parse(metadata.startedAt);
  const startedAtMs =
    steps.length === 0 ? contextStartedAtMs : Math.min(...model.steps.map((step) => step.startedAtMs));
  const finishedAtMs =
    steps.length === 0 ? contextStartedAtMs : Math.max(...model.steps.map((step) => step.finishedAtMs));

  return {
    title,
    titleKey,
    flow,
    flowSource: options.flow === undefined ? 'derived' : 'override',
    steps,
    viewport: viewportIdOf(metadata),
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
  };
}

function viewportIdOf(metadata: E2eCaptureMetadata): ViewportId | null {
  const viewport = metadata.viewport;
  return viewport === undefined ? null : `${viewport.w}x${viewport.h}`;
}

interface BuildStepInput {
  id: string;
  index: number;
  traceStep: TraceStep;
  model: ReturnType<typeof buildTraceModel>;
  shot: E2eShot | null;
}

function buildStep(input: BuildStepInput): E2eStep {
  const { id, index, traceStep, model, shot } = input;
  const resolved =
    traceStep.pageId !== undefined && traceStep.snapshotName !== undefined
      ? model.snapshots.resolve(traceStep.pageId, traceStep.snapshotName)
      : undefined;

  const step: E2eStep = {
    id,
    title: traceStep.title,
    index,
    origin: {
      callId: traceStep.root.callId,
      class: traceStep.root.class,
      method: traceStep.root.method,
      titleSource: traceStep.titleSource,
    },
    startedAt: new Date(traceStep.startedAtMs).toISOString(),
    finishedAt: new Date(traceStep.finishedAtMs).toISOString(),
    durationMs: Math.max(0, Math.round(traceStep.finishedAtMs - traceStep.startedAtMs)),
    status: traceStep.error === undefined ? 'ok' : 'failed',
    shot,
    dom:
      resolved === undefined
        ? null
        : {
            name: resolved.payload.snapshotName,
            url: resolved.payload.frameUrl,
            viewport: { w: resolved.payload.viewport.width, h: resolved.payload.viewport.height },
            capturedAt: new Date(
              resolved.payload.wallTime ?? traceStep.finishedAtMs,
            ).toISOString(),
            nodes: flattenSnapshot(resolved.root),
          },
    console: [],
    network: [],
  };
  if (traceStep.selector !== undefined) step.origin.selector = traceStep.selector;
  if (traceStep.pageId !== undefined) step.origin.pageId = traceStep.pageId;
  if (traceStep.error !== undefined) step.error = traceStep.error;
  if (resolved !== undefined) step.url = resolved.payload.frameUrl;
  return step;
}

interface ReadShotInput {
  archive: ZipArchive;
  archivePath: string;
  model: ReturnType<typeof buildTraceModel>;
  step: TraceStep;
  bytesByResource: Map<string, Uint8Array>;
}

/**
 * The screenshot for one step.
 *
 * The target time is the step's own snapshot when it has one — that is the moment the trace viewer
 * shows for the step — and its end otherwise. Frame association is by wall-clock swap time, nearest
 * in either direction, which is exactly what Playwright does; `skewMs` records how far off the
 * chosen frame was, since that distance, and not pixel noise, is where e2e misalignment comes from.
 */
async function readShot(input: ReadShotInput): Promise<E2eShot | null> {
  const { archive, archivePath, model, step, bytesByResource } = input;
  const pageId = step.pageId;
  if (pageId === undefined) return null;

  const snapshot =
    step.snapshotName === undefined ? undefined : model.snapshots.resolve(pageId, step.snapshotName);
  const last = step.subtree[step.subtree.length - 1] ?? step.root;
  const target =
    snapshot === undefined
      ? { wallTime: step.finishedAtMs, timestamp: last.endTime }
      : {
          ...(snapshot.payload.wallTime === undefined ? {} : { wallTime: snapshot.payload.wallTime }),
          timestamp: snapshot.payload.timestamp,
        };

  const match = model.screencast.closest(pageId, target);
  if (match === undefined) return null;

  const resource = `${RESOURCES_PREFIX}${match.frame.sha1}`;
  let bytes = bytesByResource.get(resource);
  if (bytes === undefined) {
    const read = await archive.read(resource);
    if (read === undefined) {
      throw traceCorrupt(
        archivePath,
        `the trace references screenshot '${resource}', which the archive does not contain`,
      );
    }
    bytes = read;
    bytesByResource.set(resource, bytes);
  }

  const size = readJpegSize(bytes);
  if (size === null) {
    throw traceCorrupt(archivePath, `screenshot '${resource}' is not a readable JPEG`);
  }

  const viewport = match.frame.viewport;
  const capturedAtMs = match.frame.frameSwapWallTime ?? target.wallTime ?? step.finishedAtMs;
  return {
    resource,
    bytes,
    encoding: 'jpeg',
    width: size.width,
    height: size.height,
    viewport,
    scale: viewport.w === 0 ? 1 : round4(size.width / viewport.w),
    capturedAt: new Date(capturedAtMs).toISOString(),
    skewMs: match.skewMs,
    shared: false,
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/* ------------------------------------------------------------------ console and network */

/**
 * Attaches console messages and network requests to the step they happened during.
 *
 * Both are recorded against the context, not against a call, so the association is by time: the
 * step whose window contains the event, and failing that the most recent step that had already
 * started — a response that arrives after its step ended still belongs to it. Nothing is dropped,
 * because "the trace recorded a console error and we discarded it" is not a defensible outcome.
 *
 * Console and page errors are present in *every* archive: unlike screenshots and network, they are
 * recorded unconditionally whenever tracing is active, including with both options off.
 */
function attachActivity(steps: readonly E2eStep[], model: ReturnType<typeof buildTraceModel>): void {
  if (steps.length === 0) return;
  const windows = steps.map((step, index) => ({
    step,
    startMs: Date.parse(step.startedAt),
    endMs: Date.parse(step.finishedAt),
    index,
  }));

  const locate = (atMs: number, pageId: string | undefined): E2eStep | undefined => {
    let fallback: E2eStep | undefined;
    for (const window of windows) {
      if (pageId !== undefined && window.step.origin.pageId !== undefined && window.step.origin.pageId !== pageId) {
        continue;
      }
      if (window.startMs <= atMs) fallback = window.step;
      if (window.startMs <= atMs && atMs <= window.endMs) return window.step;
    }
    return fallback ?? windows[0]?.step;
  };

  for (const entry of model.console) {
    const step = locate(entry.atMs, entry.pageId);
    if (step === undefined) continue;
    const { atMs: _atMs, pageId: _pageId, ...rest } = entry;
    step.console.push(rest);
  }
  for (const entry of model.network) {
    const step = locate(entry.atMs, entry.pageId);
    if (step === undefined) continue;
    const { atMs: _atMs, pageId: _pageId, ...rest } = entry;
    step.network.push(rest);
  }
}
