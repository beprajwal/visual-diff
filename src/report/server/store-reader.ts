/**
 * Filesystem-backed {@link ReportStore} over the `.visual-diff` tree (spec §6).
 *
 * The on-disk store *is* the interface between modules (spec §5), so the report server reads it
 * directly rather than importing another module's internals. Every path in this file is derived
 * from `config.dir`; no other file in `report/server` joins store paths.
 *
 * Read-only, with exactly one exception: {@link FsReportStore.appendFeedback} appends a line to
 * `feedback/pending.jsonl` (spec §9, D6). That is the only write this module performs on behalf of
 * an HTTP request.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  SCENARIO_NONE,
  type Config,
  type DiffResult,
  type FeedbackEntry,
  type NetworkEntry,
  type RunId,
  type RunMeta,
  type RunSummary,
} from '../../types.js';
import { summarizeStep, type RunAttribution, type StepAttribution } from '../attribution.js';
import {
  summarizeVariantRun,
  VARIANT_NONE,
  type RunVariantAttribution,
  type VariantName,
  type VariantReportFile,
} from '../variant.js';
import type { FeedbackDraft, FlowInfo, ReportStore } from './deps.js';

/** Flow names are directory names in the store; keep them boring so paths stay safe. */
const FLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Run ids are zero-padded integers (spec §6). */
const RUN_ID = /^[0-9]{4,}$/;

/** Blob areas the server will serve. Config, flows and feedback are never blobs. */
const BLOB_ROOTS = new Set(['runs', 'diffs']);
/** Blob extensions the server will serve, so the store can never hand out something executable. */
const BLOB_EXTENSIONS = new Set(['.png', '.json', '.yaml', '.yml', '.jpg', '.jpeg', '.webp']);

export function isValidFlowName(name: string): boolean {
  return name.length <= 128 && FLOW_NAME.test(name) && name !== '.' && name !== '..';
}

export function isValidRunId(runId: string): boolean {
  return runId.length <= 16 && RUN_ID.test(runId);
}

export function pairDirName(base: RunId, head: RunId): string {
  return `${base}..${head}`;
}

/**
 * A timeline row carrying the fourth axis of run identity (variants spec §5).
 *
 * An intersection rather than an assumption about `RunSummary`, so this file compiles against the
 * published contract whether or not it has grown the fields yet, and needs no edit once it has.
 * Both are always materialised here — `none` and `false` — so the page never has to distinguish
 * "no variant" from "this store predates variants". They are the same thing.
 */
export type VariantRunSummary = RunSummary & { variant: VariantName; kept: boolean };

/** The variant a run was captured under, read tolerantly off a `meta.json` of any vintage. */
function variantOfMeta(meta: RunMeta): VariantName {
  const raw = (meta as { variant?: unknown }).variant;
  if (typeof raw !== 'string') return VARIANT_NONE;
  const trimmed = raw.trim();
  return trimmed === '' ? VARIANT_NONE : trimmed;
}

/**
 * Project a stored RunMeta onto the timeline row the report renders.
 *
 * `scenario` and `variant` are both defaulted rather than required, because a `meta.json` on disk
 * may predate either field (mocking spec §6; variants spec §5). Reading them as `none` here is what
 * keeps those runs in the timeline instead of silently dropping — or, worse, badging as proposals —
 * every run recorded before this slice.
 */
export function toRunSummary(meta: RunMeta, findingsCount: number | null): VariantRunSummary {
  return {
    runId: meta.runId,
    flow: meta.flow,
    scenario: meta.scenario ?? SCENARIO_NONE,
    variant: variantOfMeta(meta),
    kept: (meta as { kept?: unknown }).kept === true,
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
  };
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function readSubdirNames(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function countJsonLines(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) n += 1;
  }
  return n;
}

interface FindingsCountCacheEntry {
  mtimeMs: number;
  size: number;
  count: number;
}

export class FsReportStore implements ReportStore {
  readonly root: string;
  readonly flowsDir: string;
  readonly runsDir: string;
  readonly diffsDir: string;
  readonly feedbackDir: string;
  readonly pendingFeedbackFile: string;
  readonly feedbackArchiveDir: string;

  /** Serializes feedback appends so two concurrent POSTs cannot interleave a line or an id. */
  private feedbackChain: Promise<unknown> = Promise.resolve();
  private readonly findingsCountCache = new Map<string, FindingsCountCacheEntry>();

