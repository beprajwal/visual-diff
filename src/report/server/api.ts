/**
 * Read-only API handlers (spec §9): `GET /api/flows`, `GET /api/runs/:flow`,
 * `GET /api/diff/:base..:head`, `GET /api/attribution/:flow/:runId`.
 *
 * Handlers return data; `routes.ts` owns the wire. Nothing here writes, spawns or shells out.
 */

import type { DiffResponse, FlowsResponse, RunId, RunsResponse } from '../../types.js';
import type { RunAttribution } from '../attribution.js';
import type { ReportStore } from './deps.js';
import type { DiffService } from './diff-service.js';
import { HttpError } from './http.js';
import { isValidFlowName, isValidRunId } from './store-reader.js';

export interface Pair {
  base: RunId;
  head: RunId;
}

/** Parse the `:base..:head` path segment. */
export function parsePair(spec: string): Pair {
  const parts = spec.split('..');
  if (parts.length !== 2) {
    throw new HttpError(400, 'bad-pair', `Expected "<base>..<head>", got "${spec}".`);
  }
  const [base, head] = parts as [string, string];
  if (!isValidRunId(base) || !isValidRunId(head)) {
    throw new HttpError(400, 'bad-pair', `Run ids must be zero-padded numbers, got "${spec}".`);
  }
  return { base, head };
}

export function requireFlowName(raw: string | null | undefined): string {
  if (!raw) {
    throw new HttpError(400, 'missing-flow', 'A flow name is required.');
  }
  if (!isValidFlowName(raw)) {
    throw new HttpError(400, 'bad-flow', `"${raw}" is not a valid flow name.`);
  }
  return raw;
}

export async function handleFlows(store: ReportStore): Promise<FlowsResponse> {
  return { flows: await store.listFlows() };
}

export async function handleRuns(store: ReportStore, flowRaw: string): Promise<RunsResponse> {
  const flow = requireFlowName(flowRaw);
  const known = await store.listFlows();
  if (!known.some((f) => f.name === flow)) {
    throw new HttpError(404, 'unknown-flow', `No flow named "${flow}".`);
  }
  return { flow, runs: await store.listRuns(flow) };
}

/**
 * `GET /api/attribution/:flow/:runId` (mocking spec §8).
 *
 * A separate route rather than a field on the diff because it is a property of *one run*, and the
 * report needs it for both ends of a pair — including a cross-scenario pair, where the two sides
 * were shaped by different rules and folding them into one payload would lose which was which.
 */
export async function handleAttribution(
  store: ReportStore,
  flowRaw: string,
  runIdRaw: string,
): Promise<RunAttribution> {
  const flow = requireFlowName(flowRaw);
  if (!isValidRunId(runIdRaw)) {
    throw new HttpError(400, 'bad-run-id', `Run ids must be zero-padded numbers, got "${runIdRaw}".`);
  }
  const attribution = await store.readAttribution(flow, runIdRaw);
  if (attribution === null) {
    throw new HttpError(404, 'unknown-run', `No run ${runIdRaw} in flow "${flow}".`);
  }
  return attribution;
}

export async function handleDiff(
  diffs: DiffService,
  flowRaw: string,
  pairSpec: string,
): Promise<DiffResponse> {
  const flow = requireFlowName(flowRaw);
  const { base, head } = parsePair(pairSpec);
  return diffs.get(flow, base, head);
}
