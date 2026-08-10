/**
 * Header: flow selector, scenario selector, variant selector, base/head run pickers showing SHA,
 * ref, dirty badge and timestamp, plus the live indicator and the "run NNNN available" badge that
 * appears instead of yanking a pinned reviewer to a newer run (spec §9).
 *
 * The scenario and variant selectors sit between the flow and the run pickers because that is the
 * order in which they narrow: a flow, then which state of it, then which proposal of that state,
 * then which two captures (mocking spec §7; variants spec §5). Each appears only once a flow has
 * more than one value on that axis — a control with a single option is furniture.
 *
 * A variant run is badged on the picker, and a promoted one says so, because "same revision, one of
 * these is a proposal" is the fact that explains every finding below it (D24). Reading it off the
 * run's own row rather than off the loaded diff means it is right even before the diff arrives.
 */

import { SCENARIO_NONE, type RunMeta, type RunSummary } from '../../../types.js';
import { isKept, VARIANT_NONE, variantOf } from '../../variant.js';
import {
  ALL_SCENARIOS,
  ALL_VARIANTS,
  isEphemeralRun,
  runLabel,
  scenarioLabel,
  scenariosOf,
  variantLabel,
  variantsOf,
} from '../derive.js';
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
  /** True when the variant filter is off, so the run's own variant is worth naming. */
  showVariant: boolean;
  onChange: (runId: string) => void;
}) {
  const run = props.runs.find((r) => r.runId === props.value) ?? null;
  const mockOnly = props.meta?.network === 'mock';
  const variant = run === null ? VARIANT_NONE : variantOf(run);
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
      {props.showVariant && variant !== VARIANT_NONE ? (
        <span
          class="badge variant"
          title={
            `captured under variant ${variant}: a proposal applied to the rendered page, not a` +
            ' code change. ' +
            (run !== null && isEphemeralRun(run)
              ? 'Exploratory — retained in the variant bucket, so it never evicts capture history.'
              : 'Promoted with --keep into the permanent timeline.')
          }
        >
          {variant}
        </span>
      ) : null}
      {run && isKept(run) ? (
        <span
          class="badge kept"
          title="promoted into the permanent timeline with --keep, so retention treats it as an ordinary run"
        >
          kept
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
  const variants = variantsOf(state.runs);
  const runs = visibleRuns(state);
  const filtered = state.scenario !== ALL_SCENARIOS;
  const variantFiltered = state.variant !== ALL_VARIANTS;

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

      {variants.length > 1 ? (
        <div class="field">
          <label for="variant-select">variant</label>
          <select
            id="variant-select"
            value={state.variant}
            title="narrow the run pickers to one proposed UI change (variants spec §5)"
            onChange={(event: Event) => {
              const variant = (event.currentTarget as HTMLSelectElement).value;
              dispatch({ type: 'select-variant', variant });
            }}
          >
            <option value={ALL_VARIANTS}>all variants</option>
            {variants.map((name) => (
              <option key={name} value={name}>
                {variantLabel(name)}
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
        showVariant={!variantFiltered}
        onChange={(base) => dispatch({ type: 'select-base', base })}
      />
      <RunPicker
        label="head"
        value={state.head}
        runs={runs}
        meta={headMeta}
        showScenario={!filtered}
        showVariant={!variantFiltered}
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
