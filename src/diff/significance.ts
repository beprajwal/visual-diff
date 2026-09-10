/** Read-only PR projection. Stored evidence and the detailed HTML report remain complete. */
import { createHash } from 'node:crypto';
import type { DiffResult, Review, ViewportDiff } from '../types.js';

export function hasMinorChanges(result: DiffResult): boolean {
  return result.steps.some(step => step.findings.some(f => f.withinTolerance) ||
    Object.values(step.viewports).some(vp => vp.withinTolerance || vp.findings.some(f => f.withinTolerance) ||
      (vp.significantPixelChangedRatio !== undefined && vp.significantPixelChangedRatio < vp.pixelChangedRatio) ||
      (vp.dimensionsChanged && vp.significantDimensionsChanged === false)));
}

export function significantDiff(result: DiffResult): DiffResult {
  if (!hasMinorChanges(result)) return result;
  const steps = result.steps.map(step => {
    const findings = step.findings.filter(f => !f.withinTolerance);
    const viewports: Record<string, ViewportDiff> = {};
    for (const [id, vp] of Object.entries(step.viewports)) {
      const significant = vp.findings.filter(f => !f.withinTolerance);
      if (vp.withinTolerance && step.status === 'matched' && findings.length === 0 && significant.length === 0) continue;
      const { withinTolerance, significantPixelChangedRatio, significantDimensionsChanged, ...evidence } = vp;
      viewports[id] = { ...evidence, findings: significant,
        ...(significantPixelChangedRatio === undefined ? {} : { pixelChangedRatio: significantPixelChangedRatio }),
        ...(significantDimensionsChanged === undefined ? {} : { dimensionsChanged: significantDimensionsChanged }),
        ...(withinTolerance ? { pixelChangedRatio: 0, dimensionsChanged: false } : {}) };
    }
    return { ...step, findings, viewports };
  }).filter(step => {
    if (step.status !== 'matched' || step.findings.length > 0) return true;
    const original = result.steps.find(raw => raw.id === step.id);
    const hadMinor = Object.values(original?.viewports ?? {}).some(vp => vp.withinTolerance);
    const viewports = Object.values(step.viewports);
    return hadMinor ? viewports.some(vp => vp.missing !== undefined || vp.pixelChangedRatio > 0 || vp.dimensionsChanged || vp.findings.length > 0) : viewports.length > 0;
  });

  const summary = { ...result.summary, totalFindings: 0, stepsChanged: 0, maxPixelChangedRatio: 0,
    bySeverity: { ...result.summary.bySeverity }, byKind: { ...result.summary.byKind } };
  for (const severity of Object.keys(summary.bySeverity) as Array<keyof typeof summary.bySeverity>) summary.bySeverity[severity] = 0;
  for (const kind of Object.keys(summary.byKind) as Array<keyof typeof summary.byKind>) summary.byKind[kind] = 0;
  for (const step of steps) {
    const viewports = Object.values(step.viewports);
    if (viewports.some(vp => vp.missing === undefined && (vp.pixelChangedRatio > 0 || vp.dimensionsChanged))) summary.stepsChanged++;
    for (const vp of viewports) summary.maxPixelChangedRatio = Math.max(summary.maxPixelChangedRatio, vp.pixelChangedRatio);
    for (const finding of [...step.findings, ...viewports.flatMap(vp => vp.findings)]) {
      summary.totalFindings++;
      summary.bySeverity[finding.severity]++;
      summary.byKind[finding.kind]++;
    }
  }
  const ids = new Set(steps.map(step => step.id));
  return { ...result, steps, summary,
    flowDiff: result.flowDiff.filter(entry => entry.status !== 'matched' || ids.has(entry.id)) };
}

/** Bind free-text AI reviews and preview images to the evidence and tolerance classification. */
export function significanceFingerprint(result: DiffResult): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1, flow: result.flow, pair: result.pair, engine: result.engineVersion,
    computedAt: result.computedAt, steps: result.steps, flowDiff: result.flowDiff,
  })).digest('hex');
}

export function significantReview(result: DiffResult, review?: Review): Review | undefined {
  if (!hasMinorChanges(result)) return review;
  return review?.diffFingerprint === significanceFingerprint(result) ? review : undefined;
}
