/**
 * Scenario names and the paths derived from them (mocking spec §5 Storage, §6, §11).
 *
 * A scenario name is not a path component — mocking spec §6 point 4 is explicit that keeping it out
 * of the run path is what spares it from case-insensitive filesystems and reserved device names.
 * It *is* the stem of its own spec file, though, and it is echoed into `meta.json`, the CLI and the
 * report, so it is held to the same shape a flow name is.
 *
 * `none` is refused outright (§11): it is what a run captured without a scenario records, so a file
 * of that name could never be selected.
 */

import { SCENARIO_NONE, type ScenarioSpec, type ScenarioSummary, type ValidationIssue } from '../types.js';
import { ScenarioSpecError } from './errors.js';
import { SAFE_SCENARIO_NAME_RE, SCENARIOS_DIRNAME } from './schema.js';

/**
 * The store's own directory name. Restated here rather than imported from `store/paths.ts` so the
 * scenario layer stays as free of dependencies as the flow layer is; both spell it the same way and
 * `store/paths.ts` remains the authority for every path the store itself builds.
 */
const VDIFF_DIRNAME = '.visual-diff';

/** `empty-forecast.yaml` */
export function scenarioFileName(name: string): string {
  return `${name}.yaml`;
}

/** `scenarios/empty-forecast.yaml` — relative to `.visual-diff/`, as `ScenarioSummary.path` is. */
export function scenarioRelPath(name: string): string {
  return `${SCENARIOS_DIRNAME}/${scenarioFileName(name)}`;
}

/** Path inside the repository, as `git show <sha>:<path>` wants it for historical replay (D4). */
export function scenarioRepoPath(name: string): string {
  return `${VDIFF_DIRNAME}/${scenarioRelPath(name)}`;
}

/**
 * Why `name` cannot be a scenario name, as a `ValidationIssue`, or null when it can. `at.file` is
 * the file the name *would* produce, which is the only file there is to point at when the name came
 * from the command line rather than from a spec.
 */
export function scenarioNameIssue(name: string): ValidationIssue | null {
  const at = { file: scenarioFileName(name), key: 'scenario' };

  if (name === SCENARIO_NONE) {
    return {
      code: 'reserved-scenario-name',
      message:
        `'${SCENARIO_NONE}' is a reserved scenario name: it is what a run captured without a ` +
        'scenario records in meta.json, so no scenario file may take it. Pick another name',
      at,
    };
  }
  if (!SAFE_SCENARIO_NAME_RE.test(name)) {
    return {
      code: 'invalid-scenario-name',
      message:
        `invalid scenario name '${name}': a scenario is stored as ` +
        `${VDIFF_DIRNAME}/${SCENARIOS_DIRNAME}/<name>.yaml and named in meta.json, so it must ` +
        'start with a letter or digit and contain only letters, digits, dot, dash or underscore',
      at,
    };
  }
  return null;
}

export function isValidScenarioName(name: string): boolean {
  return scenarioNameIssue(name) === null;
}

/** Throws `ScenarioSpecError` (exit 2) for a name that cannot be used. */
export function assertScenarioName(name: string): void {
  const issue = scenarioNameIssue(name);
  if (issue !== null) throw new ScenarioSpecError(issue.at.file, [issue]);
}

/** One row of `vdiff scenario list` (mocking spec §7). */
export function scenarioSummary(spec: ScenarioSpec): ScenarioSummary {
  const summary: ScenarioSummary = {
    name: spec.scenario,
    mode: spec.mode,
    ruleCount: spec.rules.length,
    path: scenarioRelPath(spec.scenario),
  };
  if (spec.description !== undefined) summary.description = spec.description;
  return summary;
}
