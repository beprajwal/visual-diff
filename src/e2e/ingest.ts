/**
 * `e2e/` — archives in, runs out (e2e spec §6, §7, §8, D25–D27).
 *
 * The reader half of this module (`playwright/`) answers *what an archive contains*. This is the
 * other half: what the store should hold as a result. It is the only file in `e2e/` that knows there
 * is a store at all, and the only one that writes anything.
 *
 * ## One computation, two entry points
 *
 * `vdiff e2e list` promises to "show what would be ingested, without writing" (§6). The only way to
 * keep that promise honestly is for the preview and the ingestion to be the *same* computation with
 * the write at the end of one of them, so {@link planIngest} and {@link ingestTraces} share
 * {@link prepare} and differ only in what they do with its answer. A `list` that computed less would
 * be a preview of something other than what runs.
 *
 * ## Four decisions live here
 *
 * **1. The flow a test lands in is decided against the store, not against the archive.** The reader
 * derives a name from the title because it has nothing else; ingestion knows which titles already
 * have flows (`e2eFlowIndex`) and which names are spoken for, so a title that has been ingested
 * before keeps its flow whatever today's slug rules would produce. That is what makes an e2e
 * timeline survive a change to the naming rules — and it is why `allocateFlowName` is consulted with
 * the names *other titles* already claimed rather than with every flow in the project: an e2e run
 * sharing a flow with replay runs is D27 working as designed (one flow, two timelines, separated by
 * `source`), not a collision to be broken.
 *
 * Precedence, highest first: `--flow`, an `e2e-map.yaml` `flows:` pin, the flow this title is
 * already ingested into, and finally a freshly allocated name.
 *
 * **2. Pins are applied after the read, not by re-reading.** `E2eReadOptions.stepIds` is flat across
 * an archive, but `e2e-map.yaml` scopes a step pin to a *test* title. Re-reading the archive once the
 * title is known would honour that scoping at the cost of parsing every zip twice; recomputing
 * `assignStepIds` over the steps the reader already produced honours it for nothing, because that
 * function is pure and the reader ran it on exactly these titles. So the ids are reassigned here,
 * with the pins that belong to this test and no others.
 *
 * **3. Idempotency is checked before the write and again by the store.** `findRunByTraceHash` decides
 * whether an archive becomes a run; `assertRunSourceConsistent` refuses at commit any run marked
 * `e2e` without a hash to be idempotent *on*. Two guards because the failure they prevent — the same
 * CI run ingested twice on every build, doubling a timeline — is silent, and a silent failure gets
 * one guard per layer that could let it through.
 *
 * **4. Nothing is written for an archive that is only being previewed, and nothing is half-written
 * for one that fails.** Every archive is read and planned before the first `beginRun`, and each run
 * is built in a temp directory the store publishes atomically, so an ingest that dies on the fourth
 * of five archives leaves three complete runs and no fragment of a fourth.
 *
 * ## What is deliberately not attempted
 *
 * A trace carries no git metadata at any format version under any configuration, so an ingested run
 * records `revision: unknown` and says so as a run warning (§7, §8). Neither the project name nor the
 * retry index is in the archive either; both live only in the output directory's name, and this
 * module does not parse paths for them, because a guess that looks like a fact is worse than an
 * absence that is one.
 */

import {
  SOURCE_E2E,
  UNKNOWN_REVISION,
  allocateFlowName,
  createE2eMapper,
  duplicateStepTitlesWarning,
  openStore,
  paths,
  sha256,
  unmatchedMapWarning,
} from '../store/index.js';
import type { E2eMapper, E2eRunInfo, E2eRunWarning, E2eSuiteMeta, Store } from '../store/index.js';
import { SCENARIO_NONE } from '../types.js';
import type {
  Config,
  ConsoleEntry,
  DomSnapshot,
  FlowSnapshot,
  NetworkEntry,
  RunEnv,
  RunId,
  RunMeta,
  RunStatus,
  RunWarning,
  Step,
  StepId,
  StepResult,
  StepStatus,
  ViewportId,
} from '../types.js';
import type { E2eOrigin } from '../report/e2e.js';
import { TOOL_VERSION } from '../version.js';
import { discoverArchives } from './discover.js';
import { E2eError, archiveUnreadable } from './errors.js';
import { frameToPng } from './image.js';
import type { ConvertedFrame } from './image.js';
import { readSource } from './registry.js';
import { assignStepIds } from './titles.js';
import { toDomSnapshot } from './to-shots.js';
import type { E2eIngest, E2eStep, E2eTest } from './types.js';

