/**
 * store/run-store — the append-only run store (spec §6, D3).
 *
 * Writing a run is a two-phase operation:
 *
 * 1. `beginRun` creates `runs/<flow>/.tmp-<suffix>/` — a sibling of the final directory, so the
 *    publish step is a same-filesystem rename. Everything the runner captures lands there.
 * 2. `commit` allocates the run id, writes `meta.json`, fsyncs the whole tree and renames the temp
 *    directory into place. **The rename is the only step that makes a run visible**, so a crash at
 *    any earlier point leaves nothing for the store or the report to see (spec §10).
 *
 * Run ids are allocated at commit time from the ids already on disk, which keeps them monotonic
 * per flow even when a run crashes, is pruned, or is deleted by hand. That stays true under
 * scenarios: the scenario is a field of `meta.json`, never a level of the path, so `0007` names one
 * run of the flow whatever it was captured against (mocking spec §6, D12).
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { StoreError } from './errors.js';
import { publishDirAtomic, tempSuffix, writeJsonAtomic } from './internal/atomic.js';
import {
  ensureDir,
  listDirEntries,
  pathExists,
  readJson,
  readJsonOrNull,
  readTextOrNull,
} from './internal/fs.js';
import { isRunId, nextRunId, normalizeRunId, parseRunId, sortRunIds } from './internal/id.js';
import { stableStringify } from './internal/json.js';
import {
  normalizeRunMeta,
  normalizeScenarioName,
  scenarioOf,
} from './internal/scenario.js';
import {
  VARIANT_NONE,
  captureHint,
  describeRevision,
  isKept,
  normalizeVariantMeta,
  normalizeVariantName,
  retentionBucketOf,
  runIdentityKey,
  sameRevision,
  variantOf,
} from './internal/variant.js';
import type {
  MaybeVariant,
  RetentionBucket,
  VariantFilter,
  VariantName,
  VariantRunMeta,
  VariantRunSummary,
} from './internal/variant.js';
import * as paths from './paths.js';
import { serializeFlowSnapshot } from './snapshot.js';
import { SCENARIO_NONE } from '../types.js';
import type {
  A11ySnapshot,
  ConsoleEntry,
  DomSnapshot,
  FlowSnapshot,
  NetworkEntry,
  PairRef,
  Revision,
  RunId,
  RunMeta,
  ScenarioName,
  ShotResult,
  StepId,
  StepResult,
  ViewportId,
} from '../types.js';

/* ------------------------------------------------------------------ writing */

/**
 * `RunMeta` minus the field the store owns. `runId` may be supplied to force a backfill id.
 *
 * `variant` and `kept` ride along structurally (variants spec §5): the runner passes them exactly
 * as it passes `scenario`, and `commit` is what turns them into the fields on disk.
 */
export type RunMetaInput = Omit<RunMeta, 'runId'> & { runId?: RunId } & MaybeVariant;

export interface ShotInput {
  viewport: ViewportId;
  /** Encoded PNG bytes. */
  screenshot: Uint8Array;
  dom: DomSnapshot;
  a11y?: A11ySnapshot | null;
  /** Screenshot dimensions in image pixels. */
  width: number;
  height: number;
}

export interface CommittedRun {
  runId: RunId;
  runDir: string;
  meta: RunMeta;
}

export interface RunDraft {
  readonly flow: string;
  /** The temp directory being built. Never visible under a run id. */
  readonly dir: string;
  readonly committed: boolean;
  writeFlowSnapshot(snapshot: FlowSnapshot | string): Promise<void>;
  writeStepResult(result: StepResult): Promise<void>;
  writeShot(step: StepId, shot: ShotInput): Promise<ShotResult>;
  writeStepConsole(step: StepId, entries: readonly ConsoleEntry[]): Promise<void>;
  writeStepNetwork(step: StepId, entries: readonly NetworkEntry[]): Promise<void>;
  /** Retained diagnostics (`install.log`, `server.log`); returns the run-relative path. */
  writeLog(name: string, contents: string): Promise<string>;
  /** Escape hatch for run-relative artefacts such as a failure screenshot. */
  writeArtifact(relativePath: string, data: string | Uint8Array): Promise<string>;
  commit(meta: RunMetaInput): Promise<CommittedRun>;
  /** Throw away an unfinished run. Idempotent. */
  discard(): Promise<void>;
}

