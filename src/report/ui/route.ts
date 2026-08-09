/**
 * Hash routing. The location hash carries the whole review position — flow, pair, step, viewport,
 * view mode and the findings-only filter — so a reviewer can paste a URL at an agent and land on
 * exactly the thing they are talking about.
 *
 * Encoded as a query string inside the hash: `#flow=checkout&pair=0003..0007&step=pay-form`.
 *
 * The scenario filter travels too (mocking spec §7): a link to "the empty state at these two
 * revisions" is exactly the kind of thing a reviewer pastes at an agent, and it would be a poor
 * link if it landed on the unfiltered timeline.
 */

import type { PairId, RunId, ScenarioName, StepId, ViewportId } from '../../types.js';
import { pairId, parsePairId } from './paths.js';

export type ViewMode = 'side-by-side' | 'overlay' | 'swipe';

export const VIEW_MODES: readonly ViewMode[] = ['side-by-side', 'overlay', 'swipe'];

export function isViewMode(value: string): value is ViewMode {
  return (VIEW_MODES as readonly string[]).includes(value);
}

export interface RouteState {
  flow?: string;
  /** Scenario filter; `*` (ALL_SCENARIOS) is the default and is never written to the hash. */
  scenario?: ScenarioName;
  base?: RunId;
  head?: RunId;
  step?: StepId;
  viewport?: ViewportId;
  view?: ViewMode;
  findingsOnly?: boolean;
}

/** Parses a location hash (with or without the leading `#`) into a route. Unknown keys are ignored. */
export function parseHash(hash: string): RouteState {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const route: RouteState = {};

  const flow = params.get('flow');
  if (flow) route.flow = flow;

  const pair = params.get('pair');
  if (pair) {
    const parsed = parsePairId(pair);
    if (parsed) {
      route.base = parsed.base;
      route.head = parsed.head;
    }
  }

  const scenario = params.get('scenario');
  if (scenario) route.scenario = scenario;

  const step = params.get('step');
  if (step) route.step = step;

  const viewport = params.get('viewport');
  if (viewport) route.viewport = viewport;

  const view = params.get('view');
  if (view && isViewMode(view)) route.view = view;

  const findings = params.get('findings');
  if (findings !== null) route.findingsOnly = findings === '1' || findings === 'true';

  return route;
}

/**
 * Serialises a route back to a hash. Defaults are omitted so the common URL stays short and so a
 * fresh load and a round-tripped load produce the same string.
 */
export function formatHash(route: RouteState): string {
  const params = new URLSearchParams();
  if (route.flow) params.set('flow', route.flow);
  if (route.scenario && route.scenario !== '*') params.set('scenario', route.scenario);
  if (route.base && route.head) params.set('pair', pairId(route.base, route.head));
  if (route.step) params.set('step', route.step);
  if (route.viewport) params.set('viewport', route.viewport);
  if (route.view && route.view !== 'side-by-side') params.set('view', route.view);
  if (route.findingsOnly) params.set('findings', '1');
  const query = params.toString();
  return query.length > 0 ? `#${query}` : '';
}

/** The pair id a route names, or null when it does not name a complete pair. */
export function routePair(route: RouteState): PairId | null {
  return route.base && route.head ? pairId(route.base, route.head) : null;
}
