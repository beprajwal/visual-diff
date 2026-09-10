import { describe, expect, it } from 'vitest';
import { makeDiff, makeFinding, makeStepDiff, makeViewportDiff } from '../report/ui/test-fixtures.js';
import { significantDiff } from './significance.js';
import { minorDiff } from './tolerance-testkit.js';

describe('significantDiff', () => {
  it('omits minor changes without mutating detailed evidence', () => {
    const raw = minorDiff();
    const before = JSON.stringify(raw);
    const filtered = significantDiff(raw);
    expect(filtered.steps).toEqual([]);
    expect(filtered.summary).toMatchObject({ totalFindings: 0, stepsCompared: 1, stepsChanged: 0, maxPixelChangedRatio: 0 });
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('filters minor findings on a significant viewport and preserves real content', () => {
    const raw = minorDiff();
    const vp = raw.steps[0]!.viewports['1280x800']!;
    delete vp.withinTolerance;
    vp.findings.push(makeFinding('real-content', { nodeChange: 'text', severity: 'high' }));
    const filtered = significantDiff(raw);
    expect(filtered.steps[0]!.viewports['1280x800']!.findings.map(f => f.id)).toEqual(['real-content']);
    expect(filtered.summary).toMatchObject({ totalFindings: 1, bySeverity: { high: 1, med: 0, low: 0 }, stepsChanged: 1 });
    expect(significantDiff(filtered)).toEqual(filtered);
  });

  it('preserves console errors and failed steps even when their pixels are minor', () => {
    const raw = minorDiff();
    raw.steps[0]!.findings.push(makeFinding('error', { kind: 'console', severity: 'high' }));
    raw.steps.push(makeStepDiff('failed', 'failed'));
    const filtered = significantDiff(raw);
    expect(filtered.steps.map(s => s.id)).toEqual(['minor-step', 'failed']);
    expect(filtered.summary.totalFindings).toBe(1);
    expect(filtered.summary.stepsChanged).toBe(0);
  });

  it('leaves results without tolerance metadata unchanged', () => {
    const raw = makeDiff({});
    expect(significantDiff(raw)).toBe(raw);
  });

  it('omits a minor-only step even when another viewport is identical', () => {
    const raw = minorDiff();
    raw.steps[0]!.viewports['390x844'] = makeViewportDiff('390x844');
    expect(significantDiff(raw).steps).toEqual([]);
  });

  it('uses the significant pixel measurement in mixed viewports', () => {
    const raw = minorDiff();
    const vp = raw.steps[0]!.viewports['1280x800']!;
    delete vp.withinTolerance;
    vp.pixelChangedRatio = 0.018;
    vp.significantPixelChangedRatio = 0.01;
    vp.findings.push(makeFinding('real-pixels'));
    const filtered = significantDiff(raw);
    expect(filtered.summary.maxPixelChangedRatio).toBe(0.01);
    expect(filtered.steps[0]!.viewports['1280x800']!.pixelChangedRatio).toBe(0.01);
    expect(vp.pixelChangedRatio).toBe(0.018);
  });
});