/* ------------------------------------------------------------------ the request (§6) */

/**
 * Artifact kinds `--from` accepts.
 *
 * Note this is the *CLI's* vocabulary — what the user is pointing at — and not the reader format
 * (`playwright`) that `e2e/types.ts` names. One maps onto the other; a second reader adds an entry
 * to both.
 */
export const E2E_FROM_KINDS = ['trace'] as const;
export type E2eFromKind = (typeof E2E_FROM_KINDS)[number];

/** One `vdiff e2e` invocation, exactly as `cli/ports.ts` hands it over. Nothing is pre-resolved. */
export interface E2eIngestRequest {
  from: E2eFromKind;
  /** Path or glob, exactly as typed. */
  pattern: string;
  /** Directory a relative `pattern` resolves against. */
  cwd: string;
  /** Override the flow name derived from the test title (§6). */
  flow?: string;
}

/** One archive the ingestion would read, as `vdiff e2e list` reports it (§6). */
export interface E2eArchivePlan {
  path: string;
  hash: string;
  flow: string;
  title: string | null;
  steps: string[];
  /** Steps that carry a screenshot — which is what gets written, and what §8 refuses zero of. */
  shots: number;
  traceVersion: number;
  origin: E2eOrigin;
  alreadyIngested: boolean;
  runId: RunId | null;
  notices: string[];
}

/** What `vdiff e2e list` reports, and what `vdiff e2e` acts on. Writes nothing. */
export interface E2eIngestPlan {
  from: E2eFromKind;
  pattern: string;
  archives: E2eArchivePlan[];
  unmatchedMapEntries: string[];
  warnings: string[];
}

/** One archive that became — or already was — a run. */
export interface E2eIngestedRun {
  path: string;
  hash: string;
  flow: string;
  runId: RunId;
  reused: boolean;
  steps: string[];
  shots: number;
  notices: string[];
}

export interface E2eIngestReport {
  from: E2eFromKind;
  pattern: string;
  runs: E2eIngestedRun[];
  unmatchedMapEntries: string[];
  warnings: string[];
}

/* ------------------------------------------------------------------ planning */

/** Everything decided about one archive before anything is written. */
interface PreparedArchive {
  path: string;
  ingest: E2eIngest;
  test: E2eTest;
  flow: string;
  /** Final step ids, after `e2e-map.yaml` pins. Already written back onto `test.steps`. */
  steps: string[];
  shots: number;
  viewport: ViewportId;
  alreadyIngested: boolean;
  runId: RunId | null;
  notices: string[];
  origin: E2eOrigin;
  /** Step titles that occurred more than once, and the ids their occurrences were given (§8). */
  duplicates: { title: string; ids: string[] }[];
}

interface Prepared {
  store: Store;
  mapper: E2eMapper;
  archives: PreparedArchive[];
  warnings: string[];
}

/**
 * Read every archive the pattern names and decide what each would become.
 *
 * Reads only: not one byte is written here, which is what `vdiff e2e list` relies on.
 */
