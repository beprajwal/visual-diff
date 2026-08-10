/**
 * Report app state as a pure reducer.
 *
 * The live-channel rule from spec §9 lives here and is the reason this is a reducer rather than a
 * pile of `useState` calls: when a new run lands, a reviewer who is following the newest head is
 * moved to it and the diff recomputes, while a reviewer who deliberately pinned an older pair is
 * left exactly where they are and told about the new run with an unobtrusive badge. Getting that
 * backwards yanks someone out of a review mid-sentence, so it is tested rather than eyeballed.
 */

import type {
  BackfillRequired,
  DiffResult,
  FeedbackEntry,
  FlowsResponse,
  Rect,
  RunId,
  RunSummary,
  ScenarioName,
  ServerEvent,
  StepId,
  ViewportId,
} from '../../types.js';
import type { RunAttribution, StepAttribution } from '../attribution.js';
import {
  variantOf,
  type RunVariantAttribution,
  type StepVariantAttribution,
  type VariantName,
} from '../variant.js';
import {
  ALL_SCENARIOS,
  ALL_VARIANTS,
  buildFilmstrip,
  runIndex,
  runsForScenario,
  runsForVariant,
  viewportsOf,
  visibleCells,
} from './derive.js';
import type { RouteState, ViewMode } from './route.js';

export type { ViewMode } from './route.js';

/** What a comment box is attached to (spec §9 feedback payload). */
export interface FeedbackTarget {
  step?: StepId;
  viewport?: ViewportId;
  findingId?: string;
  element?: string;
  region?: Rect;
  /** Crop path relative to the `.visual-diff` directory, shown as a thumbnail in the box. */
  crop?: string;
  /** Short human label for the box header. */
  label: string;
}

export interface AppState {
  flows: FlowsResponse['flows'];
  flow: string | null;
  runs: RunSummary[];
  /**
   * The scenario the run pickers are narrowed to, or {@link ALL_SCENARIOS} (mocking spec §7).
   *
   * A *filter*, not a capture argument: the runner decides what a run was captured under, and the
   * report only decides which of them are offered. Defaulting to one scenario would be worse than
   * it sounds — a reviewer who has never heard of scenarios would silently stop seeing runs.
   */
  scenario: ScenarioName;
  /**
   * The variant the run pickers are narrowed to, or {@link ALL_VARIANTS} (variants spec §5).
   *
   * The fourth axis of run identity, filtered exactly as the third is — and defaulting to "all" for
   * the same reason: a reviewer who has never written a variant must not silently stop seeing runs.
   */
  variant: VariantName;
  base: RunId | null;
  head: RunId | null;
  /** True while the head tracks the newest run. False once the reviewer pins an older pair. */
  following: boolean;
  /** Set when a run lands while the reviewer is pinned: renders the "run NNNN available" badge. */
  pendingRun: RunSummary | null;
  diff: DiffResult | null;
  /** Per-step scenario attribution for each end of the pair, keyed by run id (mocking spec §8). */
  attribution: Record<RunId, RunAttribution>;
  /** Per-step variant attribution for each end of the pair, keyed by run id (variants spec §7). */
  variantAttribution: Record<RunId, RunVariantAttribution>;
  backfill: BackfillRequired | null;
  /** The active pair's diff needs to be fetched. */
  diffStale: boolean;
  loadingDiff: boolean;
  step: StepId | null;
  viewport: ViewportId | null;
  view: ViewMode;
  /** Onion-skin opacity of the head image, 0..1. */
  overlayOpacity: number;
  /** Swipe divider position, 0..1. */
  swipeAt: number;
  findingsOnly: boolean;
  selectedFinding: string | null;
  feedback: FeedbackTarget | null;
  feedbackSaving: boolean;
  /** Feedback entries appended this session, newest first. */
  recentFeedback: FeedbackEntry[];
  connected: boolean;
  error: string | null;
}

