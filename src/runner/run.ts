/**
 * `runFlow` — the runner's whole job (spec §7).
 *
 * Fast path (attach): the target is HEAD or the dirty working tree and the user's dev server is
 * already answering `readyOn`, so nothing is materialized, installed or built. Slow path (spawn):
 * the target is a historical ref, so a detached worktree is created under `cache/`, dependencies
 * come from the lockfile-keyed cache, the flow spec is read **out of git history at that revision**
 * (D4), and the configured dev command is spawned on an allocated port.
 *
 * Two invariants this file is responsible for:
 *
 *  - The user's working tree, index, stashes and HEAD are never touched (§10, non-negotiable).
 *    Every git write goes through `worktree.ts`, which refuses to operate outside `cache/`.
 *  - A crash mid-run never leaves a visible partial run: the store writes to a temp directory and
 *    renames on commit, so `discard()` on any failure path leaves the store exactly as it was.
 *    An *infrastructure* failure (install, dev server) still commits a `failed` run, because §10
 *    requires the timeline entry and the retained log to survive.
 */

import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULTS,
  EXIT,
  type ConsoleEntry,
  type FlowSpec,
  type NetworkEntry,
  type NetworkMode,
  type RunEnv,
  type RunMeta,
  type RunMode,
  type RunOptions,
  type RunResult,
  type RunStatus,
  type RunWarning,
  type Revision,
  type ShotResult,
  type Step,
  type StepId,
  type StepResult,
  type StepStatus,
  type Viewport,
  type ViewportId,
} from '../types.js';
import { hashFlow, parseFlowSource } from '../flow/index.js';
import { loadConfigOrThrow, openStore, paths, type Store } from '../store/index.js';
import type { RunDraft } from '../store/run-store.js';

import { describeSettle, launchChromium, loadPlaywright } from './browser.js';
import { ensureDeps, linkNodeModules } from './deps.js';
import { startDevServer, portOfUrl, probe, substitutePort, type DevServerHandle } from './devserver.js';
import { RunnerError, errorMessage } from './errors.js';
import { retargetHarFile, scrubHarFile } from './har.js';
import { readGitStateSafe, repoRoot, resolveRef, sameGitState, showFileAtRev, toRevision } from './git.js';
import { replayViewport, selectorOf, type StepOutcome, type ViewportReplay } from './replay.js';
import { normalizeViewports, runPool } from './viewport.js';
import { addWorktree, reapWorktrees, type Worktree } from './worktree.js';
import { toolVersion } from '../version.js';