async function prepare(config: Config, request: E2eIngestRequest): Promise<Prepared> {
  const store = openStore(config);
  const mapper = createE2eMapper(await store.loadE2eMap());
  const warnings: string[] = [];

  const files = await discoverArchives(request.pattern, request.cwd);
  // Which flow each already-ingested title belongs to. Grown as this batch allocates names, so two
  // archives in one invocation cannot be handed the same fresh flow.
  const claimed = new Map<string, string>(await store.e2eFlowIndex());

  const overrideFlow =
    request.flow === undefined ? undefined : paths.assertSafeSegment('flow', request.flow);

  const archives: PreparedArchive[] = [];
  for (const file of files) {
    const ingest = await readArchive(file);
    const test = ingest.tests[0];
    if (test === undefined) {
      // Unreachable through the Playwright reader, which always builds exactly one test per
      // archive; stated as an error rather than skipped so a future reader cannot ingest silence.
      throw archiveUnreadable(file, 'the archive yielded no test to ingest');
    }

    const steps = applyStepPins(mapper, test);
    const flow = resolveFlow({ overrideFlow, mapper, test, claimed });
    claimed.set(test.titleKey, flow);

    const shots = test.steps.filter((step) => step.shot !== null).length;
    const runId = await store.findRunByTraceHash(flow, ingest.archiveHash);

    archives.push({
      path: file,
      ingest,
      test,
      flow,
      steps,
      shots,
      viewport: viewportOf(test),
      alreadyIngested: runId !== null,
      runId,
      notices: ingest.notices.map((notice) => notice.message),
      origin: originOf(ingest, test),
      duplicates: duplicatesOf(test),
    });
  }

  return { store, mapper, archives, warnings };
}

/**
 * Read one archive, turning anything that is not already a typed §8 failure into one.
 *
 * The reader raises `E2eError` for every row of §8 it can recognise. What reaches here otherwise is
 * an I/O fault — a file that vanished between the glob and the open, a permission error — and those
 * have the same answer for the user: this path is not a readable trace archive.
 */
async function readArchive(file: string): Promise<E2eIngest> {
  try {
    return await readSource('playwright', file);
  } catch (err) {
    if (err instanceof E2eError) throw err;
    throw archiveUnreadable(file, err instanceof Error ? err.message : String(err), err);
  }
}

/**
 * Reassign this test's step ids with the `e2e-map.yaml` pins scoped to its title (D26).
 *
 * Writes the result back onto the steps, because everything downstream — the flow snapshot, the step
 * directories, the diff's alignment — reads `step.id`. Consulting the mapper is also what marks a pin
 * *used*, and therefore what makes the §8 stale-pin warning possible at all.
 */
function applyStepPins(mapper: E2eMapper, test: E2eTest): string[] {
  const overrides: Record<string, StepId> = {};
  for (const step of test.steps) {
    const pinned = mapper.stepIdFor(test.title, step.title);
    if (pinned !== null) overrides[step.title] = pinned;
  }
  const assigned = assignStepIds(
    test.steps.map((step) => ({ title: step.title, key: step.title })),
    overrides,
  );
  test.steps.forEach((step, index) => {
    step.id = assigned.ids[index] as StepId;
  });
  return [...assigned.ids];
}

interface FlowInput {
  overrideFlow: string | undefined;
  mapper: E2eMapper;
  test: E2eTest;
  claimed: ReadonlyMap<string, string>;
}

/** The flow this test's run belongs to, by the precedence documented in the file header. */
function resolveFlow(input: FlowInput): string {
  const { overrideFlow, mapper, test, claimed } = input;
  if (overrideFlow !== undefined) return overrideFlow;

  const pinned = mapper.flowFor(test.title);
  if (pinned !== null) return pinned;

  const existing = claimed.get(test.titleKey);
  if (existing !== undefined) return existing;

  // Only names other titles hold: a name this title already owns is the one it must keep.
  const others = new Set<string>();
  for (const [titleKey, flow] of claimed) {
    if (titleKey !== test.titleKey) others.add(flow);
  }
  // `allocateFlowName` returns null only for a title with nothing sluggable in it; the reader's own
  // derivation already fell back to the archive's file name in that case, so it is the safety net.
  return allocateFlowName(test.title, others) ?? test.flow;
}

/** Step titles that occurred more than once, with the ids their occurrences got (§8). */
function duplicatesOf(test: E2eTest): { title: string; ids: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const step of test.steps) {
    groups.set(step.title, [...(groups.get(step.title) ?? []), step.id]);
  }
  const duplicates: { title: string; ids: string[] }[] = [];
  for (const [title, ids] of groups) {
    if (ids.length > 1) duplicates.push({ title, ids });
  }
  return duplicates;
}

