/** Provider schema and evidence validation for the optional AI assessment of capture noise. */
import { z } from 'zod';
import { TRIAGE_ASSESSMENTS, type DiffResult, type ReviewNoiseAssessment, type ReviewTriage } from '../types.js';

const properties = {
  assessment: { type: 'string', enum: [...TRIAGE_ASSESSMENTS] },
  confidence: { type: 'string', enum: ['high', 'low'] },
  reason: { type: 'string', description: 'Short evidence-based explanation; cite the visible difference.' },
} as const;

export const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', description: 'Assess findings by exact ID. Unassessed findings remain visible.', items: {
      type: 'object', properties: { findingId: { type: 'string' }, ...properties },
      required: ['findingId', 'assessment', 'confidence', 'reason'], additionalProperties: false,
    } },
    viewports: { type: 'array', description: 'Assess the whole visual difference, including pixels not attributed to findings.', items: {
      type: 'object', properties: { step: { type: 'string' }, viewport: { type: 'string' }, ...properties },
      required: ['step', 'viewport', 'assessment', 'confidence', 'reason'], additionalProperties: false,
    } },
  },
  required: ['findings', 'viewports'], additionalProperties: false,
} as const;

const fields = {
  assessment: z.enum(TRIAGE_ASSESSMENTS), confidence: z.enum(['high', 'low']), reason: z.string().trim().min(1),
};
export const TriageBody = z.object({
  findings: z.array(z.object({ findingId: z.string(), ...fields }).strict()),
  viewports: z.array(z.object({ step: z.string(), viewport: z.string(), ...fields }).strict()),
}).strict();

const key = (step: string, viewport: string) => JSON.stringify([step, viewport]);
const unambiguous = <T>(values: T[], id: (value: T) => string): T[] => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(id(value), (counts.get(id(value)) ?? 0) + 1);
  return values.filter(value => counts.get(id(value)) === 1);
};

export function validateTriage(
  body: z.infer<typeof TriageBody>, result: DiffResult, promptFindingIds: readonly string[],
  comparedCells: ReviewTriage['comparedCells'],
): ReviewTriage {
  const knownCells = new Set(result.steps.flatMap(step => Object.keys(step.viewports).map(vp => key(step.id, vp))));
  const actualPairs = comparedCells.filter(c => knownCells.has(key(c.step, c.viewport)));
  const paired = new Set(actualPairs.map(c => key(c.step, c.viewport)));
  const locations = result.steps.flatMap(step => [
    ...step.findings.map(finding => ({ id: finding.id, cell: '' })),
    ...Object.entries(step.viewports).flatMap(([vp, diff]) => diff.findings.map(finding => ({ id: finding.id, cell: key(step.id, vp) }))),
  ]);
  const ids = new Set(promptFindingIds);
  const knownFindings = new Map(unambiguous(locations, location => location.id)
    .filter(location => ids.has(location.id)).map(location => [location.id, location.cell]));
  const grounded = <T extends ReviewNoiseAssessment>(value: T, cell: string): T => {
    if (value.assessment !== 'capture-noise' || paired.has(cell)) return value;
    return { ...value, assessment: 'uncertain', confidence: 'low',
      reason: `${value.reason} Both base and head screenshots were not supplied; this finding remains visible.` };
  };
  return { version: 1, comparedCells: actualPairs,
    // Keep duplicate model decisions for audit. The projection treats them as ambiguous and
    // must still see any capture-incomplete warning among them before deciding what to hide.
    findings: body.findings.filter(f => knownFindings.has(f.findingId))
      .map(f => grounded(f, knownFindings.get(f.findingId)!)),
    viewports: body.viewports.filter(v => knownCells.has(key(v.step, v.viewport)))
      .map(v => grounded(v, key(v.step, v.viewport))),
  };
}
