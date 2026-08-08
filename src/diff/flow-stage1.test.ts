import { describe, expect, it } from 'vitest';
import * as flowEdge from '../flow/index.js';
import * as diffEdge from './index.js';

/**
 * Stage 1's behaviour is tested in `flow/structural-diff.test.ts`, where the implementation lives
 * (spec §5). What must be tested *here* is that the `diff/` edge only ever re-exports it: the
 * moment a second implementation of the alignment grows behind this edge, the engine and the report
 * can disagree about what a step bucket means, which is exactly the drift D4 cannot tolerate.
 *
 * This replaces the identical guard that used to sit on `diff/flowDiff.ts`, a file that existed
 * only to forward these three names and has been removed.
 */
describe('the stage-1 flow diff at the diff/ edge', () => {
  it('is the very same implementation the flow module edge exposes', () => {
    expect(diffEdge.structuralFlowDiff).toBe(flowEdge.structuralFlowDiff);
    expect(diffEdge.describeStepChanges).toBe(flowEdge.describeStepChanges);
    expect(diffEdge.isComparable).toBe(flowEdge.isComparable);
  });

  it('agrees with the flow module on a real alignment, not just by identity', () => {
    const base = { name: 'checkout', steps: [{ id: 'cart' }, { id: 'pay' }] };
    const head = { name: 'checkout', steps: [{ id: 'cart' }, { id: 'receipt' }] };

    const viaDiff = diffEdge.structuralFlowDiff({ base, head } as never);
    const viaFlow = flowEdge.structuralFlowDiff({ base, head } as never);

    expect(viaDiff).toEqual(viaFlow);
    expect(viaDiff.map((entry) => [entry.id, entry.status])).toEqual([
      ['cart', 'matched'],
      ['pay', 'removed'],
      ['receipt', 'added'],
    ]);
  });
});