/** The viewport id every shot of this test is filed under. */
function viewportOf(test: E2eTest): ViewportId {
  if (test.viewport !== null) return test.viewport;
  for (const step of test.steps) {
    if (step.shot !== null) return `${step.shot.viewport.w}x${step.shot.viewport.h}`;
  }
  return '0x0';
}

/** The origin block, from what the archive genuinely carried and nothing else (§7). */
function originOf(ingest: E2eIngest, test: E2eTest): E2eOrigin {
  const meta = ingest.metadata;
  const origin: E2eOrigin = {
    traceHash: ingest.archiveHash,
    tracePath: ingest.archivePath,
    title: test.title,
    traceVersion: meta.formatVersion,
  };
  if (meta.browser !== undefined) origin.browser = meta.browser;
  if (meta.channel !== undefined) origin.channel = meta.channel;
  if (meta.toolVersion !== undefined) origin.playwrightVersion = meta.toolVersion;
  if (meta.platform !== undefined) origin.platform = meta.platform;
  return origin;
}

/* ------------------------------------------------------------------ `vdiff e2e list` (§6) */

export async function planIngest(config: Config, request: E2eIngestRequest): Promise<E2eIngestPlan> {
  const { mapper, archives, warnings } = await prepare(config, request);
  return {
    from: request.from,
    pattern: request.pattern,
    archives: archives.map((archive) => ({
      path: archive.path,
      hash: archive.ingest.archiveHash,
      flow: archive.flow,
      title: archive.test.title,
      steps: [...archive.steps],
      shots: archive.shots,
      traceVersion: archive.ingest.metadata.formatVersion,
      origin: archive.origin,
      alreadyIngested: archive.alreadyIngested,
      runId: archive.runId,
      notices: [...archive.notices],
    })),
    unmatchedMapEntries: mapper.unmatched(),
    warnings,
  };
}

/* ------------------------------------------------------------------ `vdiff e2e` (§6, §7) */

export async function ingestTraces(
  config: Config,
  request: E2eIngestRequest,
): Promise<E2eIngestReport> {
  const { store, mapper, archives, warnings } = await prepare(config, request);

  // The stale-pin list is a property of the whole batch, so it is computed once every archive has
  // had its chance to consult the map, and then recorded on each run it could have applied to.
  const unmatched = mapper.unmatched();

  const runs: E2eIngestedRun[] = [];
  const touchedFlows = new Set<string>();

  for (const archive of archives) {
    const runId = archive.runId ?? (await writeRun(store, archive, unmatched));
    if (archive.runId === null) touchedFlows.add(archive.flow);
    runs.push({
      path: archive.path,
      hash: archive.ingest.archiveHash,
      flow: archive.flow,
      runId,
      reused: archive.runId !== null,
      steps: [...archive.steps],
      shots: archive.shots,
      notices: [...archive.notices],
    });
  }

  // Retention is applied per flow that gained a run, exactly as `vdiff run` applies it: the command
  // that creates runs is the one that enforces the cap. The e2e bucket is separate (§7), so this
  // cannot evict replay history however many archives a CI run produced.
  for (const flow of touchedFlows) {
    await store.applyRetention(flow).catch(() => undefined);
  }

  return {
    from: request.from,
    pattern: request.pattern,
    runs,
    unmatchedMapEntries: unmatched,
    warnings,
  };
}

/* ------------------------------------------------------------------ writing one run (§7) */

