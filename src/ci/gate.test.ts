import { describe, expect, it } from 'vitest';

import { makeSummary } from '../report/ui/test-fixtures.js';
import { GATE_LEVELS, evaluateGate, isGateLevel } from './gate.js';

describe('evaluateGate', () => {
  it('never trips at the default level, whatever the counts', () => {
    const summary = makeSummary({ totalFindings: 99, bySeverity: { high: 12, med: 40, low: 47 } });
    const verdict = evaluateGate(summary);
    expect(verdict.level).toBe('none');
    expect(verdict.tripped).toBe(false);
    expect(verdict.reason).toContain('never enforced');
  });

  it('high counts only high-severity findings', () => {
    const noHigh = makeSummary({ totalFindings: 8, bySeverity: { high: 0, med: 5, low: 3 } });
    expect(evaluateGate(noHigh, 'high').tripped).toBe(false);

    const oneHigh = makeSummary({ totalFindings: 9, bySeverity: { high: 1, med: 5, low: 3 } });
    const verdict = evaluateGate(oneHigh, 'high');
    expect(verdict.tripped).toBe(true);
    expect(verdict.reason).toBe('1 high-severity finding (gate: high)');
  });

  it('any counts every finding', () => {
    const one = makeSummary({ totalFindings: 1, bySeverity: { high: 0, med: 0, low: 1 } });
    expect(evaluateGate(one, 'any')).toEqual({
      level: 'any',
      tripped: true,
      reason: '1 finding (gate: any)',
    });
    expect(evaluateGate(makeSummary(), 'any').tripped).toBe(false);
  });

  it('always explains itself, tripped or not', () => {
    for (const level of GATE_LEVELS) {
      expect(evaluateGate(makeSummary(), level).reason.length).toBeGreaterThan(0);
    }
  });

  it('recognises exactly the three levels', () => {
    expect(GATE_LEVELS).toEqual(['none', 'high', 'any']);
    expect(isGateLevel('high')).toBe(true);
    expect(isGateLevel('HIGH')).toBe(false);
    expect(isGateLevel('warn')).toBe(false);
  });
});