  constructor(storeDir: string) {
    this.root = path.resolve(storeDir);
    this.flowsDir = path.join(this.root, 'flows');
    this.runsDir = path.join(this.root, 'runs');
    this.diffsDir = path.join(this.root, 'diffs');
    this.feedbackDir = path.join(this.root, 'feedback');
    this.pendingFeedbackFile = path.join(this.feedbackDir, 'pending.jsonl');
    this.feedbackArchiveDir = path.join(this.feedbackDir, 'archive');
  }

  flowRunsDir(flow: string): string {
    return path.join(this.runsDir, flow);
  }

  runDir(flow: string, runId: RunId): string {
    return path.join(this.runsDir, flow, runId);
  }

  pairDir(flow: string, base: RunId, head: RunId): string {
    return path.join(this.diffsDir, flow, pairDirName(base, head));
  }

  findingsFile(flow: string, base: RunId, head: RunId): string {
    return path.join(this.pairDir(flow, base, head), 'findings.json');
  }

  async listFlows(): Promise<FlowInfo[]> {
    const names = new Set<string>();
    for (const entry of await readDirNames(this.flowsDir)) {
      const ext = path.extname(entry);
      if (ext !== '.yaml' && ext !== '.yml') continue;
      const name = entry.slice(0, entry.length - ext.length);
      if (isValidFlowName(name)) names.add(name);
    }
    for (const name of await readSubdirNames(this.runsDir)) {
      if (isValidFlowName(name)) names.add(name);
    }

    const flows: FlowInfo[] = [];
    for (const name of [...names].sort()) {
      const ids = await this.listRunIds(name);
      flows.push({
        name,
        runs: ids.length,
        latest: ids.length > 0 ? (ids[ids.length - 1] as RunId) : null,
      });
    }
    return flows;
  }

  async listRunIds(flow: string): Promise<RunId[]> {
    if (!isValidFlowName(flow)) return [];
    const ids = (await readSubdirNames(this.flowRunsDir(flow))).filter(isValidRunId);
    ids.sort((a, b) => (a.length === b.length ? a.localeCompare(b) : a.length - b.length));
    return ids;
  }

  async readMeta(flow: string, runId: RunId): Promise<RunMeta | null> {
    if (!isValidFlowName(flow) || !isValidRunId(runId)) return null;
    return readJsonFile<RunMeta>(path.join(this.runDir(flow, runId), 'meta.json'));
  }