async function writeRun(
  store: Store,
  archive: PreparedArchive,
  unmatchedPins: readonly string[],
): Promise<RunId> {
  const { test, flow, viewport } = archive;
  const draft = await store.beginRun(flow);
  try {
    const snapshot = flowSnapshot(archive);
    await draft.writeFlowSnapshot(snapshot);

    // One frame is routinely the shot of several steps (§4), so each is converted once and the same
    // bytes are written under every step id that resolved to it. Converting per step would decode
    // the same JPEG three or four times for no difference in what lands on disk.
    const converted = new Map<string, ConvertedFrame>();
    const steps: StepResult[] = [];
    for (const [index, step] of test.steps.entries()) {
      steps.push(
        await writeStep({ draft, step, index, viewport, converted, archivePath: archive.path }),
      );
    }

    const meta: Omit<RunMeta, 'runId'> & { source: typeof SOURCE_E2E; e2e: E2eRunInfo } = {
      flow,
      scenario: SCENARIO_NONE,
      source: SOURCE_E2E,
      e2e: runInfo(archive),
      flowHash: sha256(JSON.stringify(snapshot)),
      // §7: no trace carries git metadata, so this is unknown rather than "whatever is checked out".
      revision: UNKNOWN_REVISION,
      // The tool attached to nothing and spawned nothing; `attach` is the closer of the two, and
      // `source: 'e2e'` is what a reader actually distinguishes an ingested run by.
      mode: 'attach',
      // No HAR was consulted and no scenario served a request: an ingested run's network is whatever
      // the suite's own machinery did, which this tool did not take part in.
      network: 'off',
      harHits: 0,
      harMisses: 0,
      scenarioServed: 0,
      viewports: [viewport],
      status: statusOf(steps),
      failedSteps: steps.filter((step) => step.status === 'failed').map((step) => step.id),
      env: envOf(archive),
      startedAt: test.startedAt,
      finishedAt: test.finishedAt,
      unstable: false,
      pinned: false,
      pruned: false,
      // `E2eRunWarning` widens `RunWarningKind` structurally (see `store/internal/e2e.ts`); this is
      // the one place that widening meets the not-yet-widened field in `src/types.ts`.
      warnings: runWarnings(archive, unmatchedPins) as unknown as RunWarning[],
    };

    const committed = await draft.commit(meta);
    return committed.runId;
  } catch (err) {
    await draft.discard().catch(() => undefined);
    throw err;
  }
}

interface WriteStepInput {
  draft: Awaited<ReturnType<Store['beginRun']>>;
  step: E2eStep;
  index: number;
  viewport: ViewportId;
  converted: Map<string, ConvertedFrame>;
  archivePath: string;
}

