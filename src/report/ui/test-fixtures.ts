/**
 * Builders for the report-UI unit tests. Every builder produces a fully populated value of the
 * corresponding contract in `src/types.ts`, so a test only states the fields it actually cares
 * about and the rest stay realistic.
 *
 * Not part of the shipped bundle: nothing in `main.tsx` imports this module.
 */

import type {
  DiffResult,
  DiffSummary,
  Finding,
  FlowDiffEntry,
  RunMeta,
  RunSummary,
  StepDiff,
  StepId,
  ViewportDiff,
  ViewportId,
} from '../../types.js';

export function makeRunMeta(runId: string, patch: Partial<RunMeta> = {}): RunMeta {
  return {
    runId,
    flow: 'checkout',
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
  patch: Partial<RunSummary> = {},
): RunSummary {
  return {
    runId,
    flow: 'checkout',
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