  async listRuns(flow: string): Promise<RunSummary[]> {
    const ids = await this.listRunIds(flow);
    const rows: RunSummary[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i] as RunId;
      const meta = await this.readMeta(flow, id);
      if (!meta) continue;
      const previous = i > 0 ? (ids[i - 1] as RunId) : null;
      const findingsCount =
        previous === null ? null : await this.readFindingsCount(flow, previous, id);
      rows.push(toRunSummary(meta, findingsCount));
    }
    return rows;
  }

  async readRunSummary(flow: string, runId: RunId): Promise<RunSummary | null> {
    const meta = await this.readMeta(flow, runId);
    if (!meta) return null;
    const ids = await this.listRunIds(flow);
    const index = ids.indexOf(runId);
    const previous = index > 0 ? (ids[index - 1] as RunId) : null;
    const findingsCount =
      previous === null ? null : await this.readFindingsCount(flow, previous, runId);
    return toRunSummary(meta, findingsCount);
  }

  /**
   * Total findings of a stored pair, without keeping the whole findings.json in memory. Cached on
   * (mtime, size) so a timeline of twenty runs does not re-read twenty diff files per request.
   */
  async readFindingsCount(flow: string, base: RunId, head: RunId): Promise<number | null> {
    const file = this.findingsFile(flow, base, head);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return null;
    }
    const cached = this.findingsCountCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.count;
    }
    const diff = await readJsonFile<DiffResult>(file);
    if (!diff || typeof diff.summary?.totalFindings !== 'number') return null;
    this.findingsCountCache.set(file, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      count: diff.summary.totalFindings,
    });
    return diff.summary.totalFindings;
  }

  /** Step directories of a run, which are named by step id and never by ordinal (spec §6). */
  async listStepIds(flow: string, runId: RunId): Promise<string[]> {
    if (!isValidFlowName(flow) || !isValidRunId(runId)) return [];
    const names = await readSubdirNames(path.join(this.runDir(flow, runId), 'steps'));
    return names.sort();
  }

  /**
   * What the scenario layer did to each step of a run (mocking spec §8).
   *
   * Returns null only when the run itself is unknown. A run captured without a scenario returns a
   * populated object whose rows are empty, so the page can tell "nothing to attribute" from
   * "no such run" — the second is an error, the first is the ordinary case.
   */
  async readAttribution(flow: string, runId: RunId): Promise<RunAttribution | null> {
    const meta = await this.readMeta(flow, runId);
    if (!meta) return null;

    const steps: StepAttribution[] = [];
    for (const step of await this.listStepIds(flow, runId)) {
      const entries = await readJsonFile<NetworkEntry[]>(
        path.join(this.runDir(flow, runId), 'steps', step, 'network.json'),
      );
      if (!Array.isArray(entries)) continue;
      steps.push(summarizeStep(step, entries));
    }

    return { flow, runId, scenario: meta.scenario ?? SCENARIO_NONE, steps };
  }

  /**
   * What the variant layer did to each step of a run (variants spec §7).
   *
   * Returns null only when the run itself is unknown, exactly as {@link readAttribution} does. A
   * run captured without a variant has no `variant.json` at all and comes back as a populated
   * object with no rows, so the page can tell "nothing to attribute" — the ordinary case — from
   * "no such run", which is an error.
   */
  async readVariantAttribution(flow: string, runId: RunId): Promise<RunVariantAttribution | null> {
    const meta = await this.readMeta(flow, runId);
    if (!meta) return null;

    const report = await readJsonFile<VariantReportFile>(
      path.join(this.runDir(flow, runId), 'variant.json'),
    );
    return summarizeVariantRun(flow, runId, variantOfMeta(meta), report);
  }

  async readCachedDiff(flow: string, base: RunId, head: RunId): Promise<DiffResult | null> {
    if (!isValidFlowName(flow) || !isValidRunId(base) || !isValidRunId(head)) return null;
    return readJsonFile<DiffResult>(this.findingsFile(flow, base, head));
  }

  /**
   * Map a store-relative blob path to an absolute file, or null. Rejects absolute paths, `..`
   * traversal, areas outside runs/ and diffs/, non-files, disallowed extensions, and symlinks that
   * point outside the store.
   */
  async resolveBlob(relPath: string): Promise<string | null> {
    if (!relPath || relPath.includes('\0')) return null;
    const candidate = relPath.replace(/\\/g, '/');
    if (path.posix.isAbsolute(candidate) || path.isAbsolute(candidate)) return null;
    // Windows drive-letter prefixes never appear in store paths.
    if (/^[A-Za-z]:/.test(candidate)) return null;

    const normalized = path.normalize(candidate);
    if (normalized === '.' || normalized.startsWith('..')) return null;

    const segments = normalized.split(path.sep).filter((s) => s.length > 0);
    if (segments.length < 2) return null;
    if (segments.some((s) => s === '..' || s === '.')) return null;
    if (!BLOB_ROOTS.has(segments[0] as string)) return null;
    if (!BLOB_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return null;

    const absolute = path.resolve(this.root, normalized);
    const inside = path.relative(this.root, absolute);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return null;

    let real: string;
    let rootReal: string;
    try {
      real = await fs.realpath(absolute);
      rootReal = await fs.realpath(this.root);
    } catch {
      return null;
    }
    const realInside = path.relative(rootReal, real);
    if (realInside.startsWith('..') || path.isAbsolute(realInside)) return null;

    try {
      const stat = await fs.stat(real);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }
    return real;
  }

  /** The one write. Appends a single JSON line; never rewrites or truncates the file. */
  async appendFeedback(draft: FeedbackDraft): Promise<FeedbackEntry> {
    const run = this.feedbackChain.then(async () => {
      const id = await this.nextFeedbackId();
      const entry: FeedbackEntry = { id, ...draft };
      await fs.mkdir(this.feedbackDir, { recursive: true });
      await fs.appendFile(this.pendingFeedbackFile, `${JSON.stringify(entry)}\n`, 'utf8');
      return entry;
    });
    // Keep the chain alive even when this append rejects.
    this.feedbackChain = run.catch(() => undefined);
    return run;
  }

  /** `fb_01`, `fb_02`, … counted across pending and archived entries so ids never repeat. */
  async nextFeedbackId(): Promise<string> {
    let total = 0;
    try {
      total += countJsonLines(await fs.readFile(this.pendingFeedbackFile, 'utf8'));
    } catch {
      /* no pending file yet */
    }
    for (const name of await readDirNames(this.feedbackArchiveDir)) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        total += countJsonLines(
          await fs.readFile(path.join(this.feedbackArchiveDir, name), 'utf8'),
        );
      } catch {
        /* unreadable archive file does not block new feedback */
      }
    }
    return `fb_${String(total + 1).padStart(2, '0')}`;
  }
}

/** Build the default store from a loaded {@link Config}. */
export function createFsStore(config: Pick<Config, 'dir'>): FsReportStore {
  return new FsReportStore(config.dir);
}