export function initialState(route: RouteState = {}): AppState {
  return {
    flows: [],
    flow: route.flow ?? null,
    runs: [],
    scenario: route.scenario ?? ALL_SCENARIOS,
    variant: route.variant ?? ALL_VARIANTS,
    base: route.base ?? null,
    head: route.head ?? null,
    // A URL that names a pair is a deliberate pin until the run list proves it is the newest.
    following: route.base === undefined || route.head === undefined,
    pendingRun: null,
    diff: null,
    attribution: {},
    variantAttribution: {},
    backfill: null,
    diffStale: false,
    loadingDiff: false,
    step: route.step ?? null,
    viewport: route.viewport ?? null,
    view: route.view ?? 'side-by-side',
    overlayOpacity: 0.5,
    swipeAt: 0.5,
    findingsOnly: route.findingsOnly ?? false,
    selectedFinding: null,
    feedback: null,
    feedbackSaving: false,
    recentFeedback: [],
    connected: false,
    error: null,
  };
}

export type Action =
  | { type: 'flows-loaded'; flows: FlowsResponse['flows'] }
  | { type: 'select-flow'; flow: string }
  | { type: 'runs-loaded'; flow: string; runs: RunSummary[] }
  | { type: 'select-scenario'; scenario: ScenarioName }
  | { type: 'select-variant'; variant: VariantName }
  | { type: 'attribution-loaded'; attribution: RunAttribution }
  | { type: 'variant-attribution-loaded'; attribution: RunVariantAttribution }
  | { type: 'select-pair'; base: RunId; head: RunId }
  | { type: 'select-base'; base: RunId }
  | { type: 'select-head'; head: RunId }
  | { type: 'run-newer' }
  | { type: 'run-older' }
  | { type: 'jump-to-pending' }
  | { type: 'diff-loading' }
  | { type: 'diff-loaded'; diff: DiffResult }
  | { type: 'diff-backfill'; backfill: BackfillRequired }
  | { type: 'diff-failed'; message: string }
  | { type: 'select-step'; step: StepId }
  | { type: 'step-next' }
  | { type: 'step-prev' }
  | { type: 'select-viewport'; viewport: ViewportId }
  | { type: 'set-view'; view: ViewMode }
  | { type: 'toggle-overlay' }
  | { type: 'set-overlay-opacity'; value: number }
  | { type: 'set-swipe'; value: number }
  | { type: 'toggle-findings-only' }
  | { type: 'select-finding'; findingId: string | null }
  | { type: 'open-feedback'; target: FeedbackTarget }
  | { type: 'close-feedback' }
  | { type: 'feedback-saving' }
  | { type: 'feedback-saved'; entry: FeedbackEntry }
  | { type: 'feedback-failed'; message: string }
  | { type: 'dismiss' }
  | { type: 'connection'; connected: boolean }
  | { type: 'server-event'; event: ServerEvent }
  | { type: 'error'; message: string | null };

