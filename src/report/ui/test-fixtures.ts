/**
 * Builders for the report-UI unit tests. Every builder produces a fully populated value of the
 * corresponding contract in `src/types.ts`, so a test only states the fields it actually cares
 * about and the rest stay realistic.
 *
 * Not part of the shipped bundle: nothing in `main.tsx` imports this module.
 */

import {
  SCENARIO_NONE,
  type DiffResult,
  type DiffSummary,
  type Finding,
  type FlowDiffEntry,
  type PairScenarios,
  type RunMeta,
  type RunSummary,
  type StepDiff,
  type StepId,
  type ViewportDiff,
  type ViewportId,
} from '../../types.js';
import type { RunAttribution, StepAttribution } from '../attribution.js';
import {
  VARIANT_NONE,
  type RunVariantAttribution,
  type StepVariantAttribution,
  type VariantName,
  type VariantRuleHit,
  type VariantVerb,
} from '../variant.js';

/**
 * `RunMeta` and `RunSummary` as this slice's tests need them: with the variant axis (variants spec
 * §5) declared optional, so the default fixture is what a record written *before* variants existed
 * looks like — no key at all — and a test that cares passes one explicitly.
 */
export type FakeRunMeta = RunMeta & { variant?: VariantName; kept?: boolean };
export type FakeRunSummary = RunSummary & { variant?: VariantName; kept?: boolean };

export function makeRunMeta(runId: string, patch: Partial<FakeRunMeta> = {}): FakeRunMeta {
  return {
    runId,
    flow: 'checkout',
    scenario: SCENARIO_NONE,
    flowHash: 'sha256:deadbeef',
    revision: { sha: `sha-${runId}`, ref: 'main', dirty: false },
    mode: 'attach',
    network: 'replay',
    harHits: 41,
    harMisses: 0,
    viewports: ['1280x800', '390x844'],
    status: 'ok',
    failedSteps: [],
    env: {
      tool: '0.1.0',
      node: 'v20.11.0',
      playwright: '1.49.0',
      chromium: '131',
      os: 'darwin-arm64',
      deviceScaleFactor: 2,
    },
    startedAt: '2026-08-08T10:00:00Z',
    finishedAt: '2026-08-08T10:00:41Z',
    unstable: false,
    pinned: false,
    pruned: false,
    warnings: [],
    ...patch,
  };
}

export function makeRun(
  runId: string,
  revision: Partial<RunSummary['revision']> = {},
  patch: Partial<FakeRunSummary> = {},
): FakeRunSummary {
  return {
    runId,
    flow: 'checkout',
    scenario: SCENARIO_NONE,
    revision: { sha: `sha-${runId}`, ref: 'main', dirty: false, ...revision },
    mode: 'attach',
    status: 'ok',
    startedAt: '2026-08-08T10:00:00Z',
    finishedAt: '2026-08-08T10:00:41Z',
    viewports: ['1280x800', '390x844'],
    failedSteps: [],
    unstable: false,
    pinned: false,
    pruned: false,
    findingsCount: null,
    ...patch,
  };
}

export function makeFinding(id: string, patch: Partial<Finding> = {}): Finding {
  return {
    id,
    kind: 'content',
    severity: 'med',
    step: 'pay-form',
    viewport: '1280x800',
    element: { selector: '[data-test=pay]', role: 'button', name: 'Pay now' },
    region: { x: 6, y: 56, w: 86, h: 19 },
    changes: [{ prop: 'text', from: 'Pay', to: 'Pay now' }],
    label: 'text changed',
    reasons: [],
    ...patch,
  };
}

export function makeViewportDiff(
  viewport: ViewportId,
  patch: Partial<ViewportDiff> = {},
): ViewportDiff {
  return {
    viewport,
    pixelChangedRatio: 0,
    baseSize: { w: 1280, h: 2400 },
    headSize: { w: 1280, h: 2400 },
    dimensionsChanged: false,
    regions: [],
    findings: [],
    ...patch,
  };
}

export function makeStepDiff(
  id: StepId,
  status: StepDiff['status'],
  patch: Partial<StepDiff> = {},
): StepDiff {
  return {
    id,
    status,
    viewports: {},
    findings: [],
    ...patch,
  };
}

export function makeSummary(patch: Partial<DiffSummary> = {}): DiffSummary {
  return {
    totalFindings: 0,
    bySeverity: { high: 0, med: 0, low: 0 },
    byKind: {
      content: 0,
      style: 0,
      layout: 0,
      structural: 0,
      a11y: 0,
      console: 0,
      network: 0,
    },
    stepsCompared: 0,
    stepsChanged: 0,
    stepsAdded: 0,
    stepsRemoved: 0,
    stepsSpecChanged: 0,
    stepsFailed: 0,
    stepsBlocked: 0,
    maxPixelChangedRatio: 0,
    ...patch,
  };
}

export function makeDiff(
  patch: Partial<DiffResult> & { flowDiff?: FlowDiffEntry[]; steps?: StepDiff[] },
): DiffResult {
  const base = patch.pair?.base ?? '0003';
  const head = patch.pair?.head ?? '0007';
  return {
    engineVersion: '1',
    flow: 'checkout',
    pair: { base, head },
    computedAt: '2026-08-08T10:01:00Z',
    baseMeta: makeRunMeta(base),
    headMeta: makeRunMeta(head),
    flowDiff: [],
    steps: [],
    summary: makeSummary(),
    warnings: [],
    ...patch,
  };
}

export function makePairScenarios(patch: Partial<PairScenarios> = {}): PairScenarios {
  return {
    base: SCENARIO_NONE,
    head: SCENARIO_NONE,
    crossScenario: false,
    mockVsRecorded: false,
    ...patch,
  };
}

export function makeStepAttribution(
  step: StepId,
  patch: Partial<StepAttribution> = {},
): StepAttribution {
  return { step, rules: [], passthroughs: 0, misses: 0, ...patch };
}

export function makeAttribution(
  runId: string,
  patch: Partial<RunAttribution> = {},
): RunAttribution {
  return { flow: 'checkout', runId, scenario: SCENARIO_NONE, steps: [], ...patch };
}

/* ------------------------------------------------------------------ variants (§5, §7) */

export function makeVariantHit(
  ruleId: string,
  patch: Partial<VariantRuleHit> = {},
): VariantRuleHit {
  return {
    variant: 'denser-forecast',
    ruleId,
    verb: 'style' as VariantVerb,
    elements: 1,
    viewports: ['1280x800'],
    ...patch,
  };
}

export function makeStepVariantAttribution(
  step: StepId,
  patch: Partial<StepVariantAttribution> = {},
): StepVariantAttribution {
  return { step, rules: [], ...patch };
}

export function makeVariantAttribution(
  runId: string,
  patch: Partial<RunVariantAttribution> = {},
): RunVariantAttribution {
  return {
    flow: 'checkout',
    runId,
    variant: VARIANT_NONE,
    steps: [],
    unmatchedRules: [],
    revertedRules: [],
    ...patch,
  };
}
