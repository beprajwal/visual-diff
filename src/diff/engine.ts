/**
 * The diff engine (spec §8): a pure function — two run directories in, one `findings.json` out.
 * No network, no browser, no Playwright import anywhere in this module.
 *
 * Stage order is the spec's: structural flow diff, then pixel diff, region clustering, DOM
 * attribution and node diff per (step, viewport). Results are cached by
 * `(baseRunId, headRunId, engineVersion)`, so reopening the report never recomputes.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DIFF_ENGINE_VERSION,
  FINDING_KINDS,
  SEVERITIES,
  SEVERITY_ORDER,
} from '../types.js';
import type {
  DiffEngineOptions,
  DiffResult,
  DiffSummary,
  Finding,
  FindingKind,
  FlowDiffEntry,
  LoadedRun,
  LoadedShot,
  LoadedStep,
  PixelImage,
  Severity,
  StepDiff,
  ViewportDiff,
  ViewportId,
} from '../types.js';
import { diffDirFor, pairId, readCachedDiff, writeDiff } from './cache.js';
import { consoleFindings, networkFindings, structuralFindings } from './findings.js';
import { labelPair, pairScenarios, pairVariants } from './pairing.js';
import type { VariantAwareDiffResult } from './pairing.js';
import { flowLevelChanges, isComparable, structuralFlowDiff } from '../flow/index.js';
import { inflate } from './geometry.js';
import { loadRunDir } from './loadRun.js';
import { cropImage, decodePng, encodePng } from './pixel.js';
import { ignoreSelectorWarnings } from './selector.js';
import { diffViewport } from './viewportDiff.js';
import type { ShotSide } from './viewportDiff.js';

/** Image pixels of context kept around a region when cutting its crop. */
export const CROP_PADDING = 8;

export interface DiffContext {
  /** Absolute path to the `.visual-diff` directory; every emitted path is relative to it. */
  vdiffDir: string;
  /** Absolute path to `diffs/<flow>/<base>..<head>`. Defaults to the spec §6 location. */
  outDir?: string;
  options: DiffEngineOptions;
}

export interface DiffRequest extends DiffContext {
  baseRunDir: string;
  headRunDir: string;
}