/* ------------------------------------------------------------------ helpers */

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function sortRuns(runs: readonly RunSummary[]): RunSummary[] {
  // Run ids are zero-padded and monotonic, so lexicographic order is chronological order.
  return runs.slice().sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

function upsertRun(runs: readonly RunSummary[], run: RunSummary): RunSummary[] {
  const next = runs.filter((r) => r.runId !== run.runId);
  next.push(run);
  return sortRuns(next);
}

export function newestRunId(runs: readonly RunSummary[]): RunId | null {
  const last = runs[runs.length - 1];
  return last ? last.runId : null;
}

/** True when `base` sits immediately before `head` in the run list. */
export function isAdjacentPair(
  runs: readonly RunSummary[],
  base: RunId | null,
  head: RunId | null,
): boolean {
  const b = runIndex(runs, base);
  const h = runIndex(runs, head);
  return b >= 0 && h >= 0 && h - b === 1;
}

/**
 * The runs the pickers offer: those matching both identity filters (mocking spec §7; variants §5).
 *
 * One function rather than two applied at each call site, because "newest run" and "the run one
 * step back" have to mean the same thing everywhere — and they mean *within what the pickers
 * currently offer*. A `[` that walked past runs the picker does not list would be a reviewer
 * jumping between states they did not ask to compare.
 */
export function narrowRuns(
  runs: readonly RunSummary[],
  scenario: ScenarioName,
  variant: VariantName,
): RunSummary[] {
  return runsForVariant(runsForScenario(runs, scenario), variant);
}

/** The runs the pickers offer for the current filters. */
export function visibleRuns(state: AppState): RunSummary[] {
  return narrowRuns(state.runs, state.scenario, state.variant);
}

/**
 * Per-step attribution for one end of the pair, indexed by step id (mocking spec §8).
 * An empty map when that run's attribution has not been fetched, or when it had no scenario.
 */
export function attributionForRun(
  state: AppState,
  runId: RunId | null,
): Record<StepId, StepAttribution> {
  const run = runId === null ? undefined : state.attribution[runId];
  if (run === undefined) return {};
  const byStep: Record<StepId, StepAttribution> = {};
  for (const step of run.steps) byStep[step.step] = step;
  return byStep;
}

/**
 * Per-step variant attribution for one end of the pair, indexed by step id (variants spec §7).
 * An empty map when that run's attribution has not been fetched, or when it had no variant.
 *
 * Kept separate from {@link attributionForRun} rather than merged into one record, because a pair
 * can carry both axes at once — "the denser layout, in the empty state" — and a reader has to be
 * able to tell which rules made this screen look like this: the ones that changed the responses, or
 * the ones that changed the rendered page.
 */
export function variantAttributionForRun(
  state: AppState,
  runId: RunId | null,
): Record<StepId, StepVariantAttribution> {
  const run = runId === null ? undefined : state.variantAttribution[runId];
  if (run === undefined) return {};
  const byStep: Record<StepId, StepVariantAttribution> = {};
  for (const step of run.steps) byStep[step.step] = step;
  return byStep;
}

/** Default pair for a run list: the previous run against the newest one (`vdiff diff` default). */
export function defaultPair(runs: readonly RunSummary[]): { base: RunId; head: RunId } | null {
  if (runs.length === 0) return null;
  const head = runs[runs.length - 1];
  if (!head) return null;
  const base = runs[runs.length - 2] ?? head;
  return { base: base.runId, head: head.runId };
}

/** The ordered step ids the reviewer can currently navigate between. */
export function navigableSteps(state: AppState): StepId[] {
  if (!state.diff) return [];
  return visibleCells(buildFilmstrip(state.diff, state.viewport), state.findingsOnly).map(
    (c) => c.id,
  );
}

function withPair(state: AppState, base: RunId, head: RunId): AppState {
  // "Newest" is newest *within the active scenario filter*: a reviewer looking at the empty state
  // is following the newest empty-state run, and a run of another scenario landing must not
  // demote them to "pinned" (mocking spec §7).
  const newest = newestRunId(narrowRuns(state.runs, state.scenario, state.variant));
  const following = newest === null || head === newest;
  return {
    ...state,
    base,
    head,
    following,
    pendingRun: following ? null : state.pendingRun,
    diffStale: true,
    backfill: null,
    selectedFinding: null,
    feedback: null,
  };
}

function shiftHead(state: AppState, delta: number): AppState {
  // Stepping moves through the *visible* runs, so `[` and `]` under a scenario filter walk that
  // scenario's history instead of skipping in and out of other scenarios' runs.
  const runs = narrowRuns(state.runs, state.scenario, state.variant);
  const index = runIndex(runs, state.head);
  if (index < 0) return state;
  const nextIndex = index + delta;
  const next = runs[nextIndex];
  if (!next) return state;
  // The base follows one behind, which is the pair a reviewer stepping through iterations wants.
  const base = runs[nextIndex - 1] ?? next;
  return withPair(state, base.runId, next.runId);
}

/**
 * Applies a change to one of the two identity filters (mocking spec §7; variants spec §5).
 *
 * Changing a filter re-defaults the pair unless the current one survives it. Keeping a pair whose
 * runs are no longer offered would leave the pickers showing a value they do not list — and quietly
 * re-selecting a different pair when the filter *does* still contain the current one would throw
 * away a deliberate choice.
 */
function applyFilter(
  state: AppState,
  filter: { scenario?: ScenarioName; variant?: VariantName },
): AppState {
  const next: AppState = {
    ...state,
    scenario: filter.scenario ?? state.scenario,
    variant: filter.variant ?? state.variant,
    pendingRun: null,
  };
  const visible = narrowRuns(next.runs, next.scenario, next.variant);
  const known = (id: RunId | null): boolean => runIndex(visible, id) >= 0;
  if (known(state.base) && known(state.head)) {
    return { ...next, following: state.head === newestRunId(visible), diffStale: true };
  }
  const pair = defaultPair(visible);
  if (!pair) {
    return {
      ...next,
      base: null,
      head: null,
      diff: null,
      backfill: null,
      diffStale: false,
      following: true,
      selectedFinding: null,
      feedback: null,
    };
  }
  return {
    ...next,
    base: pair.base,
    head: pair.head,
    following: true,
    diff: null,
    backfill: null,
    diffStale: true,
    selectedFinding: null,
    feedback: null,
  };
}

function shiftStep(state: AppState, delta: number): AppState {
  const steps = navigableSteps(state);
  if (steps.length === 0) return state;
  const current = state.step === null ? -1 : steps.indexOf(state.step);
  const nextIndex = current < 0 ? (delta > 0 ? 0 : steps.length - 1) : current + delta;
  const next = steps[nextIndex];
  if (!next) return state;
  return { ...state, step: next, selectedFinding: null };
}

/** Keeps step and viewport pointing at something that exists in the freshly loaded diff. */
function clampSelection(state: AppState, diff: DiffResult): AppState {
  const viewports = viewportsOf(diff);
  const viewport =
    state.viewport !== null && viewports.includes(state.viewport)
      ? state.viewport
      : (viewports[0] ?? null);

  const cells = buildFilmstrip(diff, viewport);
  const ids = cells.map((c) => c.id);
  const step = state.step !== null && ids.includes(state.step) ? state.step : (ids[0] ?? null);

  return { ...state, viewport, step };
}

/* ------------------------------------------------------------------ reducer */

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'flows-loaded': {
      const flow = state.flow ?? action.flows[0]?.name ?? null;
      return { ...state, flows: action.flows, flow };
    }

    case 'select-flow': {
      if (action.flow === state.flow) return state;
      return {
        ...state,
        flow: action.flow,
        runs: [],
        // Neither filter is carried across flows: `empty-forecast` — or `denser-forecast` — may
        // simply not exist in the next one, and an empty picker would look like a store with no
        // runs in it.
        scenario: ALL_SCENARIOS,
        variant: ALL_VARIANTS,
        attribution: {},
        variantAttribution: {},
        base: null,
        head: null,
        following: true,
        pendingRun: null,
        diff: null,
        backfill: null,
        diffStale: false,
        step: null,
        selectedFinding: null,
        feedback: null,
      };
    }

    case 'runs-loaded': {
      if (action.flow !== state.flow) return state;
      const runs = sortRuns(action.runs);
      const visible = narrowRuns(runs, state.scenario, state.variant);
      const known = (id: RunId | null): boolean => runIndex(visible, id) >= 0;
      if (known(state.base) && known(state.head)) {
        const newest = newestRunId(visible);
        return { ...state, runs, following: state.head === newest, diffStale: true };
      }
      const pair = defaultPair(visible);
      if (!pair) {
        return { ...state, runs, base: null, head: null, diff: null, diffStale: false };
      }
      return { ...state, runs, base: pair.base, head: pair.head, following: true, diffStale: true };
    }

    case 'select-scenario':
      return action.scenario === state.scenario
        ? state
        : applyFilter(state, { scenario: action.scenario });

    /*
     * The variant filter behaves identically to the scenario one, deliberately: they are the third
     * and fourth axes of the same identity (variants spec §5), not a hierarchy, and a reviewer who
     * has learned what one picker does has learned what the other does.
     */
    case 'select-variant':
      return action.variant === state.variant
        ? state
        : applyFilter(state, { variant: action.variant });

    case 'attribution-loaded':
      return {
        ...state,
        attribution: { ...state.attribution, [action.attribution.runId]: action.attribution },
      };

    case 'variant-attribution-loaded':
      return {
        ...state,
        variantAttribution: {
          ...state.variantAttribution,
          [action.attribution.runId]: action.attribution,
        },
      };

    case 'select-pair':
      return withPair(state, action.base, action.head);

    case 'select-base':
      return state.head === null ? state : withPair(state, action.base, state.head);

    case 'select-head': {
      if (state.base !== null) return withPair(state, state.base, action.head);
      const visible = narrowRuns(state.runs, state.scenario, state.variant);
      const index = runIndex(visible, action.head);
      const base = index > 0 ? visible[index - 1] : undefined;
      return withPair(state, base?.runId ?? action.head, action.head);
    }

    case 'run-newer':
      return shiftHead(state, 1);

    case 'run-older':
      return shiftHead(state, -1);

    case 'jump-to-pending': {
      const pending = state.pendingRun;
      if (!pending) return state;
      const visible = narrowRuns(state.runs, state.scenario, state.variant);
      const index = runIndex(visible, pending.runId);
      const base = index > 0 ? visible[index - 1] : undefined;
      return {
        ...withPair(state, base?.runId ?? pending.runId, pending.runId),
        pendingRun: null,
        following: true,
      };
    }

    case 'diff-loading':
      return { ...state, loadingDiff: true, error: null };

    case 'diff-loaded': {
      const next = clampSelection(
        { ...state, diff: action.diff, backfill: null, diffStale: false, loadingDiff: false },
        action.diff,
      );
      return next;
    }

    case 'diff-backfill':
      return {
        ...state,
        diff: null,
        backfill: action.backfill,
        diffStale: false,
        loadingDiff: false,
      };

    case 'diff-failed':
      return { ...state, diffStale: false, loadingDiff: false, error: action.message };

    case 'select-step':
      return { ...state, step: action.step, selectedFinding: null };

    case 'step-next':
      return shiftStep(state, 1);

    case 'step-prev':
      return shiftStep(state, -1);

    case 'select-viewport': {
      if (action.viewport === state.viewport) return state;
      return { ...state, viewport: action.viewport, selectedFinding: null };
    }

    case 'set-view':
      return { ...state, view: action.view };

    case 'toggle-overlay':
      return { ...state, view: state.view === 'overlay' ? 'side-by-side' : 'overlay' };

    case 'set-overlay-opacity':
      return { ...state, overlayOpacity: clamp01(action.value) };

    case 'set-swipe':
      return { ...state, swipeAt: clamp01(action.value) };

    case 'toggle-findings-only': {
      const findingsOnly = !state.findingsOnly;
      const next: AppState = { ...state, findingsOnly };
      // Filtering must not strand the selection on a step that just disappeared.
      const steps = navigableSteps(next);
      if (next.step !== null && !steps.includes(next.step)) {
        next.step = steps[0] ?? null;
        next.selectedFinding = null;
      }
      return next;
    }

    case 'select-finding':
      return { ...state, selectedFinding: action.findingId };

    case 'open-feedback':
      return { ...state, feedback: action.target, error: null };

    case 'close-feedback':
      return { ...state, feedback: null, feedbackSaving: false };

    case 'feedback-saving':
      return { ...state, feedbackSaving: true, error: null };

    case 'feedback-saved':
      return {
        ...state,
        feedback: null,
        feedbackSaving: false,
        recentFeedback: [action.entry, ...state.recentFeedback].slice(0, 50),
      };

    case 'feedback-failed':
      return { ...state, feedbackSaving: false, error: action.message };

    case 'dismiss': {
      if (state.feedback) return { ...state, feedback: null, feedbackSaving: false };
      if (state.selectedFinding) return { ...state, selectedFinding: null };
      if (state.error) return { ...state, error: null };
      return state;
    }

    case 'connection':
      return { ...state, connected: action.connected };

    case 'error':
      return { ...state, error: action.message };

    case 'server-event':
      return reduceServerEvent(state, action.event);

    default:
      return state;
  }
}

