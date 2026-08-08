/**
 * Canonical serialization of a FlowSpec (spec §6).
 *
 * Two consumers depend on this being byte-stable:
 *   - `flow.snapshot.yaml`, "the exact spec this run executed", written into every run directory;
 *   - `flowHash`, which must move when the flow's *meaning* moves and stay put when only comments,
 *     whitespace or key order move.
 *
 * Canonical form therefore fixes key order, drops comments, materializes `shoot` (which defaults to
 * true), and never wraps long lines.
 */

import { Document, isMap, isSeq } from 'yaml';
import { STEP_VERBS, type Expectation, type FlowSpec, type ScrollAction, type Step } from '../types.js';

/** Key order inside `scroll`. */
const SCROLL_KEYS = ['selector', 'x', 'y', 'to'] as const;
/** Key order inside an `expect` entry. */
const EXPECT_KEYS = ['selector', 'visible', 'hidden', 'text', 'count'] as const;

/** FlowSpec → canonical YAML. Always ends with a newline. */
export function serializeFlow(spec: FlowSpec): string {
  const doc = new Document(canonicalFlow(spec));

  setFlowStyle(doc.get('viewports', true));
  setFlowStyle(doc.get('network', true));

  const steps = doc.get('steps', true);
  if (isSeq(steps)) {
    for (const item of steps.items) {
      if (!isMap(item)) continue;
      setFlowStyle(item.get('mask', true));
      setFlowStyle(item.get('fill', true));
    }
  }

  return doc.toString({ lineWidth: 0, minContentWidth: 0, singleQuote: false });
}

/** The plain object behind the canonical YAML. Exported for hashing and for tests. */
export function canonicalFlow(spec: FlowSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { version: 1, flow: spec.flow };
  if (spec.baseUrl !== undefined) out.baseUrl = spec.baseUrl;
  out.viewports = [...spec.viewports];
  out.network =
    spec.network.har === undefined
      ? { mode: spec.network.mode }
      : { mode: spec.network.mode, har: spec.network.har };
  out.steps = spec.steps.map(canonicalStep);
  return out;
}

export function canonicalStep(step: Step): Record<string, unknown> {
  const out: Record<string, unknown> = { id: step.id };
  for (const verb of STEP_VERBS) {
    if (verb === 'shoot') {
      // Materialized on purpose: an omitted `shoot` and an explicit `shoot: true` are the same flow.
      out.shoot = step.shoot ?? true;
      continue;
    }
    const value = step[verb];
    if (value === undefined) continue;
    out[verb] = canonicalVerbValue(verb, value);
  }
  return out;
}

function canonicalVerbValue(verb: string, value: unknown): unknown {
  switch (verb) {
    case 'scroll':
      return canonicalScroll(value as ScrollAction);
    case 'expect':
      return (value as Expectation[]).map(canonicalExpectation);
    case 'mask':
      return [...(value as string[])];
    case 'fill':
      // Insertion order is preserved: fields are filled in the order the author wrote them.
      return { ...(value as Record<string, string>) };
    default:
      return value;
  }
}

function canonicalScroll(scroll: ScrollAction): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SCROLL_KEYS) {
    const value = scroll[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function canonicalExpectation(expectation: Expectation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EXPECT_KEYS) {
    const value = expectation[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function setFlowStyle(node: unknown): void {
  if (isSeq(node) || isMap(node)) node.flow = true;
}
