/**
 * store/internal/scenario — the scenario axis of run identity (mocking spec §6, D12).
 *
 * A run is `(flow, revision, scenario)`, and the scenario is recorded in `meta.json` rather than in
 * the run path: run ids stay monotonic per flow, and a scenario name never becomes a path component
 * with the case-folding and reserved-name rules that would come with it.
 *
 * Two consequences live in this file, and nowhere else:
 *
 * - **a slice-1 `meta.json` has no `scenario` key at all** and must stay readable, so every read of
 *   a run's scenario goes through `scenarioOf`, which answers `SCENARIO_NONE` for it;
 * - **`RunMeta.scenario` is required in memory**, so no code downstream of the store ever has to
 *   handle "unknown". `normalizeRunMeta` is what makes that true of a file that predates the field.
 *
 * `none` is reserved (mocking spec §11): no scenario file may take the name, so a normalized meta
 * whose scenario is `none` unambiguously means "captured without a scenario".
 */

import { SCENARIO_NONE, type RunMeta, type ScenarioName } from '../../types.js';

/** Anything carrying a possibly-absent scenario: a `RunMeta`, or a raw parse of one off disk. */
export interface MaybeScenario {
  scenario?: ScenarioName;
}

/**
 * The scenario a run was captured under. Absent, blank or non-string reads as `SCENARIO_NONE`
 * rather than as an error: a slice-1 run genuinely had no scenario, and that is a fact, not a fault.
 */
export function scenarioOf(meta: MaybeScenario | null | undefined): ScenarioName {
  const raw = meta?.scenario;
  if (typeof raw !== 'string') return SCENARIO_NONE;
  const trimmed = raw.trim();
  return trimmed === '' ? SCENARIO_NONE : trimmed;
}

/** Normalise a user-supplied scenario name (a `--scenario` argument) the same way a run's is. */
export function normalizeScenarioName(name: ScenarioName | undefined): ScenarioName {
  return scenarioOf({ ...(name === undefined ? {} : { scenario: name }) });
}

/** `meta` with `scenario` guaranteed present, so in-memory code never sees the slice-1 shape. */
export function normalizeRunMeta(meta: RunMeta): RunMeta {
  const scenario = scenarioOf(meta);
  return meta.scenario === scenario ? meta : { ...meta, scenario };
}

/** Whether two runs sit on the same point of the scenario axis — the default pairing (§6). */
export function sameScenario(a: MaybeScenario, b: MaybeScenario): boolean {
  return scenarioOf(a) === scenarioOf(b);
}
