/**
 * Header: flow selector, base/head run pickers showing SHA, ref, dirty badge and timestamp, plus
 * the live indicator and the "run NNNN available" badge that appears instead of yanking a pinned
 * reviewer to a newer run (spec §9).
 */

import type { RunSummary } from '../../../types.js';
import { runLabel } from '../derive.js';
import type { Action, AppState } from '../state.js';

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
  onChange: (runId: string) => void;
}) {
  const run = props.runs.find((r) => r.runId === props.value) ?? null;
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

      <RunPicker
        label="base"
        value={state.base}
        runs={state.runs}
        onChange={(base) => dispatch({ type: 'select-base', base })}
      />
      <RunPicker
        label="head"
        value={state.head}
        runs={state.runs}
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