/* ------------------------------------------------------------------ live channel (§9) */

function reduceServerEvent(state: AppState, event: ServerEvent): AppState {
  switch (event.type) {
    case 'hello': {
      const flows = state.flows.length > 0 ? state.flows : event.flows.map(helloFlow);
      const flow = state.flow ?? event.flows[0] ?? null;
      return { ...state, connected: true, flows, flow };
    }

    case 'run': {
      if (event.flow !== state.flow) return state;
      const previousRuns = state.runs;
      const runs = upsertRun(previousRuns, event.run);

      // A run the reviewer has filtered out on either axis joins the timeline but changes nothing
      // on screen: neither a jump nor a badge. Badging it would be an invitation to a pair the
      // pickers do not even offer.
      if (
        (state.scenario !== ALL_SCENARIOS && event.run.scenario !== state.scenario) ||
        (state.variant !== ALL_VARIANTS && variantOf(event.run) !== state.variant)
      ) {
        return { ...state, runs };
      }

      // A re-announcement of the run already on screen refreshes the timeline and the diff, but
      // must not shuffle the pair out from under the reviewer.
      if (event.run.runId === state.head) return { ...state, runs, diffStale: true };

      // Pinned: never move the reviewer. Surface the run as a badge they can act on.
      if (!state.following) {
        return { ...state, runs, pendingRun: event.run };
      }

      // Following: advance to the new head. The base advances too when the reviewer was looking at
      // an adjacent pair (the N-1 vs N default); an explicitly chosen base stays put.
      const previousHead = state.head;
      const previousVisible = narrowRuns(previousRuns, state.scenario, state.variant);
      const base =
        previousHead !== null && isAdjacentPair(previousVisible, state.base, previousHead)
          ? previousHead
          : (state.base ?? previousHead ?? event.run.runId);

      return {
        ...state,
        runs,
        base,
        head: event.run.runId,
        following: true,
        pendingRun: null,
        diffStale: true,
        backfill: null,
      };
    }

    case 'diff': {
      if (event.flow !== state.flow) return state;
      const current = state.base && state.head ? `${state.base}..${state.head}` : null;
      if (current === null || event.pair !== current) return state;
      // The server finishes the diff before announcing it, so this is always a complete pair.
      return { ...state, diffStale: true };
    }

    case 'feedback':
      return {
        ...state,
        recentFeedback: [
          event.entry,
          ...state.recentFeedback.filter((e) => e.id !== event.entry.id),
        ].slice(0, 50),
      };

    case 'error':
      return { ...state, error: event.message };

    default:
      return state;
  }
}

function helloFlow(name: string): FlowsResponse['flows'][number] {
  return { name, runs: 0, latest: null };
}

/** The route describing the current position, for the location hash. */
export function routeOf(state: AppState): RouteState {
  const route: RouteState = { view: state.view, findingsOnly: state.findingsOnly };
  if (state.flow) route.flow = state.flow;
  if (state.scenario !== ALL_SCENARIOS) route.scenario = state.scenario;
  if (state.variant !== ALL_VARIANTS) route.variant = state.variant;
  if (state.base) route.base = state.base;
  if (state.head) route.head = state.head;
  if (state.step) route.step = state.step;
  if (state.viewport) route.viewport = state.viewport;
  return route;
}
