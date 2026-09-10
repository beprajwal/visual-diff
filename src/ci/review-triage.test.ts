import { describe, expect, it } from 'vitest';
import { fakeReview } from '../cli/testing.js';
import { makeDiff, makeFinding, makeStepDiff, makeSummary, makeViewportDiff } from '../report/ui/test-fixtures.js';
import { significanceFingerprint, significantDiff } from '../diff/significance.js';
import { commentFingerprint, reviewProjection } from './review-triage.js';
import { renderCommentWithGate } from './comment.js';
import { renderPreviewCard } from './preview-card.js';
import { shotCells } from './layout.js';
import { parseReviewBody } from './review.js';
import type { Review } from '../types.js';

function fixture() {
  const result = makeDiff({ steps: [makeStepDiff('noise', 'matched', { viewports: {
    '1280x800': makeViewportDiff('1280x800', { pixelChangedRatio: .02,
      findings: [makeFinding('f1', { step: 'noise', severity: 'med', changes: [], reasons: ['pixels-only'] })] }),
  } })], summary: makeSummary({ totalFindings: 1, stepsCompared: 1, stepsChanged: 1,
    bySeverity: { high: 0, med: 1, low: 0 }, maxPixelChangedRatio: .02 }) });
  const assessment = { assessment: 'capture-noise' as const, confidence: 'high' as const,
    reason: 'Only the animated caret differs between the otherwise matching screenshots.' };
  const review = fakeReview({ flow: result.flow, pair: result.pair, engineVersion: result.engineVersion,
    diffFingerprint: significanceFingerprint(result), changes: [], concerns: [],
    triage: { version: 1,
      comparedCells: [{ step: 'noise', viewport: '1280x800' }],
      findings: [{ findingId: 'f1', ...assessment }],
      viewports: [{ step: 'noise', viewport: '1280x800', ...assessment }],
    } });
  return { result, review };
}