export function defaultDiffOptions(overrides: Partial<DiffEngineOptions> = {}): DiffEngineOptions {
  return {
    minRegionArea: 64,
    maxRegions: 40,
    antialiasTolerance: 0.1,
    ignore: [],
    engineVersion: DIFF_ENGINE_VERSION,
    deviceScaleFactor: 2,
    ...overrides,
  };
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function relativeToVdiff(vdiffDir: string, absolute: string): string {
  return toPosix(path.relative(vdiffDir, absolute));
}

async function decodeShot(shot: LoadedShot, warnings: string[]): Promise<PixelImage | null> {
  try {
    return decodePng(await readFile(shot.screenshotPath));
  } catch (err) {
    warnings.push(
      `could not decode ${shot.screenshotPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function viewportIds(base: LoadedStep | undefined, head: LoadedStep | undefined): ViewportId[] {
  const ids = new Set<ViewportId>();
  for (const v of Object.keys(base?.shots ?? {})) ids.add(v);
  for (const v of Object.keys(head?.shots ?? {})) ids.add(v);
  return [...ids].sort();
}

function emptySummary(): DiffSummary {
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byKind = Object.fromEntries(FINDING_KINDS.map((k) => [k, 0])) as Record<FindingKind, number>;
  return {
    totalFindings: 0,
    bySeverity,
    byKind,
    stepsCompared: 0,
    stepsChanged: 0,
    stepsAdded: 0,
    stepsRemoved: 0,
    stepsSpecChanged: 0,
    stepsFailed: 0,
    stepsBlocked: 0,
    maxPixelChangedRatio: 0,
  };
}

function summarize(flowDiff: readonly FlowDiffEntry[], steps: readonly StepDiff[]): DiffSummary {
  const summary = emptySummary();
  for (const entry of flowDiff) {
    switch (entry.status) {
      case 'added':
        summary.stepsAdded += 1;
        break;
      case 'removed':
        summary.stepsRemoved += 1;
        break;
      case 'spec-changed':
        summary.stepsSpecChanged += 1;
        break;
      case 'failed':
        summary.stepsFailed += 1;
        break;
      case 'blocked':
        summary.stepsBlocked += 1;
        break;
      case 'matched':
        break;
    }
    if (isComparable(entry.status)) summary.stepsCompared += 1;
  }

  for (const step of steps) {
    let count = step.findings.length;
    for (const vp of Object.values(step.viewports)) {
      count += vp.findings.length;
      summary.maxPixelChangedRatio = Math.max(summary.maxPixelChangedRatio, vp.pixelChangedRatio);
    }
    if (count > 0) summary.stepsChanged += 1;
    for (const finding of allFindings(step)) {
      summary.totalFindings += 1;
      summary.bySeverity[finding.severity] += 1;
      summary.byKind[finding.kind] += 1;
    }
  }
  return summary;
}

function* allFindings(step: StepDiff): Generator<Finding> {
  for (const f of step.findings) yield f;
  for (const vp of Object.values(step.viewports)) for (const f of vp.findings) yield f;
}

function sortStepFindings(findings: Finding[]): Finding[] {
  return findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.label.localeCompare(b.label);
  });
}

/**
 * Core stage runner: two loaded runs in, a `DiffResult` plus the artifacts to write out. Kept
 * separate from the filesystem so golden tests can drive it directly.
 */
export interface DiffArtifacts {
  /** Per (step, viewport): the pixel overlay and the region set to persist. */
  overlays: Array<{ step: string; viewport: ViewportId; image: PixelImage }>;
  regionFiles: Array<{ step: string; viewport: ViewportId; json: unknown }>;
}

export interface DiffRunsResult {
  result: DiffResult;
  artifacts: DiffArtifacts;
}

export async function diffRuns(
  base: LoadedRun,
  head: LoadedRun,
  options: DiffEngineOptions,
  loadWarnings: readonly string[] = [],
): Promise<DiffRunsResult> {
  const warnings: string[] = [...loadWarnings];

  if (base.meta.flow !== head.meta.flow) {
    warnings.push(
      `runs are from different flows: base '${base.meta.flow}', head '${head.meta.flow}'`,
    );
  }

  // Where the two runs sit on the scenario and variant axes (mocking spec §6, variants spec §5). A
  // cross-scenario, mock-vs-recorded or cross-variant pair is permitted and computed exactly like
  // any other — the labelling is how the result refuses to let its findings be read as ordinary
  // regressions. The proposal pair — a variant against the unmodified page at its own revision — is
  // deliberately not among them: it is the question variants exist to answer.
  const labelling = labelPair(base.meta, head.meta);
  warnings.push(...labelling.flags.map((flag) => flag.message));

  // A base-URL, viewport-matrix or network-mode change alters what the two runs *mean* without
  // changing a single step, so it cannot surface as a flowDiff entry — it belongs in the warnings.
  warnings.push(...flowLevelChanges(base.flow, head.flow));

  // Emitted once per diff rather than per (step, viewport): an unusable ignore selector is a fact
  // about the config, and repeating it for every shot would bury the findings it sits next to.
  warnings.push(...ignoreSelectorWarnings(options.ignore));

  const flowDiff = structuralFlowDiff({
    base: base.flow,
    head: head.flow,
    baseSteps: Object.fromEntries(base.steps.map((s) => [s.result.id, s.result])),
    headSteps: Object.fromEntries(head.steps.map((s) => [s.result.id, s.result])),
  });

  const artifacts: DiffArtifacts = { overlays: [], regionFiles: [] };
  const steps: StepDiff[] = [];

  for (const entry of flowDiff) {
    const baseStep = base.stepsById[entry.id];
    const headStep = head.stepsById[entry.id];

    const stepFindings: Finding[] = [
      ...structuralFindings(entry),
      ...consoleFindings(entry.id, baseStep?.console ?? [], headStep?.console ?? []),
      ...networkFindings(entry.id, baseStep?.network ?? [], headStep?.network ?? []),
    ];

    const viewports: Record<ViewportId, ViewportDiff> = {};
    const comparable = isComparable(entry.status);

    for (const viewport of viewportIds(baseStep, headStep)) {
      const baseShot = baseStep?.shots[viewport];
      const headShot = headStep?.shots[viewport];

      let baseSide: ShotSide | null = null;
      let headSide: ShotSide | null = null;
      if (comparable && baseShot !== undefined) {
        const image = await decodeShot(baseShot, warnings);
        if (image !== null) baseSide = { shot: baseShot, image };
      }
      if (comparable && headShot !== undefined) {
        const image = await decodeShot(headShot, warnings);
        if (image !== null) headSide = { shot: headShot, image };
      }

      if (!comparable) {
        viewports[viewport] = {
          viewport,
          pixelChangedRatio: 0,
          baseSize: baseShot === undefined ? null : baseShot.size,
          headSize: headShot === undefined ? null : headShot.size,
          dimensionsChanged: false,
          regions: [],
          findings: [],
          missing:
            baseShot === undefined && headShot === undefined
              ? 'both'
              : baseShot === undefined
                ? 'base'
                : 'head',
        };
        continue;
      }

      const output = diffViewport({
        step: entry.id,
        viewport,
        base: baseSide,
        head: headSide,
        options,
      });
      viewports[viewport] = output.diff;

      if (output.overlay !== null) {
        artifacts.overlays.push({ step: entry.id, viewport, image: output.overlay });
      }
      if (output.regionSet !== null) {
        artifacts.regionFiles.push({
          step: entry.id,
          viewport,
          json: {
            step: entry.id,
            viewport,
            regions: output.regionSet.regions,
            dropped: output.regionSet.dropped,
            excluded: output.regionSet.excluded,
            collapsed: output.regionSet.collapsed,
            totalFound: output.regionSet.totalFound,
          },
        });
      }
    }

    const stepDiff: StepDiff = {
      id: entry.id,
      status: entry.status,
      viewports,
      findings: sortStepFindings(stepFindings),
    };
    if (entry.detail !== undefined) stepDiff.detail = entry.detail;
    steps.push(stepDiff);
  }

  // Numbering last, in reading order: step-scoped findings first, then each viewport in turn.
  let n = 0;
  const cropSource = new Map<string, PixelImage>();
  for (const overlay of artifacts.overlays) {
    cropSource.set(`${overlay.step}\u0000${overlay.viewport}`, overlay.image);
  }
  for (const step of steps) {
    for (const finding of step.findings) {
      n += 1;
      finding.id = `f${n}`;
    }
    for (const viewport of Object.keys(step.viewports).sort()) {
      const vp = step.viewports[viewport];
      if (vp === undefined) continue;
      for (const finding of vp.findings) {
        n += 1;
        finding.id = `f${n}`;
      }
    }
  }

  const result: VariantAwareDiffResult = {
    engineVersion: options.engineVersion,
    flow: head.meta.flow,
    pair: { base: base.meta.runId, head: head.meta.runId },
    computedAt: new Date().toISOString(),
    baseMeta: base.meta,
    headMeta: head.meta,
    scenarios: labelling.scenarios,
    variants: labelling.variants,
    flowDiff,
    steps,
    summary: summarize(flowDiff, steps),
    warnings,
  };

  return { result, artifacts };
}

/**
 * Compute (or reuse) the diff for two run directories and materialize its artifacts:
 * `findings.json`, `crops/<id>.png`, and `steps/<step>/<viewport>/{pixel.png,regions.json}`.
 */
export async function computeDiff(request: DiffRequest): Promise<DiffResult> {
  const options = request.options;
  const [baseLoad, headLoad] = await Promise.all([
    loadRunDir(request.baseRunDir),
    loadRunDir(request.headRunDir),
  ]);

  const outDir =
    request.outDir ??
    diffDirFor(
      request.vdiffDir,
      headLoad.run.meta.flow,
      baseLoad.run.meta.runId,
      headLoad.run.meta.runId,
    );

  if (options.force !== true) {
    // The whole options object, not just `engineVersion`: the ignore list and the region knobs
    // change the engine's output without changing its version. The pair's scenario and variant
    // identities go in for the same reason — they decide the labels and warnings the result
    // carries (`cache.ts`).
    const cached = await readCachedDiff(
      outDir,
      baseLoad.run.meta.runId,
      headLoad.run.meta.runId,
      options,
      pairScenarios(baseLoad.run.meta, headLoad.run.meta),
      pairVariants(baseLoad.run.meta, headLoad.run.meta),
    );
    if (cached !== null) return cached;
  }

  const { result, artifacts } = await diffRuns(baseLoad.run, headLoad.run, options, [
    ...baseLoad.warnings,
    ...headLoad.warnings,
  ]);

  await mkdir(outDir, { recursive: true });

  for (const overlay of artifacts.overlays) {
    const dir = path.join(outDir, 'steps', overlay.step, overlay.viewport);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'pixel.png'), encodePng(overlay.image));
  }
  for (const regions of artifacts.regionFiles) {
    const dir = path.join(outDir, 'steps', regions.step, regions.viewport);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'regions.json'), `${JSON.stringify(regions.json, null, 2)}\n`);
  }

  // Crops come from the head screenshot, not the red overlay: an agent reading a feedback entry
  // needs to see the UI the human pointed at (spec §9).
  const compared = new Set(artifacts.overlays.map((o) => `${o.step}\u0000${o.viewport}`));
  const cropDir = path.join(outDir, 'crops');
  let cropDirReady = false;

  for (const step of result.steps) {
    for (const [viewport, vp] of Object.entries(step.viewports)) {
      const regionFindings = vp.findings.filter((f) => f.region !== undefined);
      if (regionFindings.length === 0) continue;
      const shot = headLoad.run.stepsById[step.id]?.shots[viewport];
      if (shot === undefined) continue;
      let source: PixelImage;
      try {
        source = decodePng(await readFile(shot.screenshotPath));
      } catch {
        continue;
      }
      for (const finding of regionFindings) {
        if (finding.region === undefined) continue;
        const crop = cropImage(source, inflate(finding.region, CROP_PADDING));
        if (crop === null) continue;
        if (!cropDirReady) {
          await mkdir(cropDir, { recursive: true });
          cropDirReady = true;
        }
        const file = path.join(cropDir, `${finding.id}.png`);
        await writeFile(file, encodePng(crop));
        finding.crop = relativeToVdiff(request.vdiffDir, file);
      }
    }
  }

  for (const step of result.steps) {
    for (const [viewport, vp] of Object.entries(step.viewports)) {
      const dir = path.join(outDir, 'steps', step.id, viewport);
      if (compared.has(`${step.id}\u0000${viewport}`)) {
        vp.pixelPath = relativeToVdiff(request.vdiffDir, path.join(dir, 'pixel.png'));
        vp.regionsPath = relativeToVdiff(request.vdiffDir, path.join(dir, 'regions.json'));
      }
    }
  }

  await writeDiff(outDir, result, options);
  return result;
}

export { pairId, diffDirFor };
