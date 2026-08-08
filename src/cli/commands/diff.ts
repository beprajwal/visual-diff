/**
 * `vdiff diff <flow> [base] [head]` — compute and print the summary (spec §9).
 *
 * Two deliberate behaviours live here:
 *
 *  1. **It exits 0 even when findings exist.** Findings are information, not a gate. Pass/fail
 *     thresholds are a CI concern belonging to a later slice with a baseline-approval workflow.
 *     A `diff` that exited non-zero on change would make every agent loop treat a normal UI edit
 *     as a build break.
 *  2. The stored diff is reused when it exists and was produced by this engine version, so
 *     reopening a pair never recomputes (spec §8). Only an engine-version change forces the work.
 *
 * Defaults are N-1 vs N; the store resolves them, because which runs exist is store knowledge.
 */

import {
  DEFAULTS,
  DIFF_ENGINE_VERSION,
  type DiffEngineOptions,
  type DiffResult,
} from '../../types.js';
import type { Invocation } from '../args.js';
import type { CommandContext, CommandResult } from '../command.js';
import { percent, table } from '../output.js';
import type { DiffData } from '../shapes.js';

type DiffInvocation = Extract<Invocation, { kind: 'diff' }>;

export async function diff(
  ctx: CommandContext,
  invocation: DiffInvocation,
): Promise<CommandResult<DiffData>> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const store = await ctx.ports.openStore(config);
  const pair = await store.resolvePair(invocation.flow, invocation.base, invocation.head);

  const options: DiffEngineOptions = {
    minRegionArea: config.diff.minRegionArea,
    maxRegions: config.diff.maxRegions,
    antialiasTolerance: config.diff.antialiasTolerance,
    ignore: config.diff.ignore,
    engineVersion: DIFF_ENGINE_VERSION,
    deviceScaleFactor: DEFAULTS.deviceScaleFactor,
  };

  const stored = await store.readDiff(pair);
  const reusable = stored !== null && stored.engineVersion === options.engineVersion;

  let result: DiffResult;
  let path: string;
  if (reusable && stored !== null) {
    result = stored;
    path = store.diffFile(pair);
  } else {
    result = await ctx.ports.computeDiff(
      store.runDir(pair.flow, pair.base),
      store.runDir(pair.flow, pair.head),
      options,
    );
    path = await store.writeDiff(pair, result);
  }

  const summary = result.summary;
  const human: string[] = [
    `${pair.flow}  ${pair.base}..${pair.head}${reusable ? '  (cached)' : ''}`,
    `${summary.totalFindings} findings` +
      `  high ${summary.bySeverity.high}, med ${summary.bySeverity.med}, low ${summary.bySeverity.low}` +
      `  max pixel change ${percent(summary.maxPixelChangedRatio)}`,
    `steps: ${summary.stepsCompared} compared, ${summary.stepsChanged} changed,` +
      ` ${summary.stepsAdded} added, ${summary.stepsRemoved} removed,` +
      ` ${summary.stepsSpecChanged} spec-changed, ${summary.stepsFailed} failed,` +
      ` ${summary.stepsBlocked} blocked`,
  ];

  const stepRows: string[][] = [];
  for (const step of result.steps) {
    const viewportIds = Object.keys(step.viewports);
    if (viewportIds.length === 0) {
      stepRows.push([step.id, step.status, '-', '-', String(step.findings.length), step.detail ?? '']);
      continue;
    }
    for (const viewport of viewportIds) {
      const viewportDiff = step.viewports[viewport];
      if (viewportDiff === undefined) continue;
      stepRows.push([
        step.id,
        step.status,
        viewport,
        viewportDiff.missing === undefined ? percent(viewportDiff.pixelChangedRatio) : `missing ${viewportDiff.missing}`,
        String(viewportDiff.findings.length + step.findings.length),
        step.detail ?? '',
      ]);
    }
  }
  if (stepRows.length > 0) {
    human.push('');
    human.push(...table(['STEP', 'STATUS', 'VIEWPORT', 'PIXELS', 'FINDINGS', 'DETAIL'], stepRows));
  }

  const findingRows: string[][] = [];
  for (const step of result.steps) {
    const all = [
      ...step.findings,
      ...Object.values(step.viewports).flatMap((viewportDiff) => viewportDiff.findings),
    ];
    for (const finding of all) {
      findingRows.push([
        finding.id,
        finding.severity,
        finding.kind,
        `${finding.step}${finding.viewport === undefined ? '' : ` @${finding.viewport}`}`,
        finding.element?.selector ?? '-',
        finding.label,
      ]);
    }
  }
  if (findingRows.length > 0) {
    human.push('');
    human.push(...table(['ID', 'SEV', 'KIND', 'WHERE', 'ELEMENT', 'CHANGE'], findingRows));
  }

  human.push('');
  human.push(`findings.json: ${path}`);

  return {
    data: { flow: pair.flow, pair, path, cached: reusable, result },
    human,
    warnings: result.warnings,
    // No exitCode: findings never gate. This is the spec decision, not an oversight.
  };
}