export async function beginRun(root: string, flow: string): Promise<RunDraft> {
  const flowRuns = paths.flowRunsDir(root, flow);
  await ensureDir(flowRuns);
  const dir = path.join(flowRuns, `${paths.TEMP_PREFIX}${tempSuffix()}`);
  await fsp.mkdir(dir);
  return makeDraft(root, flow, dir);
}

function makeDraft(root: string, flow: string, dir: string): RunDraft {
  let committed = false;
  let discarded = false;

  const assertOpen = (): void => {
    if (committed) throw new StoreError('run-committed', `run for flow "${flow}" is already committed`);
    if (discarded) throw new StoreError('run-discarded', `run for flow "${flow}" was discarded`);
  };

  const writeInside = async (relative: string, data: string | Uint8Array): Promise<string> => {
    assertOpen();
    const target = paths.resolveInsideRun(dir, relative);
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, data);
    return relative;
  };

  return {
    flow,
    dir,
    get committed() {
      return committed;
    },

    async writeFlowSnapshot(snapshot: FlowSnapshot | string): Promise<void> {
      const text = typeof snapshot === 'string' ? snapshot : serializeFlowSnapshot(snapshot);
      await writeInside(paths.FLOW_SNAPSHOT_FILENAME, text.endsWith('\n') ? text : `${text}\n`);
    },

    async writeStepResult(result: StepResult): Promise<void> {
      await writeInside(paths.relStepResult(result.id), `${stableStringify(result)}\n`);
    },

    async writeShot(step: StepId, shot: ShotInput): Promise<ShotResult> {
      const rel = paths.relShotPaths(step, shot.viewport);
      await writeInside(rel.screenshot, shot.screenshot);
      await writeInside(rel.dom, `${stableStringify(shot.dom)}\n`);
      const a11y: A11ySnapshot =
        shot.a11y ?? { step, viewport: shot.viewport, root: null };
      await writeInside(rel.a11y, `${stableStringify(a11y)}\n`);
      return {
        viewport: shot.viewport,
        screenshot: rel.screenshot,
        dom: rel.dom,
        a11y: rel.a11y,
        width: shot.width,
        height: shot.height,
        nodeCount: shot.dom.nodeCount,
        truncated: shot.dom.truncated,
      };
    },

    async writeStepConsole(step: StepId, entries: readonly ConsoleEntry[]): Promise<void> {
      await writeInside(paths.relStepConsole(step), `${stableStringify([...entries])}\n`);
    },

    async writeStepNetwork(step: StepId, entries: readonly NetworkEntry[]): Promise<void> {
      await writeInside(paths.relStepNetwork(step), `${stableStringify([...entries])}\n`);
    },

    async writeLog(name: string, contents: string): Promise<string> {
      return writeInside(paths.relRunLog(name), contents);
    },

    async writeArtifact(relativePath: string, data: string | Uint8Array): Promise<string> {
      return writeInside(relativePath, data);
    },

    async commit(meta: RunMetaInput): Promise<CommittedRun> {
      assertOpen();
      if (meta.runId !== undefined && !isRunId(meta.runId)) {
        throw new StoreError(
          'invalid-run-id',
          `"${meta.runId}" is not a run id; expected zero-padded digits such as 0007`,
        );
      }
      let runId = meta.runId ?? nextRunId(await listRunIds(root, flow));
      // Always through paths.runDir, so a forced id cannot escape the flow directory.
      let target = paths.runDir(root, flow, runId);
      if (meta.runId === undefined) {
        // Defensive: a directory can appear between the listing and the rename.
        while (await pathExists(target)) {
          runId = nextRunId([runId]);
          target = paths.runDir(root, flow, runId);
        }
      } else if (await pathExists(target)) {
        throw new StoreError('run-exists', `run ${runId} already exists for flow "${flow}"`);
      }
      // `scenario` and `variant` are written explicitly even when the caller omitted them: a run
      // captured without either says so on disk (`none`) rather than leaving a reader to infer it
      // (mocking §6, variants §5).
      //
      // `kept` is written only for a variant run. A run that rendered the application as it stands
      // is in the permanent timeline by construction, so a promotion flag on it would be a field
      // that can never be true — noise in every meta.json the tool has ever written.
      const variant = variantOf(meta);
      const finalMeta: VariantRunMeta = {
        ...meta,
        runId,
        flow,
        scenario: scenarioOf(meta),
        variant,
      };
      if (variant === VARIANT_NONE) delete finalMeta.kept;
      else finalMeta.kept = isKept(meta);
      await fsp.writeFile(
        path.join(dir, paths.META_FILENAME),
        `${stableStringify(finalMeta)}\n`,
      );
      await publishDirAtomic(dir, target);
      committed = true;
      return { runId, runDir: target, meta: finalMeta };
    },

    async discard(): Promise<void> {
      if (committed || discarded) return;
      discarded = true;
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Reap temp directories left behind by a crashed run (spec §10). Returns what it removed. */
export async function reapAbandonedRuns(root: string, flow: string): Promise<string[]> {
  const flowRuns = paths.flowRunsDir(root, flow);
  const removed: string[] = [];
  for (const entry of await listDirEntries(flowRuns)) {
    if (!entry.isDirectory || !entry.name.startsWith(paths.TEMP_PREFIX)) continue;
    const target = path.join(flowRuns, entry.name);
    await fsp.rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

/* ------------------------------------------------------------------ reading */

/** Flows that have at least one run directory. */
export async function listFlows(root: string): Promise<string[]> {
  const entries = await listDirEntries(paths.runsDir(root));
  return entries
    .filter((entry) => entry.isDirectory && paths.isSafeSegment(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Committed run ids, ascending. In-flight `.tmp-*` directories are invisible here by construction. */
export async function listRunIds(root: string, flow: string): Promise<RunId[]> {
  const entries = await listDirEntries(paths.flowRunsDir(root, flow));
  const ids = entries.filter((entry) => entry.isDirectory && isRunId(entry.name)).map((e) => e.name);
  return sortRunIds(ids);
}

export async function latestRunId(root: string, flow: string): Promise<RunId | null> {
  const ids = await listRunIds(root, flow);
  return ids.length === 0 ? null : (ids[ids.length - 1] as RunId);
}

export async function runExists(root: string, flow: string, runId: RunId): Promise<boolean> {
  return pathExists(paths.runMetaFile(root, flow, runId));
}

export async function readRunMeta(root: string, flow: string, runId: RunId): Promise<RunMeta> {
  const file = paths.runMetaFile(root, flow, runId);
  const meta = await readJsonOrNull<RunMeta>(file);
  if (meta === null) {
    throw new StoreError('unknown-run', `run ${runId} does not exist for flow "${flow}"`);
  }
  // Normalised on the way out, so a meta.json written before `scenario` or `variant` existed is
  // readable and reads as the reserved `none` on both axes (mocking spec §6, variants spec §5).
  return normalizeVariantMeta(normalizeRunMeta(meta));
}

export async function readRunMetaOrNull(
  root: string,
  flow: string,
  runId: RunId,
): Promise<RunMeta | null> {
  const meta = await readJsonOrNull<RunMeta>(paths.runMetaFile(root, flow, runId));
  return meta === null ? null : normalizeVariantMeta(normalizeRunMeta(meta));
}

/**
 * The scenario each committed run of one flow was captured under, in run-id order (mocking §6).
 *
 * This is the index every scenario-aware operation is built on — the timeline column, the retention
 * grouping and pair resolution — because the scenario is a field of `meta.json` and not something a
 * directory listing can answer.
 */
export async function readScenarioIndex(
  root: string,
  flow: string,
  ids?: readonly RunId[],
): Promise<Map<RunId, ScenarioName>> {
  const runIds = ids ?? (await listRunIds(root, flow));
  const index = new Map<RunId, ScenarioName>();
  for (const runId of runIds) {
    index.set(runId, scenarioOf(await readRunMetaOrNull(root, flow, runId)));
  }
  return index;
}

/**
 * The variant each committed run of one flow was captured under (variants spec §5) — the mirror of
 * `readScenarioIndex`, and what `vdiff runs --variants` and the report's variant column read.
 */
export async function readVariantIndex(
  root: string,
  flow: string,
  ids?: readonly RunId[],
): Promise<Map<RunId, VariantName>> {
  const runIds = ids ?? (await listRunIds(root, flow));
  const index = new Map<RunId, VariantName>();
  for (const runId of runIds) {
    index.set(runId, variantOf(await readRunMetaOrNull(root, flow, runId)));
  }
  return index;
}

/**
 * Everything about a run that decides which other runs it groups, pairs and competes for retention
 * with — read once, because every one of those answers needs the same `meta.json`.
 *
 * `revision` is nullable rather than defaulted: a run whose `meta.json` cannot be read has an
 * *unknown* revision, and inventing one would let it silently satisfy the same-revision test that
 * variant pairing turns on (variants spec §5).
 */
export interface RunIdentity {
  runId: RunId;
  scenario: ScenarioName;
  variant: VariantName;
  /** `--keep`: promoted into the permanent timeline. */
  kept: boolean;
  bucket: RetentionBucket;
  revision: Revision | null;
}

export async function readRunIdentityIndex(
  root: string,
  flow: string,
  ids?: readonly RunId[],
): Promise<Map<RunId, RunIdentity>> {
  const runIds = ids ?? (await listRunIds(root, flow));
  const index = new Map<RunId, RunIdentity>();
  for (const runId of runIds) {
    const meta = await readRunMetaOrNull(root, flow, runId);
    index.set(runId, {
      runId,
      scenario: scenarioOf(meta),
      variant: variantOf(meta),
      kept: isKept(meta),
      bucket: retentionBucketOf(meta),
      revision: meta?.revision ?? null,
    });
  }
  return index;
}

/**
 * Patch `meta.json` in place. Used only for the fields the store owns after a run is published:
 * `pinned`, `pruned` and `kept`. Written atomically, so a reader never sees a truncated file.
 */
export async function updateRunMeta(
  root: string,
  flow: string,
  runId: RunId,
  patch: Partial<RunMeta> & MaybeVariant,
): Promise<RunMeta> {
  const current = await readRunMeta(root, flow, runId);
  // Run identity — id, flow, scenario and variant — is fixed at commit and never patched
  // afterwards. `kept` is deliberately *not* identity: promoting a run changes which timeline and
  // which retention bucket it lives in, not which capture it is (variants spec §5).
  const next: VariantRunMeta = {
    ...current,
    ...patch,
    runId: current.runId,
    flow: current.flow,
    scenario: current.scenario,
    variant: variantOf(current),
  };
  await writeJsonAtomic(paths.runMetaFile(root, flow, runId), next);
  return next;
}

export async function readFlowSnapshotSource(
  root: string,
  flow: string,
  runId: RunId,
): Promise<string> {
  const file = paths.runFlowSnapshotFile(root, flow, runId);
  const text = await readTextOrNull(file);
  if (text === null) {
    throw new StoreError(
      'missing-snapshot',
      `run ${runId} of flow "${flow}" has no ${paths.FLOW_SNAPSHOT_FILENAME}`,
    );
  }
  return text;
}

export async function readStepResult(
  root: string,
  flow: string,
  runId: RunId,
  step: StepId,
): Promise<StepResult> {
  return readJson<StepResult>(paths.stepResultFile(root, flow, runId, step));
}

/* ------------------------------------------------------------------ timeline */

export interface ListRunSummariesOptions {
  /** Restrict the timeline to runs captured under this scenario — `vdiff runs --scenario` (§7). */
  scenario?: ScenarioName;
  /**
   * Restrict the timeline to runs captured under this variant. Naming one overrides `variants`:
   * asking for a variant by name is an unambiguous request to see it, promoted or not.
   */
  variant?: VariantName;
  /**
   * Which variant runs the timeline shows. Defaults to `exclude` — D24's "variant runs are excluded
   * from the regression timeline by default" — and `vdiff runs <flow> --variants` passes `only`.
   */
  variants?: VariantFilter;
}

/**
 * Whether one run survives the variant filter.
 *
 * A *promoted* run is never filtered out by `exclude`: `--keep` moved it into the permanent
 * timeline, and hiding it there would make promotion a no-op (variants spec §5).
 */
function passesVariantFilter(
  identity: { variant: VariantName; kept: boolean },
  wanted: VariantName | null,
  filter: VariantFilter,
): boolean {
  if (wanted !== null) return identity.variant === wanted;
  if (filter === 'include') return true;
  if (filter === 'only') return identity.variant !== VARIANT_NONE;
  return identity.variant === VARIANT_NONE || identity.kept;
}

/**
 * One row per run, oldest first — the `vdiff runs <flow>` timeline (spec §9), with the scenario
 * column the mocking spec adds (§7).
 *
 * `findingsCount` is taken from the stored diff against the previous run of the **same identity** —
 * same scenario *and* same variant — and is null when no diff has been computed for that pair.
 * Like-for-like is the pairing the diff command defaults to (mocking spec §6), so anything else in
 * this column would be a count for a pair the tool would never have chosen — and, for a flow
 * captured under several scenarios, a number that quietly compares two states rather than two
 * revisions. Extending the grouping to the variant axis is what "a promoted variant behaves like
 * any other same-identity pair across revisions" means in the timeline (variants spec §5).
 *
 * Filtering changes which rows are returned, never how they are counted: the row for run 7 carries
 * the same figure whether or not the caller asked for one scenario or one variant.
 */
export async function listRunSummaries(
  root: string,
  flow: string,
  findingsCountFor: (base: RunId, head: RunId) => Promise<number | null> = async () => null,
  options: ListRunSummariesOptions = {},
): Promise<VariantRunSummary[]> {
  const ids = await listRunIds(root, flow);
  const wantedScenario =
    options.scenario === undefined ? null : normalizeScenarioName(options.scenario);
  const wantedVariant =
    options.variant === undefined ? null : normalizeVariantName(options.variant);
  const filter: VariantFilter = options.variants ?? 'exclude';
  const previousOfIdentity = new Map<string, RunId>();
  const out: VariantRunSummary[] = [];

  for (const runId of ids) {
    const meta = await readRunMetaOrNull(root, flow, runId);
    if (meta === null) continue;
    const scenario = scenarioOf(meta);
    const variant = variantOf(meta);
    const kept = isKept(meta);
    const identity = runIdentityKey(meta);
    const previous = previousOfIdentity.get(identity) ?? null;
    previousOfIdentity.set(identity, meta.runId);
    if (wantedScenario !== null && scenario !== wantedScenario) continue;
    if (!passesVariantFilter({ variant, kept }, wantedVariant, filter)) continue;
    const findingsCount = previous === null ? null : await findingsCountFor(previous, meta.runId);
    out.push({
      runId: meta.runId,
      flow: meta.flow,
      scenario,
      variant,
      kept,
      revision: meta.revision,
      mode: meta.mode,
      status: meta.status,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
      viewports: meta.viewports,
      failedSteps: meta.failedSteps,
      unstable: meta.unstable,
      pinned: meta.pinned,
      pruned: meta.pruned,
      findingsCount,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ pair resolution */

export interface ResolvePairOptions {
  /** Restrict both ends to runs captured under this scenario — `vdiff diff --scenario` (§7). */
  scenario?: ScenarioName;
  /**
   * Select the head among runs captured under this variant — `vdiff diff --variant` (variants §6).
   *
   * Unlike `scenario` this restricts the **head only**. The default base for a variant head is the
   * unvaried run it was proposed against, so restricting both ends to one variant would make the
   * option unable to resolve the one pair it exists to produce.
   */
  variant?: VariantName;
}

/**
 * Resolve a pair for `vdiff diff <flow> [base] [head]`. Defaults are **N-1 vs N** (spec §9) *on the
 * identity axes*: head is the newest run, base is the newest earlier run of the **same scenario and
 * the same variant** (mocking spec §6, D12; variants spec §5).
 *
 * Like-for-like is the default because the regression question is "did the empty state break
 * between these revisions?", and that needs matching ends. A flow captured with neither scenarios
 * nor variants is the `none`-vs-`none` case of exactly that rule, so slice-1 behaviour is unchanged.
 *
 * **A variant head is the deliberate exception (D24).** For a variant the question is not
 * regression but the proposal itself — *same revision, variant versus none* — so the default base
 * is the nearest unvaried run at the head's own revision. Applying the scenario rule unchanged
 * would look for an earlier run of the same variant and, failing that, refuse; and where it did
 * find one it would answer a question nobody asked. This is also why an ephemeral variant run is
 * never chosen as a default *head*: it is outside the regression timeline, so `vdiff diff <flow>`
 * with no arguments keeps meaning what it meant before variants existed.
 *
 * Naming both ends explicitly overrides every default — a cross-scenario or cross-variant pair is a
 * legitimate question and is permitted, then labelled rather than refused (mocking spec §6,
 * variants spec §5). Ids may be given loosely (`7`) and are normalised to the padded form.
 */
export async function resolvePair(
  root: string,
  flow: string,
  base?: string,
  head?: string,
  options: ResolvePairOptions = {},
): Promise<PairRef> {
  const ids = await listRunIds(root, flow);
  if (ids.length === 0) {
    throw new StoreError('no-runs', `flow "${flow}" has no runs yet`, {
      hint: `Run it first: vdiff run ${flow}`,
    });
  }

  const wanted = options.scenario === undefined ? null : normalizeScenarioName(options.scenario);
  const wantedVariant =
    options.variant === undefined ? null : normalizeVariantName(options.variant);
  const index = await readRunIdentityIndex(root, flow, ids);
  const identityOf = (runId: RunId): RunIdentity =>
    index.get(runId) ?? {
      runId,
      scenario: SCENARIO_NONE,
      variant: VARIANT_NONE,
      kept: false,
      bucket: 'timeline',
      revision: null,
    };
  const scenarioFor = (runId: RunId): ScenarioName => identityOf(runId).scenario;
  const variantFor = (runId: RunId): VariantName => identityOf(runId).variant;
  const underScenario = wanted === null ? ids : ids.filter((id) => scenarioFor(id) === wanted);

  if (wanted !== null && underScenario.length === 0) {
    throw new StoreError('no-runs', `flow "${flow}" has no runs under scenario "${wanted}" yet`, {
      hint: `Capture one: vdiff run ${flow} --scenario ${wanted}`,
    });
  }

  // What `head` may default to: one named variant, or — with no `--variant` — the regression
  // timeline, which excludes ephemeral variant runs and keeps promoted ones (D24).
  const candidates = underScenario.filter((id) =>
    passesVariantFilter(identityOf(id), wantedVariant, 'exclude'),
  );

  if (wantedVariant !== null && candidates.length === 0) {
    throw new StoreError(
      'no-runs',
      `flow "${flow}" has no runs under variant "${wantedVariant}" yet`,
      { hint: `Capture one: ${captureHint(flow, wanted ?? SCENARIO_NONE, wantedVariant)}` },
    );
  }
  // Only a *default* head needs the timeline to be non-empty. Naming both ends explicitly is how a
  // user compares two proposals of a flow that has no unvaried run yet, and refusing that because
  // the default would have had nothing to pick would forbid a pair the tool is happy to compute.
  if (candidates.length === 0 && head === undefined) {
    throw new StoreError(
      'no-runs',
      `flow "${flow}" has only ephemeral variant runs, none of which is in the regression timeline`,
      { hint: `List them: vdiff runs ${flow} --variants` },
    );
  }

  const resolveOne = (input: string, label: string, checkVariant: boolean): RunId => {
    const normalized = normalizeRunId(input);
    if (normalized === null || !ids.includes(normalized)) {
      throw new StoreError('unknown-run', `${label} run "${input}" does not exist for flow "${flow}"`, {
        hint: `Known runs: ${ids.join(', ')}`,
      });
    }
    if (wanted !== null && scenarioFor(normalized) !== wanted) {
      throw new StoreError(
        'scenario-mismatch',
        `${label} run ${normalized} ran scenario "${scenarioFor(normalized)}", not "${wanted}"`,
        { hint: `Runs under "${wanted}": ${underScenario.join(', ')}` },
      );
    }
    if (checkVariant && wantedVariant !== null && variantFor(normalized) !== wantedVariant) {
      throw new StoreError(
        'variant-mismatch',
        `${label} run ${normalized} ran variant "${variantFor(normalized)}", not "${wantedVariant}"`,
        { hint: `Runs under "${wantedVariant}": ${candidates.join(', ')}` },
      );
    }
    return normalized;
  };

  const headId =
    head === undefined
      ? (candidates[candidates.length - 1] as RunId)
      : resolveOne(head, 'head', true);
  if (base !== undefined) {
    // The base is not variant-checked: pairing a proposal against the unvaried page is the whole
    // point of the option, so requiring both ends to share a variant would forbid it.
    const baseId = resolveOne(base, 'base', false);
    if (baseId === headId) {
      throw new StoreError('same-run', `base and head are both ${headId}; a pair needs two runs`);
    }
    return { flow, base: baseId, head: headId };
  }

  const headIdentity = identityOf(headId);
  if (headIdentity.variant !== VARIANT_NONE) {
    return { flow, base: proposalBaseline(flow, ids, identityOf, headIdentity), head: headId };
  }

  const headIndex = candidates.indexOf(headId);
  for (let i = headIndex - 1; i >= 0; i -= 1) {
    const candidate = candidates[i] as RunId;
    const identity = identityOf(candidate);
    if (identity.scenario === headIdentity.scenario && identity.variant === VARIANT_NONE) {
      return { flow, base: candidate, head: headId };
    }
  }

  // Naming the scenario matters here: without it, "no run before 0007" reads as "this flow has one
  // run", when the flow may have twenty under other scenarios and none to compare this one against.
  const scenarioClause =
    headIdentity.scenario === SCENARIO_NONE ? '' : ` under scenario "${headIdentity.scenario}"`;
  throw new StoreError(
    'no-base',
    `flow "${flow}" has no run before ${headId}${scenarioClause} to compare against`,
    {
      hint: `Run it again to create a second point: ${captureHint(
        flow,
        headIdentity.scenario,
        VARIANT_NONE,
      )}`,
    },
  );
}

/**
 * The unvaried run a variant run was proposed against: same scenario, same revision, no variant,
 * nearest to the head by run id (variants spec §5).
 *
 * "Nearest" rather than "the previous one" because the baseline is not always captured first — an
 * agent may render three proposals and only then capture the unmodified page. Both are the same
 * code by construction, since `sameRevision` is what admits a candidate at all, so which side of
 * the head it sits on carries no meaning. Scanning ascending makes an equidistant tie fall to the
 * older run, which keeps the answer stable as later runs are added.
 */
function proposalBaseline(
  flow: string,
  ids: readonly RunId[],
  identityOf: (runId: RunId) => RunIdentity,
  head: RunIdentity,
): RunId {
  const headOrdinal = parseRunId(head.runId) ?? 0;
  let best: RunId | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const id of ids) {
    if (id === head.runId) continue;
    const identity = identityOf(id);
    if (identity.variant !== VARIANT_NONE) continue;
    if (identity.scenario !== head.scenario) continue;
    if (!sameRevision(identity.revision, head.revision)) continue;
    const distance = Math.abs((parseRunId(id) ?? 0) - headOrdinal);
    if (distance < bestDistance) {
      best = id;
      bestDistance = distance;
    }
  }

  if (best !== null) return best;

  // The dangerous failure this replaces: silently falling back to *some* other run would answer the
  // proposal question with a different revision's screenshots, and every difference between the two
  // would be attributed to the variant.
  const scenarioClause =
    head.scenario === SCENARIO_NONE ? '' : ` under scenario "${head.scenario}"`;
  throw new StoreError(
    'no-baseline',
    `flow "${flow}" has no unvaried run at revision ${describeRevision(head.revision)}` +
      `${scenarioClause} to compare variant "${head.variant}" run ${head.runId} against`,
    {
      hint: `Capture the unmodified page at that revision: ${captureHint(
        flow,
        head.scenario,
        VARIANT_NONE,
      )}`,
    },
  );
}