export interface RunContext {
  /** Where the project is looked up. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Pre-opened store, for tests. */
  store?: Store;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * `<dir>/package.json` for the nearest ancestor of `file` that declares one, or `null`.
 *
 * Only ever used as the fallback when a package does not export `./package.json`; the walk stops at
 * the filesystem root so a package with no manifest cannot spin.
 */
async function nearestPackageJson(file: string): Promise<string | null> {
  let dir = dirname(file);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (await exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The `playwright-core` version this process would actually load, resolved the way Node resolves
 * it — not by walking a hard-coded relative path.
 *
 * `new URL('../../node_modules/playwright-core/package.json', import.meta.url)` is only correct in a
 * source checkout. Installed, this file is `<root>/node_modules/@beprajwal/visual-diff/dist/runner/
 * run.js`, npm hoists `playwright-core` to `<root>/node_modules/`, and that relative path points at
 * a nested `node_modules` that does not exist — so every installed run recorded
 * `env.playwright: "unknown"`. `meta.json`'s env is part of what makes a run reproducible and
 * comparable, so a silently degraded field there quietly degrades the whole store.
 *
 * `from` exists so both layouts are testable: it is the module the resolution starts from.
 */
export async function readPlaywrightVersion(from: string | URL = import.meta.url): Promise<string> {
  let resolveFrom: ReturnType<typeof createRequire>;
  try {
    resolveFrom = createRequire(from);
  } catch {
    return 'unknown';
  }

  // The subpath first, because it is exact; the main entry second, for a hypothetical
  // `playwright-core` that stops exporting `./package.json`.
  for (const specifier of ['playwright-core/package.json', 'playwright-core']) {
    let resolved: string;
    try {
      resolved = resolveFrom.resolve(specifier);
    } catch {
      continue;
    }
    const manifest = resolved.endsWith('package.json') ? resolved : await nearestPackageJson(resolved);
    if (manifest === null) continue;
    try {
      const version = (JSON.parse(await readFile(manifest, 'utf8')) as { version?: string }).version;
      if (typeof version === 'string' && version !== '') return version;
    } catch {
      /* try the next specifier */
    }
  }
  return 'unknown';
}

async function runEnv(deviceScaleFactor: number): Promise<RunEnv> {
  const playwright = await readPlaywrightVersion();
  let chromium = 'unknown';
  try {
    const module = (await loadPlaywright()) as unknown as {
      chromium: { name?: () => string; executablePath?: () => string };
    };
    chromium = module.chromium.executablePath?.() ?? 'unknown';
  } catch {
    /* Chromium may not be installed; the launch will produce the real message */
  }
  return {
    tool: toolVersion(),
    node: process.version,
    playwright,
    chromium,
    os: `${process.platform}-${process.arch}`,
    deviceScaleFactor,
  };
}

/**
 * The most unsettled gate across a step's viewports, or `undefined` when every viewport settled.
 *
 * "Most unsettled" is the largest outstanding request count, tie-broken by the longest wait, with
 * the URLs unioned so the warning names every request that kept any viewport busy.
 */
export function worstUnsettled(
  outcomes: ReadonlyArray<{ shot?: { unsettled?: { waitedMs: number; inFlight: number; urls: string[] } } }>,
): { waitedMs: number; inFlight: number; urls: string[] } | undefined {
  const reports = outcomes
    .map((outcome) => outcome.shot?.unsettled)
    .filter((report): report is { waitedMs: number; inFlight: number; urls: string[] } => report !== undefined);
  if (reports.length === 0) return undefined;

  const worst = reports.reduce((a, b) =>
    b.inFlight > a.inFlight || (b.inFlight === a.inFlight && b.waitedMs > a.waitedMs) ? b : a,
  );
  const urls = [...new Set(reports.flatMap((report) => report.urls))].slice(0, 20);
  return { waitedMs: worst.waitedMs, inFlight: worst.inFlight, urls };
}

/** Merge one step's per-viewport outcomes into the single `step.json` the store holds. */
export function mergeStep(
  step: Step,
  index: number,
  perViewport: ReadonlyArray<{ viewport: ViewportId; outcome: StepOutcome | undefined }>,
  shots: Record<ViewportId, ShotResult>,
): StepResult {
  const present = perViewport
    .map((entry) => entry.outcome)
    .filter((outcome): outcome is StepOutcome => outcome !== undefined);

  const status: StepStatus = present.some((outcome) => outcome.status === 'failed')
    ? 'failed'
    : present.some((outcome) => outcome.status === 'blocked')
      ? 'blocked'
      : present.length === 0
        ? 'skipped'
        : 'ok';

  const startedAt = present[0]?.startedAt ?? isoNow();
  const finishedAt = present[present.length - 1]?.finishedAt ?? startedAt;
  const result: StepResult = {
    id: step.id,
    index,
    status,
    shoot: step.shoot !== false,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, ...present.map((outcome) => outcome.durationMs), 0),
    viewports: shots,
    truncated: Object.values(shots).some((shot) => shot.truncated),
    consoleErrors: present.reduce(
      (sum, outcome) => sum + outcome.console.filter((entry) => entry.level === 'error').length,
      0,
    ),
    networkRequests: present.reduce((sum, outcome) => sum + outcome.network.length, 0),
    harMisses: present.reduce((sum, outcome) => sum + outcome.harMisses, 0),
  };
  // An unsettled gate in *any* viewport taints the step, so the worst one is what step.json records:
  // reporting the calmest viewport would understate a capture the user cannot trust.
  const unsettled = worstUnsettled(present);
  if (unsettled !== undefined) result.unsettled = unsettled;
  // The D4 drift signal must survive a step that never ran in any viewport, so the spec's own
  // selector is the fallback when no replay reported a resolved one.
  const resolved =
    present.find((outcome) => outcome.resolvedSelector !== undefined)?.resolvedSelector ??
    selectorOf(step);
  if (resolved !== undefined) result.resolvedSelector = resolved;
  const failed = present.find((outcome) => outcome.failure !== undefined);
  if (failed?.failure !== undefined) result.failure = { ...failed.failure };
  return result;
}

/** Run status from the merged step list (spec §7: a failure makes the run `partial`, not lost). */
export function statusOf(steps: readonly StepResult[]): RunStatus {
  if (steps.some((step) => step.status === 'failed' || step.status === 'blocked')) return 'partial';
  return 'ok';
}

interface ResolvedTarget {
  mode: RunMode;
  /** Directory the dev server runs in. */
  projectDir: string;
  revision: Revision;
  flowSource: string;
  flowFile: string;
  worktree?: Worktree;
}

async function resolveFlowSource(
  store: Store,
  flow: string,
  options: RunOptions,
  root: string,
): Promise<ResolvedTarget> {
  const gitRoot = (await repoRoot(root)) ?? root;

  if (options.at === undefined) {
    const file = paths.flowFile(root, flow);
    if (!(await exists(file))) {
      throw new RunnerError({
        code: 'flow-missing',
        message: `no flow spec at ${file}`,
        exitCode: EXIT.CONFIG_ERROR,
        kind: 'flow-missing',
        hint: `create it with \`vdiff flow new ${flow}\``,
      });
    }
    const source = await readFile(file, 'utf8');
    const state = await readGitStateSafe(root);
    return {
      mode: 'attach',
      projectDir: root,
      revision: toRevision(state),
      flowSource: source,
      flowFile: file,
    };
  }

  const sha = await resolveRef(gitRoot, options.at);
  const repoPath = paths.flowFileRepoPath(flow);
  const source = await showFileAtRev(gitRoot, sha, repoPath);
  if (source === null) {
    // §10: rejected cleanly — "flow did not exist at <sha>" — never an empty run.
    throw new RunnerError({
      code: 'flow-missing-at-rev',
      message: `flow did not exist at ${sha.slice(0, 7)}: ${repoPath}`,
      exitCode: EXIT.CONFIG_ERROR,
      kind: 'flow-missing',
      hint: 'pick a revision where the flow spec was committed, or replay HEAD',
    });
  }

  await reapWorktrees(gitRoot, paths.worktreesRoot(root));
  const worktree = await addWorktree({
    repoRoot: gitRoot,
    sha,
    worktreesDir: paths.worktreesRoot(root),
  });

  return {
    mode: 'spawn',
    projectDir: worktree.path,
    revision: { sha, ref: options.at === sha ? null : options.at, dirty: false },
    flowSource: source,
    flowFile: `${repoPath}@${sha.slice(0, 7)}`,
    worktree,
  };
}

function parseSpec(source: string, file: string, flow: string): FlowSpec {
  const parsed = parseFlowSource(source, { file, expectFlowName: flow });
  if (!parsed.ok) {
    const first = parsed.issues[0];
    throw new RunnerError({
      code: first?.code ?? 'flow-invalid',
      message:
        first === undefined
          ? `invalid flow spec: ${file}`
          : `${first.at.file}${first.at.line === undefined ? '' : `:${first.at.line}`}: ${first.message}`,
      exitCode: EXIT.CONFIG_ERROR,
      kind: 'flow-invalid',
    });
  }
  return parsed.value;
}

interface ServerBinding {
  mode: RunMode;
  baseUrl: string;
  handle?: DevServerHandle;
}

async function bindServer(
  store: Store,
  target: ResolvedTarget,
  spec: FlowSpec,
  options: RunOptions,
): Promise<ServerBinding> {
  const config = store.config;
  const configuredBase = options.baseUrl ?? spec.baseUrl ?? config.baseUrl;

  if (target.mode === 'attach' && configuredBase !== undefined) {
    const port = portOfUrl(configuredBase);
    const readyUrl = port === null ? config.app.readyOn : substitutePort(config.app.readyOn, port);
    if (await probe(readyUrl)) {
      return { mode: 'attach', baseUrl: configuredBase };
    }
  }

  const handle = await startDevServer({
    command: config.app.dev,
    cwd: target.projectDir,
    readyOn: config.app.readyOn,
    readyTimeoutMs: config.app.readyTimeoutMs,
  });
  return { mode: 'spawn', baseUrl: `http://127.0.0.1:${handle.port}`, handle };
}

/**
 * The resolved network plan.
 *
 * A discriminated union on purpose: `{ mode: 'record' | 'replay' }` with no `path` is precisely the
 * state that lets a run reach the live network while `meta.json` claims a HAR mode, so the type
 * makes it unrepresentable rather than leaving it to a downstream `!== undefined` check.
 */
export type HarPlan =
  | { mode: 'off'; path?: undefined; recording: false }
  | { mode: 'record'; path: string; recording: true }
  | { mode: 'replay'; path: string; recording: false };

/**
 * Choose the network plan for this run (spec §7, D9).
 *
 * A record or replay mode with no resolvable HAR path is a **configuration error**, not a degraded
 * run: proceeding would put the page on the real network unconstrained while reporting 0 hits and
 * 0 misses. Reachable today by a flow declaring `network: { mode: off }` — which the flow validator
 * lets omit `har` — run with `--record`.
 */
export async function planHar(store: Store, spec: FlowSpec, options: RunOptions): Promise<HarPlan> {
  const requested: NetworkMode = options.network ?? spec.network.mode;
  if (requested === 'off') return { mode: 'off', recording: false };

  const declared = spec.network.har;
  if (declared === undefined || declared.trim() === '') {
    throw new RunnerError({
      code: 'har-path-missing',
      message:
        `flow "${options.flow}": network mode '${requested}' needs a HAR file, ` +
        'but the flow spec declares no `network.har`',
      exitCode: EXIT.CONFIG_ERROR,
      kind: 'flow-invalid',
      hint:
        `add \`network: { mode: ${requested}, har: ${options.flow}.har }\` to ` +
        `${paths.flowFileRepoPath(options.flow)}, or drop --record and use --no-net to block the ` +
        'network instead — the run will never be allowed to fall through to it',
    });
  }

  const file = paths.harFile(store.root, declared);
  if (requested === 'record') return { mode: 'record', path: file, recording: true };
  // The first run of a flow records; later runs serve (spec §7).
  if (!(await exists(file))) return { mode: 'record', path: file, recording: true };
  return { mode: 'replay', path: file, recording: false };
}

export async function runFlow(options: RunOptions, context: RunContext = {}): Promise<RunResult> {
  const cwd = context.cwd ?? options.cwd ?? process.cwd();
  const store = context.store ?? openStore(await loadConfigOrThrow({ cwd }));
  const root = store.root;
  const startedAt = isoNow();

  const lock = await store.acquireLock(options.flow);
  let target: ResolvedTarget | undefined;
  let server: ServerBinding | undefined;
  let draft: RunDraft | undefined;

  try {
    await store.reapAbandonedRuns(options.flow);
    target = await resolveFlowSource(store, options.flow, options, root);
    const spec = parseSpec(target.flowSource, target.flowFile, options.flow);
    const flowHash = hashFlow(spec);

    const viewports: Viewport[] = normalizeViewports(
      options.viewports ?? (spec.viewports.length > 0 ? spec.viewports : DEFAULTS.viewports),
    );
    const har = await planHar(store, spec, options);
    const warnings: RunWarning[] = [];

    draft = await store.beginRun(options.flow);
    await draft.writeFlowSnapshot(spec);

    const gitStateBefore = await readGitStateSafe(root);
    const env = await runEnv(DEFAULTS.deviceScaleFactor);

    const commitFailure = async (error: RunnerError): Promise<RunResult> => {
      const activeDraft = draft as RunDraft;
      let logPath: string | undefined;
      if (error.log !== undefined && error.log !== '') {
        logPath = await activeDraft.writeLog(error.logName ?? 'run.log', error.log);
      }
      const meta: Omit<RunMeta, 'runId'> = {
        flow: options.flow,
        flowHash,
        revision: (target as ResolvedTarget).revision,
        mode: (target as ResolvedTarget).mode,
        network: har.mode,
        harHits: 0,
        harMisses: 0,
        viewports: viewports.map((viewport) => viewport.id),
        status: 'failed',
        failedSteps: [],
        env,
        startedAt,
        finishedAt: isoNow(),
        unstable: false,
        pinned: false,
        pruned: false,
        warnings,
        failure: {
          kind: error.kind,
          message: error.message,
          ...(logPath === undefined ? {} : { logPath }),
        },
      };
      const committed = await activeDraft.commit(meta);
      return { runDir: committed.runDir, meta: committed.meta, steps: [] };
    };

    // Slow path dependencies, before anything is spawned.
    if (target.mode === 'spawn' && options.at !== undefined) {
      try {
        const deps = await ensureDeps({
          projectDir: target.projectDir,
          cacheDepsDir: paths.depsCacheRoot(root),
          ...(store.config.app.install === undefined ? {} : { installCmd: store.config.app.install }),
        });
        await linkNodeModules(target.projectDir, deps.nodeModules);
      } catch (error) {
        if (RunnerError.is(error) && error.kind === 'install') return await commitFailure(error);
        throw error;
      }
    }

    try {
      server = await bindServer(store, target, spec, options);
    } catch (error) {
      if (RunnerError.is(error) && error.kind === 'server-not-ready') return await commitFailure(error);
      throw error;
    }

    const browser = await launchChromium();
    let replays: ViewportReplay[];
    // One scratch directory per run: recorded HARs land here before they are published, and the
    // port-retargeted copy of a committed HAR lives here too, so the committed file is never
    // touched by a replay.
    const scratch = join(tmpdir(), `vdiff-har-${process.pid}-${Date.now().toString(36)}`);
    try {
      const harTargets = new Map<ViewportId, string>();
      let replayHar: string | undefined;
      if (har.recording) {
        await mkdir(scratch, { recursive: true });
        for (const viewport of viewports) harTargets.set(viewport.id, join(scratch, `${viewport.id}.har`));
      } else if (har.mode === 'replay') {
        await mkdir(scratch, { recursive: true });
        replayHar = await retargetHarFile(har.path, server.baseUrl, join(scratch, 'replay.har'));
      }

      // The last place a HAR path can go missing. `har.path` is typed present for record and
      // replay, but the per-viewport recording targets are built in a Map, and a Map lookup that
      // silently returns `undefined` would hand the context no `recordHar` — a live-network run
      // labelled `record`. So the lookup is total (spec §7: never a silent fallthrough).
      const harPathFor = (viewport: Viewport): string | undefined => {
        if (har.mode === 'off') return undefined;
        if (!har.recording) return replayHar;
        const target = harTargets.get(viewport.id);
        if (target === undefined) {
          throw new RunnerError({
            code: 'har-target-missing',
            message: `no HAR recording target for viewport ${viewport.id}; refusing to record against the live network untraced`,
            kind: 'internal',
          });
        }
        return target;
      };

      const outcomes = await runPool(viewports, DEFAULTS.viewportConcurrency, (viewport) => {
        const harPath = harPathFor(viewport);
        return replayViewport({
          browser,
          viewport,
          flow: spec,
          baseUrl: (server as ServerBinding).baseUrl,
          network: har.mode,
          ...(harPath === undefined ? {} : { har: harPath }),
          ...(options.continueOnError === undefined ? {} : { continueOnError: options.continueOnError }),
          deviceScaleFactor: DEFAULTS.deviceScaleFactor,
        });
      });

      const failures = outcomes.filter((outcome) => !outcome.ok);
      replays = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.value] : []));
      if (replays.length === 0) {
        const first = failures[0];
        const cause = first !== undefined && !first.ok ? first.error : undefined;
        throw new RunnerError({
          code: 'replay-failed',
          message: `every viewport replay failed: ${errorMessage(cause)}`,
          kind: 'internal',
          cause,
        });
      }
      for (const failure of failures) {
        if (failure.ok) continue;
        warnings.push({
          kind: 'step-blocked',
          message: `a viewport replay could not complete: ${errorMessage(failure.error)}`,
        });
      }

      if (har.recording) {
        const destination = har.path;
        const first = viewports[0];
        const source = first === undefined ? undefined : harTargets.get(first.id);
        if (source !== undefined && (await exists(source))) {
          await mkdir(paths.flowsDir(root), { recursive: true });
          await rename(source, destination).catch(async () => {
            await rm(destination, { force: true });
            await rename(source, destination);
          });
          if (options.noScrub !== true) {
            await scrubHarFile(destination, { redact: store.config.network.redact });
          }
          warnings.push({
            kind: 'har-recorded',
            message:
              options.noScrub === true
                ? `recorded ${destination} WITHOUT scrubbing (--no-scrub)`
                : `recorded ${destination}; commit it so replays are deterministic across machines`,
          });
        } else {
          // The run reached the live network to record, and produced nothing to replay. Saying so
          // is the difference between "the next run replays this" and "the next run records again
          // against whatever the backend looks like then".
          warnings.push({
            kind: 'har-recorded',
            message: `recording produced no HAR at ${destination}; the next run will record again rather than replay`,
          });
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }

    /* ---------------------------------------------------------------- merge and persist */

    const shotsByStep = new Map<StepId, Record<ViewportId, ShotResult>>();
    const consoleByStep = new Map<StepId, ConsoleEntry[]>();
    const networkByStep = new Map<StepId, NetworkEntry[]>();
    const outcomesByStep = new Map<StepId, Array<{ viewport: ViewportId; outcome: StepOutcome }>>();

    for (const replay of replays) {
      for (const outcome of replay.steps) {
        const list = outcomesByStep.get(outcome.id) ?? [];
        list.push({ viewport: replay.viewport, outcome });
        outcomesByStep.set(outcome.id, list);
        if (outcome.console.length > 0) {
          consoleByStep.set(outcome.id, [...(consoleByStep.get(outcome.id) ?? []), ...outcome.console]);
        }
        if (outcome.network.length > 0) {
          networkByStep.set(outcome.id, [...(networkByStep.get(outcome.id) ?? []), ...outcome.network]);
        }
      }
    }

    for (const step of spec.steps) {
      const entries = outcomesByStep.get(step.id) ?? [];
      const shots: Record<ViewportId, ShotResult> = {};
      for (const entry of entries) {
        const shot = entry.outcome.shot;
        if (shot === undefined) continue;
        shots[entry.viewport] = await draft.writeShot(step.id, {
          viewport: entry.viewport,
          screenshot: shot.screenshot,
          dom: shot.dom,
          a11y: shot.a11y,
          width: shot.width,
          height: shot.height,
        });
      }
      shotsByStep.set(step.id, shots);
    }

    const steps: StepResult[] = [];
    for (let index = 0; index < spec.steps.length; index += 1) {
      const step = spec.steps[index] as Step;
      const entries = outcomesByStep.get(step.id) ?? [];
      const merged = mergeStep(
        step,
        index,
        entries.map((entry) => ({ viewport: entry.viewport, outcome: entry.outcome })),
        shotsByStep.get(step.id) ?? {},
      );

      const failing = entries.find((entry) => entry.outcome.failureShot !== undefined);
      if (failing?.outcome.failureShot !== undefined && merged.failure !== undefined) {
        const artefacts = failing.outcome.failureShot;
        merged.failure.screenshot = await draft.writeArtifact(
          paths.relFailureScreenshot(step.id),
          artefacts.screenshot,
        );
        merged.failure.dom = await draft.writeArtifact(
          paths.relFailureDom(step.id),
          `${JSON.stringify(artefacts.dom)}\n`,
        );
      }

      await draft.writeStepConsole(step.id, consoleByStep.get(step.id) ?? []);
      await draft.writeStepNetwork(step.id, networkByStep.get(step.id) ?? []);
      await draft.writeStepResult(merged);
      steps.push(merged);
    }

    /* ---------------------------------------------------------------- warnings and meta */

    const harHits = replays.reduce((sum, replay) => sum + replay.harHits, 0);
    const harMisses = replays.reduce((sum, replay) => sum + replay.harMisses, 0);
    const missedUrls = [...new Set(replays.flatMap((replay) => replay.missedUrls))];
    if (harMisses > 0) {
      warnings.push({
        kind: 'har-miss',
        message: `${harMisses} request(s) had no HAR entry and were aborted; the diff may be misleading`,
        urls: missedUrls.slice(0, 20),
      });
    }

    // A screenshot taken with requests outstanding is a non-deterministic capture, which is exactly
    // the failure mode the whole tool exists to rule out — so it is a run warning, like a HAR miss.
    const unsettledSteps = steps.filter((step) => step.unsettled !== undefined);
    if (unsettledSteps.length > 0) {
      const worst = worstUnsettled(
        unsettledSteps.map((step) => ({ shot: { unsettled: step.unsettled } })),
      );
      if (worst !== undefined) {
        warnings.push({
          kind: 'settle-timeout',
          message: describeSettle({ settled: false, ...worst }),
          steps: unsettledSteps.map((step) => step.id),
          urls: worst.urls,
        });
      }
    }

    const blockedSteps = steps.filter((step) => step.status === 'blocked').map((step) => step.id);
    if (blockedSteps.length > 0) {
      warnings.push({
        kind: 'step-blocked',
        message: 'steps were skipped because an earlier step failed',
        steps: blockedSteps,
      });
    }

    const truncated = steps.filter((step) => step.truncated).map((step) => step.id);
    if (truncated.length > 0) {
      warnings.push({
        kind: 'dom-truncated',
        message: `dom.json hit the ${DEFAULTS.maxDomNodes}-node cap; attribution degrades to the nearest retained ancestor`,
        steps: truncated,
      });
    }

    const consoleErrorSteps = steps.filter((step) => step.consoleErrors > 0).map((step) => step.id);
    if (consoleErrorSteps.length > 0) {
      warnings.push({
        kind: 'console-error',
        message: 'the page logged console errors during this run',
        steps: consoleErrorSteps,
      });
    }

    const gitStateAfter = await readGitStateSafe(root);
    const unstable = target.mode === 'attach' && !sameGitState(gitStateBefore, gitStateAfter);
    if (unstable) {
      warnings.push({
        kind: 'unstable-git',
        message: 'git state moved during the run — re-run to get a trustworthy comparison',
      });
    }

    const failedSteps = steps.filter((step) => step.status === 'failed').map((step) => step.id);
    const meta: Omit<RunMeta, 'runId'> = {
      flow: options.flow,
      flowHash,
      revision: target.revision,
      mode: server.mode,
      network: har.mode,
      harHits,
      harMisses,
      viewports: viewports.map((viewport) => viewport.id),
      status: statusOf(steps),
      failedSteps,
      env,
      startedAt,
      finishedAt: isoNow(),
      unstable,
      pinned: false,
      pruned: false,
      warnings,
    };

    const committed = await draft.commit(meta);
    draft = undefined;

    // Retention runs here: `vdiff prune <run>` is the only documented prune surface (spec §9), so
    // the keepRuns policy has to be applied by the command that creates runs.
    await store.applyRetention(options.flow).catch(() => undefined);

    return { runDir: committed.runDir, meta: committed.meta, steps };
  } finally {
    if (draft !== undefined) await draft.discard().catch(() => undefined);
    if (server?.handle !== undefined) await server.handle.stop().catch(() => undefined);
    if (target?.worktree !== undefined) await target.worktree.remove().catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}