describe('AI noise projection', () => {
  it.each(['viewport', 'finding'] as const)('retains readiness warnings from duplicate %s assessments', level => {
    const { result, review } = fixture();
    const triage = { findings: [...review.triage!.findings], viewports: [...review.triage!.viewports] };
    if (level === 'viewport') triage.viewports.push({ ...triage.viewports[0]!, assessment: 'capture-incomplete', reason: 'The head shows a loading skeleton.' });
    else triage.findings.push({ ...triage.findings[0]!, assessment: 'capture-incomplete', reason: 'The head shows a loading skeleton.' });
    const body = parseReviewBody(JSON.stringify({ headline: 'Review', summary: 'Capture differs.', changes: [], concerns: [], triage }),
      result, review.triage!.comparedCells);
    const projected = reviewProjection(result, { ...review, ...body });
    expect(projected.result).toEqual(result);
    expect(projected.omittedFindings).toBe(0);
    expect(projected.captureConcerns[0]?.reason).toContain('loading skeleton');
  });

  it('does not suppress findings in a viewport with ambiguous assessments', () => {
    const { result, review } = fixture();
    review.triage!.viewports.push({ ...review.triage!.viewports[0]!, assessment: 'meaningful' });
    expect(reviewProjection(result, review).result).toEqual(result);
  });

  it('omits supported noise from comments and previews, preserving raw evidence and gates', () => {
    const { result, review } = fixture();
    const before = JSON.stringify(result);
    const projected = reviewProjection(result, review);
    expect(projected.result.steps).toEqual([]);
    expect(projected.result.summary).toMatchObject({ totalFindings: 0, stepsChanged: 0, maxPixelChangedRatio: 0 });
    expect(projected.omittedFindings).toBe(1);
    const { document, gate } = renderCommentWithGate({ result, review, version: 'test' }, 'any');
    expect(document.markdown).toContain('AI classified the reviewed visual changes as capture noise');
    expect(document.markdown).toContain('gate still uses measured findings');
    expect(document.markdown).not.toContain('2.0%');
    expect(gate.tripped).toBe(true);
    const preview = renderPreviewCard({ result, review, cells: shotCells(result), available: new Set(), version: 'test' });
    expect(preview).not.toContain('2.0%');
    expect(preview).toContain('capture noise');
    expect(JSON.stringify(result)).toBe(before);
    expect(significantDiff(result).summary.totalFindings).toBe(1);
  });

  it.each(['missing', 'stale', 'unbound', 'no-images', 'low-confidence', 'duplicate', 'unknown'])(
    'falls back to measured findings for %s assessments', mode => {
      const { result, review } = fixture();
      if (mode === 'stale') review.diffFingerprint = 'stale';
      if (mode === 'unbound') delete review.diffFingerprint;
      if (mode === 'no-images') review.triage!.comparedCells = [];
      if (mode === 'low-confidence') review.triage!.findings[0]!.confidence = 'low';
      if (mode === 'duplicate') review.triage!.findings.push({ ...review.triage!.findings[0]! });
      if (mode === 'unknown') review.triage!.findings[0]!.findingId = 'invented';
      expect(reviewProjection(result, mode === 'missing' ? undefined : review).result).toEqual(result);
    });

  it.each(['content', 'style', 'structural', 'a11y', 'console', 'network'] as const)(
    'preserves confirmed %s findings even when the model calls them noise', kind => {
      const { result, review } = fixture();
      const finding = result.steps[0]!.viewports['1280x800']!.findings[0]!;
      finding.kind = kind;
      finding.reasons = [];
      review.diffFingerprint = significanceFingerprint(result);
      expect(reviewProjection(result, review).result).toEqual(result);
    });

  it('keeps incomplete captures visible with a readiness concern', () => {
    const { result, review } = fixture();
    review.triage!.viewports[0]!.assessment = 'capture-incomplete';
    review.triage!.viewports[0]!.reason = 'The head still shows a loading skeleton.';
    const projected = reviewProjection(result, review);
    expect(projected.result).toEqual(result);
    expect(projected.captureConcerns).toHaveLength(1);
    const { document } = renderCommentWithGate({ result, review, version: 'test' }, 'none');
    expect(document.markdown).toContain('Capture readiness');
    expect(document.markdown).toContain('loading skeleton');
  });

  it('retains unreviewed pixels in mixed views while omitting an assessed noise finding', () => {
    const { result, review } = fixture();
    review.triage!.viewports[0]!.assessment = 'uncertain';
    const projected = reviewProjection(result, review).result;
    expect(projected.steps[0]!.viewports['1280x800']!.findings).toEqual([]);
    expect(projected.summary.maxPixelChangedRatio).toBe(.02);
    expect(projected.summary.stepsChanged).toBe(1);
  });

  it('does not hide views that the same review describes as meaningful changes', () => {
    const { result, review } = fixture();
    review.changes = [{ step: 'noise', viewport: '1280x800', assessment: 'regression', description: 'A control is clipped.' }];
    expect(reviewProjection(result, review).result).toEqual(result);
  });

  it.each(['failed', 'blocked', 'added', 'removed', 'spec-changed'] as const)('preserves %s steps', status => {
    const { result, review } = fixture();
    result.steps[0]!.status = status;
    review.diffFingerprint = significanceFingerprint(result);
    expect(reviewProjection(result, review).result).toEqual(result);
  });

  it('binds preview images to the review and rejects them when review decisions change or disappear', () => {
    const { result, review } = fixture();
    const fingerprint = commentFingerprint(result, review);
    expect(fingerprint).not.toBe(commentFingerprint(result));
    const changed = structuredClone(review);
    changed.triage!.findings[0]!.assessment = 'uncertain';
    expect(commentFingerprint(result, changed)).not.toBe(fingerprint);
    const render = (candidate?: Review) => renderCommentWithGate({ result, review: candidate, version: 'test',
      imageBase: 'https://example.test', preview: { light: 'preview.png' }, previewDiffFingerprint: fingerprint }, 'none').document.markdown;
    expect(render(review)).toContain('https://example.test/preview.png');
    expect(render(changed)).not.toContain('preview.png');
    expect(render()).not.toContain('preview.png');
  });
});
