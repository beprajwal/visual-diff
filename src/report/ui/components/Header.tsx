/**
 * Header: flow selector, scenario selector, base/head run pickers showing SHA, ref, dirty badge and
 * timestamp, plus the live indicator and the "run NNNN available" badge that appears instead of
 * yanking a pinned reviewer to a newer run (spec §9).
 *
 * The scenario selector sits between the flow and the run pickers because that is the order in
 * which the three narrow: a flow, then which state of it, then which two captures of that state
 * (mocking spec §7). It only appears once a flow has more than one scenario in its timeline —
 * a control with a single option is furniture.
 */

import { SCENARIO_NONE, type RunMeta, type RunSummary } from '../../../types.js';
import { ALL_SCENARIOS, runLabel, scenarioLabel, scenariosOf } from '../derive.js';
import type { Action, AppState } from '../state.js';
import { visibleRuns } from '../state.js';

export interface HeaderProps {
  state: AppState;
  dispatch: (action: Action) => void;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function RunPicker(props: {
  label: string;
  value: string | null;
  runs: RunSummary[];
  /** Meta for the selected run, when a diff has been loaded. Carries the network mode. */
  meta?: RunMeta | null;
  /** True when the scenario filter is off, so the run's own scenario is worth naming. */
  showScenario: boolean;
  onChange: (runId: string) => void;
}) {
  const run = props.runs.find((r) => r.runId === props.value) ?? null;
  const mockOnly = props.meta?.network === 'mock';
  return (
    <div class="run-pick">
      <label for={`pick-${props.label}`}>{props.label}</label>
      <select
        id={`pick-${props.label}`}
        value={props.value ?? ''}
        disabled={props.runs.length === 0}
        onChange={(event: Event) => {
          const next = (event.currentTarget as HTMLSelectElement).value;
          if (next) props.onChange(next);
        }}
      >
        {props.runs.length === 0 ? <option value="">no runs</option> : null}
        {props.runs
          .slice()
          .reverse()
          .map((r) => (
            <option key={r.runId} value={r.runId}>
              {runLabel(r)}
            </option>
          ))}
      </select>
      {run ? (
        <span class="run-meta">
          <span class="sha">{run.revision.sha.slice(0, 7)}</span>
          {run.revision.ref ? ` ${run.revision.ref}` : ''} · {formatTimestamp(run.startedAt)}
        </span>
      ) : null}
      {mockOnly ? (
        <span
          class="badge mock"
          title="mock-only run: no recording behind it, so fidelity is only as good as the scenario"
        >
          mock
        </span>
      ) : null}
      {props.showScenario && run && run.scenario !== SCENARIO_NONE ? (
        <span class="badge scenario" title={`captured under scenario ${run.scenario}`}>
          {run.scenario}
        </span>
      ) : null}
      {run?.revision.dirty ? (
        <span class="badge dirty" title="replayed against an uncommitted working tree">
          dirty
        </span>
      ) : null}
      {run?.unstable ? (
        <span class="badge unstable" title="git state moved during the run; re-run to be sure">
          unstable
        </span>
      ) : null}
      {run?.pruned ? (
        <span class="badge pruned" title="blobs pruned by retention; backfill by replaying">
          pruned
        </span>
      ) : null}
      {run?.pinned ? (
        <span class="badge pinned" title="exempt from retention">
          pinned
        </span>
      ) : null}
    </div>
  );
}

export function Header({ state, dispatch }: HeaderProps) {
  const { pendingRun } = state;
  const scenarios = scenariosOf(state.runs);
  const runs = visibleRuns(state);
  const filtered = state.scenario !== ALL_SCENARIOS;

  // `network` lives on RunMeta, not on the timeline row, so the mock badge can only be shown for
  // the pair whose diff is loaded — and only while the pickers still name that pair. A stale badge
  // is worse than none: "mock" against a recorded run is the exact confusion D13 exists to avoid.
  const diff = state.diff;
  const baseMeta = diff && diff.pair.base === state.base ? diff.baseMeta : null;
  const headMeta = diff && diff.pair.head === state.head ? diff.headMeta : null;

  return (
    <header class="header">
      <span class="brand">vdiff</span>

      <div class="field">
        <label for="flow-select">flow</label>
        <select
          id="flow-select"
          value={state.flow ?? ''}
          onChange={(event: Event) => {
            const flow = (event.currentTarget as HTMLSelectElement).value;
            if (flow) dispatch({ type: 'select-flow', flow });
          }}
        >
          {state.flows.length === 0 ? <option value="">no flows</option> : null}
          {state.flows.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name} ({f.runs})
            </option>
          ))}
        </select>
      </div>

      {scenarios.length > 1 ? (
        <div class="field">
          <label for="scenario-select">scenario</label>
          <select
            id="scenario-select"
            value={state.scenario}
            title="narrow the run pickers to one captured state (mocking spec §7)"
            onChange={(event: Event) => {
              const scenario = (event.currentTarget as HTMLSelectElement).value;
              dispatch({ type: 'select-scenario', scenario });
            }}
          >
            <option value={ALL_SCENARIOS}>all scenarios</option>
            {scenarios.map((name) => (
              <option key={name} value={name}>
                {scenarioLabel(name)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <RunPicker
        label="base"
        value={state.base}
        runs={runs}
        meta={baseMeta}
        showScenario={!filtered}
        onChange={(base) => dispatch({ type: 'select-base', base })}
      />
      <RunPicker
        label="head"
        value={state.head}
        runs={runs}
        meta={headMeta}
        showScenario={!filtered}
        onChange={(head) => dispatch({ type: 'select-head', head })}
      />

      <span class="spacer" />

      {pendingRun ? (
        <button
          type="button"
          class="pending"
          title="a newer run finished while you were reviewing a pinned pair"
          onClick={() => dispatch({ type: 'jump-to-pending' })}
        >
          run {pendingRun.runId} available
        </button>
      ) : null}

      <span
        class={`live ${state.connected ? 'on' : 'off'}`}
        title={
          state.connected
            ? state.following
              ? 'live: following the newest run'
              : 'live: pinned to this pair'
            : 'disconnected from the report server'
        }
      >
        <span class="dot" />
        {state.connected ? (state.following ? 'live' : 'pinned') : 'offline'}
      </span>
    </header>
  );
}
