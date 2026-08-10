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
 *
 * The same derivation is what lets this edge fill in the `e2e:` noise block (e2e spec §5) for a
 * caller that only knows how to build a `DiffEngineOptions` — see {@link projectE2eOverrides}. That
 * is the whole reason it is a seam and not a two-line adapter: there is exactly one of it, and both
 * consumers go through it.
 */

import { dirname, resolve } from 'node:path';

import type { DiffResult } from '../types.js';
import { loadConfig } from '../store/config.js';
import { e2eNoiseOf } from './e2e-noise.js';
import type { E2eAwareDiffOptions } from './e2e-noise.js';
import { computeDiff as computeDiffRequest } from './engine.js';

/** `.visual-diff` for a run directory of the form `<vdiff>/runs/<flow>/<runId>`. */
export function vdiffDirOf(runDir: string): string {
  return resolve(runDir, '..', '..', '..');
}

/** The project root that owns a `.visual-diff` directory. */
export function projectRootOf(vdiffDir: string): string {
  return dirname(vdiffDir);
}

/**
 * The project's `e2e:` noise block, when the caller did not supply one (e2e spec §5).
 *
 * ### Why this read is here and not in the callers
 *
 * Both callers build `DiffEngineOptions` by naming each field of `config.diff` in turn, and that is
 * exactly how the `e2e:` block came to be documented, parsed, and never applied: a field nobody
 * remembers to copy is a setting that does nothing, and the user reads the resulting noise as
 * regressions. This function is the seam that cannot be forgotten — every diff either consumer
 * computes arrives here, and here is where the run directory already tells us which project it
 * belongs to.
 *
 * Three properties keep it honest:
 *
 * - **The caller wins.** An `options.e2e` that is already set — by `diffOptionsFromConfig`, by a
 *   test, by anything — is used as-is and no file is read. This only fills a gap.
 * - **A config problem is never reported from here.** By the time a diff is computed the CLI has
 *   already loaded and validated the same file (exit 2 on failure, spec §9); re-reporting it
 *   mid-diff would duplicate the error, and *failing* the diff over it would turn a diff into a
 *   config command. So an unreadable or invalid config leaves the documented defaults in force.
 * - **No project, no read worth anything.** A run directory outside a real project — every engine
 *   fixture — finds no `config.yaml`, gets `undefined`, and behaves exactly as it did before.
 */
async function projectE2eOverrides(vdiffDir: string): Promise<E2eAwareDiffOptions['e2e']> {
  try {
    const result = await loadConfig({ root: projectRootOf(vdiffDir) });
    return result.ok ? e2eNoiseOf(result.value) : undefined;
  } catch {
    return undefined;
  }
}

export async function computeDiff(
  baseRunDir: string,
  headRunDir: string,
  options: E2eAwareDiffOptions,
): Promise<DiffResult> {
  const vdiffDir = vdiffDirOf(headRunDir);
  let effective = options;
  if (effective.e2e === undefined) {
    const e2e = await projectE2eOverrides(vdiffDir);
    if (e2e !== undefined) effective = { ...options, e2e };
  }
  return computeDiffRequest({
    baseRunDir,
    headRunDir,
    vdiffDir,
    options: effective,
  });
}
