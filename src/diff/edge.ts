/**
 * The diff module's edge in the shape its two consumers use (spec §8: "a pure function: two run
 * directories in, one findings.json out").
 *
 * `engine.ts#computeDiff` takes a request object because it also accepts an explicit `outDir` and
 * the `.visual-diff` root. Both callers — `cli/ports.ts#Ports.computeDiff` and
 * `report/server/deps.ts#ComputeDiffFn` — declare the positional form instead, and neither has a
 * reason to know where the store keeps its directories. So the positional form is the edge, and it
 * derives the `.visual-diff` directory from the run directory it was handed.
 *
 * That derivation is safe because run directories are only ever built by `store/paths.ts`:
 * `<root>/.visual-diff/runs/<flow>/<runId>`, so three levels up is `.visual-diff` by construction.
 * `edge.test.ts` pins that against the real store rather than against a hand-written string.
 */

import { resolve } from 'node:path';

import type { DiffEngineOptions, DiffResult } from '../types.js';
import { computeDiff as computeDiffRequest } from './engine.js';

/** `.visual-diff` for a run directory of the form `<vdiff>/runs/<flow>/<runId>`. */
export function vdiffDirOf(runDir: string): string {
  return resolve(runDir, '..', '..', '..');
}

export async function computeDiff(
  baseRunDir: string,
  headRunDir: string,
  options: DiffEngineOptions,
): Promise<DiffResult> {
  return computeDiffRequest({
    baseRunDir,
    headRunDir,
    vdiffDir: vdiffDirOf(headRunDir),
    options,
  });
}
