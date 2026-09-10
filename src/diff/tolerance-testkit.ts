import { makeDiff, makeFinding, makeStepDiff, makeSummary, makeViewportDiff } from '../report/ui/test-fixtures.js';

export function minorDiff() {
  return makeDiff({
    steps: [makeStepDiff('minor-step', 'matched', { viewports: {
      '1280x800': makeViewportDiff('1280x800', { pixelChangedRatio: 0.003,
        withinTolerance: true, findings: [makeFinding('minor-finding', {
          step: 'minor-step', withinTolerance: true, reasons: ['pixels-only'], label: 'tiny pixel noise' })] }),
    } })],
    summary: makeSummary({ totalFindings: 1, bySeverity: { high: 0, med: 1, low: 0 },
      stepsCompared: 1, stepsChanged: 1, maxPixelChangedRatio: 0.003 }),
  });
}
