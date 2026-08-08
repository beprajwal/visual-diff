/**
 * store/snapshot — `flow.snapshot.yaml`, the exact spec a run executed (spec §6).
 *
 * The store owns this file because it is part of the run directory and, unlike the blobs, it
 * **survives pruning forever** so the timeline stays intact and a pruned point remains
 * backfillable by replay. Serialization is canonical (fixed key order, no anchors, no folding) so
 * two runs of the same spec produce byte-identical snapshots and `git diff` on a fixture run is
 * readable.
 *
 * Full spec *validation* — the closed verb list, `sleep` rejection, line-accurate issues — belongs
 * to the flow module. What lives here is only enough to write and read back the run's own record.
 */

import * as YAML from 'yaml';

import { StoreError } from './errors.js';
import { STEP_VERBS, type FlowSnapshot, type Step } from '../types.js';

/** Key order used when writing a snapshot. Stable output is what makes the file diffable. */
const TOP_LEVEL_ORDER = ['version', 'flow', 'baseUrl', 'viewports', 'network', 'steps'] as const;

function orderedStep(step: Step): Record<string, unknown> {
  const out: Record<string, unknown> = { id: step.id };
  const source = step as unknown as Record<string, unknown>;
  for (const verb of STEP_VERBS) {
    const value = source[verb];
    if (value !== undefined) out[verb] = value;
  }
  // Anything outside the closed vocabulary is preserved rather than dropped: the snapshot must be
  // the *exact* spec that ran, even if a future verb is added.
  for (const key of Object.keys(source)) {
    if (key === 'id' || key in out) continue;
    if ((STEP_VERBS as readonly string[]).includes(key)) continue;
    out[key] = source[key];
  }
  return out;
}

export function serializeFlowSnapshot(snapshot: FlowSnapshot): string {
  const source = snapshot as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of TOP_LEVEL_ORDER) {
    const value = source[key];
    if (value === undefined) continue;
    ordered[key] = key === 'steps' ? snapshot.steps.map(orderedStep) : value;
  }
  for (const key of Object.keys(source)) {
    if (key in ordered) continue;
    if ((TOP_LEVEL_ORDER as readonly string[]).includes(key)) continue;
    ordered[key] = source[key];
  }
  return YAML.stringify(ordered, { lineWidth: 0, nullStr: 'null' });
}

function fail(message: string, cause?: unknown): never {
  throw new StoreError('corrupt-snapshot', `flow.snapshot.yaml is unusable: ${message}`, { cause });
}

/**
 * Read a snapshot back. Tolerant of a hand-written fixture that omits optional sections, strict
 * about the two things every consumer relies on: the flow name and the ordered step list with
 * stable ids (D4 alignment depends on those ids).
 */
export function parseFlowSnapshot(text: string): FlowSnapshot {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (err) {
    return fail((err as Error).message, err);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('top level is not a mapping');
  }
  const doc = parsed as Record<string, unknown>;

  const flow = doc['flow'];
  if (typeof flow !== 'string' || flow === '') return fail('missing "flow"');

  const rawSteps = doc['steps'];
  if (!Array.isArray(rawSteps)) return fail('missing "steps" list');
  const steps: Step[] = rawSteps.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail(`steps[${index}] is not a mapping`);
    }
    const step = raw as Record<string, unknown>;
    const id = step['id'];
    if (typeof id !== 'string' || id === '') return fail(`steps[${index}] has no "id"`);
    return step as unknown as Step;
  });

  const viewports = Array.isArray(doc['viewports'])
    ? (doc['viewports'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  const network =
    doc['network'] !== null && typeof doc['network'] === 'object' && !Array.isArray(doc['network'])
      ? (doc['network'] as FlowSnapshot['network'])
      : { mode: 'off' as const };

  const out: FlowSnapshot = {
    version: 1,
    flow,
    viewports,
    network,
    steps,
  };
  if (typeof doc['baseUrl'] === 'string') out.baseUrl = doc['baseUrl'];
  return out;
}
