/** AI assessments affect PR presentation only. Measured findings and gates stay independent. */
import { createHash } from 'node:crypto';
import type { DiffResult, Finding, Review, ReviewNoiseAssessment, ReviewTriage, ReviewViewportAssessment } from '../types.js';
import { TRIAGE_ASSESSMENTS } from '../types.js';
import { significantDiff, significantReview, significanceFingerprint, withProjectedSteps } from '../diff/significance.js';

const cellKey = (step: string, viewport: string): string => JSON.stringify([step, viewport]);

/** A corrupted/legacy review must never gain authority to remove evidence. */
export function currentTriage(result: DiffResult, review?: Review): ReviewTriage | undefined {
  if (!review || review.flow !== result.flow || review.pair?.base !== result.pair.base ||
    review.pair?.head !== result.pair.head || review.engineVersion !== result.engineVersion ||
    review.diffFingerprint !== significanceFingerprint(result)) return undefined;
  const triage = review.triage;
  if (!triage || triage.version !== 1 || !Array.isArray(triage.findings) ||
    !Array.isArray(triage.viewports) || !Array.isArray(triage.comparedCells)) return undefined;
  return triage;
}

function validAssessment(value: ReviewNoiseAssessment | null | undefined): value is ReviewNoiseAssessment {
  return value != null && TRIAGE_ASSESSMENTS.includes(value.assessment) &&
    (value.confidence === 'high' || value.confidence === 'low') &&
    typeof value.reason === 'string' && value.reason.trim().length > 0;
}

/** Duplicate IDs are ambiguous, including when only one of the duplicates looks valid. */
function unique<T>(values: readonly T[], key: (value: T) => string): Map<string, T> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return new Map(values.filter(value => counts.get(key(value)) === 1).map(value => [key(value), value]));
}

function noise(assessment: ReviewNoiseAssessment | undefined): boolean {
  return validAssessment(assessment) && assessment.assessment === 'capture-noise' && assessment.confidence === 'high';
}

export function noiseEligible(finding: Finding): boolean {
  if (finding.severity === 'high') return false;
  if (finding.kind === 'layout') return true;
  return finding.kind === 'content' && finding.nodeChange === undefined && finding.changes.length === 0 &&
    finding.reasons.includes('pixels-only');
}

export interface ReviewProjection {
  result: DiffResult;
  review?: Review;
  omittedFindings: number;
  omittedViewports: number;
  captureConcerns: ReviewViewportAssessment[];
}

export function reviewProjection(raw: DiffResult, review?: Review): ReviewProjection {
  const result = significantDiff(raw);
  const output: ReviewProjection = { result, review: significantReview(raw, review),
    omittedFindings: 0, omittedViewports: 0, captureConcerns: [] };
  const triage = currentTriage(raw, review);
  if (!triage) return output;
  const findings = unique(triage.findings.filter(f => f != null), f => f.findingId);
  const viewports = unique(triage.viewports.filter(v => v != null), v => cellKey(v.step, v.viewport));
  const assessedCells = new Set(triage.viewports.filter(v => v != null).map(v => cellKey(v.step, v.viewport)));
  const paired = new Set(triage.comparedCells.filter(c => c != null).map(c => cellKey(c.step, c.viewport)));
  const allFindings = result.steps.flatMap(s => [...s.findings, ...Object.values(s.viewports).flatMap(v => v.findings)]);
  const uniqueIds = unique(allFindings, f => f.id);
  const steps = result.steps.map(step => {
    let hiddenView = false;
    const kept = Object.fromEntries(Object.entries(step.viewports).flatMap(([id, vp]) => {
      const key = cellKey(step.id, id);
      const assessment = viewports.get(key);
      const incomplete = triage.viewports.find(v => validAssessment(v) &&
        cellKey(v.step, v.viewport) === key && v.assessment === 'capture-incomplete');
      const incompleteFinding = triage.findings.find(f => validAssessment(f) &&
        f.assessment === 'capture-incomplete' && vp.findings.some(finding => finding.id === f.findingId));
      if (incomplete) output.captureConcerns.push(incomplete);
      else if (incompleteFinding) output.captureConcerns.push({ step: step.id, viewport: id, ...incompleteFinding });
      const ambiguous = assessedCells.has(key) && !viewports.has(key);
      const contradiction = review?.changes.some(c => c.step === step.id && (c.viewport === null || c.viewport === id));
      if (step.status !== 'matched' || vp.missing !== undefined || vp.dimensionsChanged ||
        !paired.has(key) || incomplete || incompleteFinding || contradiction || ambiguous) return [[id, vp]];
      const retained = vp.findings.filter(f => !uniqueIds.has(f.id) || !noiseEligible(f) || !noise(findings.get(f.id)));
      output.omittedFindings += vp.findings.length - retained.length;
      if (noise(assessment) && retained.length === 0 && step.findings.length === 0 &&
        (vp.pixelChangedRatio > 0 || vp.findings.length > 0)) {
        output.omittedViewports++;
        hiddenView = true;
        return [];
      }
      return [[id, retained.length === vp.findings.length ? vp : { ...vp, findings: retained }]];
    }));
    if (hiddenView && step.findings.length === 0 && Object.values(kept).every(vp =>
      !vp.missing && vp.pixelChangedRatio === 0 && !vp.dimensionsChanged && vp.findings.length === 0)) return [];
    return [{ ...step, viewports: kept }];
  }).flat();
  if (output.omittedFindings > 0 || output.omittedViewports > 0) output.result = withProjectedSteps(result, steps);
  return output;
}

/** Preview pixels depend on the review too; removing or revising it invalidates earlier images. */
export function commentFingerprint(result: DiffResult, review?: Review): string {
  const base = significanceFingerprint(result);
  const triage = currentTriage(result, review);
  if (!triage) return base;
  return createHash('sha256').update(JSON.stringify({ version: 1, base, triage, changes: review?.changes })).digest('hex');
}