async function writeStep(input: WriteStepInput): Promise<StepResult> {
  const { draft, step, index, viewport, converted, archivePath } = input;

  const consoleEntries: ConsoleEntry[] = step.console.map((entry) => {
    const out: ConsoleEntry = {
      step: step.id,
      viewport,
      level: entry.level,
      text: entry.text,
      ts: entry.ts,
    };
    if (entry.url !== undefined) out.url = entry.url;
    if (entry.line !== undefined) out.line = entry.line;
    return out;
  });
  const networkEntries: NetworkEntry[] = step.network.map((entry) => ({
    step: step.id,
    viewport,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    resourceType: entry.resourceType,
    // The suite's own machinery served these; no HAR of ours was consulted, and claiming a hit or a
    // miss would report coverage this tool never had.
    harMatch: 'bypassed',
    durationMs: entry.durationMs,
  }));
  await draft.writeStepConsole(step.id, consoleEntries);
  await draft.writeStepNetwork(step.id, networkEntries);

  const result: StepResult = {
    id: step.id,
    index,
    status: step.status === 'failed' ? ('failed' satisfies StepStatus) : 'ok',
    shoot: step.shot !== null,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    durationMs: step.durationMs,
    viewports: {},
    truncated: false,
    consoleErrors: consoleEntries.filter((entry) => entry.level === 'error').length,
    networkRequests: networkEntries.length,
    harMisses: 0,
  };
  if (step.error !== undefined) result.failure = { message: step.error };

  const shot = step.shot;
  if (shot !== null) {
    let frame = converted.get(shot.resource);
    if (frame === undefined) {
      try {
        frame = frameToPng(shot.bytes);
      } catch (err) {
        throw archiveUnreadable(
          archivePath,
          `${shot.resource}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      converted.set(shot.resource, frame);
    }
    const dom: DomSnapshot = toDomSnapshot(step, viewport, shot);
    result.viewports[viewport] = await draft.writeShot(step.id, {
      viewport,
      screenshot: frame.png,
      dom,
      a11y: null,
      width: frame.width,
      height: frame.height,
    });
  }

  await draft.writeStepResult(result);
  return result;
}

function statusOf(steps: readonly StepResult[]): RunStatus {
  const failed = steps.filter((step) => step.status === 'failed').length;
  if (failed === 0) return 'ok';
  return failed === steps.length ? 'failed' : 'partial';
}

/** The `flow.snapshot.yaml` an ingested run carries: the steps that ran, in the order they ran. */
function flowSnapshot(archive: PreparedArchive): FlowSnapshot {
  const steps: Step[] = archive.test.steps.map((step) => ({
    id: step.id,
    shoot: step.shot !== null,
  }));
  const snapshot: FlowSnapshot = {
    version: 1,
    flow: archive.flow,
    viewports: [archive.viewport],
    // The suite drove its own network; this tool served nothing, and `off` is the only mode that
    // says so. It is never read back as an instruction, because an ingested run is never replayed.
    network: { mode: 'off' },
    steps,
  };
  const baseUrl = originUrlOf(archive.test);
  if (baseUrl !== null) snapshot.baseUrl = baseUrl;
  return snapshot;
}

/** The origin the test ran against, when a step recorded a URL that has one. */
function originUrlOf(test: E2eTest): string | null {
  for (const step of test.steps) {
    const url = step.dom?.url ?? step.url;
    if (url === undefined || url === '') continue;
    try {
      return new URL(url).origin;
    } catch {
      continue;
    }
  }
  return null;
}

/** §7's e2e block: the trace hash, the test title, and the suite metadata the archive carried. */
function runInfo(archive: PreparedArchive): E2eRunInfo {
  const meta = archive.ingest.metadata;
  const suite: E2eSuiteMeta = { traceVersion: meta.formatVersion };
  if (meta.browser !== undefined) suite.browser = meta.browser;
  if (meta.channel !== undefined) suite.channel = meta.channel;
  if (meta.toolVersion !== undefined) suite.playwrightVersion = meta.toolVersion;
  if (meta.platform !== undefined) suite.platform = meta.platform;
  return {
    traceHash: archive.ingest.archiveHash,
    testTitle: archive.test.title,
    titleKey: archive.test.titleKey,
    archive: archive.path,
    suite,
  };
}

/**
 * `meta.json#env` for an ingested run.
 *
 * `playwright` and `os` come off the archive because the archive knows them; `chromium` does not
 * appear in a trace at any version — `context-options` names the browser, never its build — so it is
 * `unknown` rather than the word "chromium", which would read as a version somebody had checked.
 */
function envOf(archive: PreparedArchive): RunEnv {
  const meta = archive.ingest.metadata;
  return {
    tool: TOOL_VERSION,
    node: process.version,
    playwright: meta.toolVersion ?? 'unknown',
    chromium: 'unknown',
    os: meta.platform ?? process.platform,
    deviceScaleFactor: meta.deviceScaleFactor ?? 1,
  };
}

/**
 * The §8 warnings an ingested run carries on disk.
 *
 * The revision one is unconditional and that is deliberate: it is a fact about the trace format
 * rather than about this archive, and a reader who sees `revision: unknown` in a timeline needs the
 * sentence next to the run, not in the documentation.
 */
function runWarnings(archive: PreparedArchive, unmatchedPins: readonly string[]): E2eRunWarning[] {
  const warnings: E2eRunWarning[] = [];
  const stale = unmatchedMapWarning(unmatchedPins);
  if (stale !== null) warnings.push(stale);
  const duplicates = duplicateStepTitlesWarning(archive.test.title, archive.duplicates);
  if (duplicates !== null) warnings.push(duplicates);
  warnings.push({
    kind: 'e2e-revision-unknown',
    message:
      'revision unknown: a Playwright trace records no git metadata at any format version, so this' +
      ' run is not attributed to a commit rather than being attributed to the wrong one',
  });
  return warnings;
}
