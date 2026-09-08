import { describe, expect, it } from 'vitest';

import { shotCells } from './layout.js';
import {
  DEFAULT_MAX_CHANGES,
  changeKind,
  rankChanges,
  renderPreviewCard,
} from './preview-card.js';
import { makeDiff, makeFinding, makeStepDiff, makeSummary, makeViewportDiff } from '../report/ui/test-fixtures.js';

function fixture() {
  const result = makeDiff({
    flowDiff: [
      { id: 'cart', status: 'matched', baseIndex: 0, headIndex: 0 },
      { id: 'pay-form', status: 'matched', baseIndex: 1, headIndex: 1 },
      { id: 'receipt', status: 'added', baseIndex: null, headIndex: 2 },
      { id: 'legacy', status: 'removed', baseIndex: 2, headIndex: null },
    ],
    steps: [
      makeStepDiff('cart', 'matched', {
        viewports: {
          '1280x800': makeViewportDiff('1280x800', { pixelChangedRatio: 0.01, findings: [makeFinding('f1', { severity: 'low' })] }),
        },
      }),
      makeStepDiff('pay-form', 'matched', {
        viewports: {
          '1280x800': makeViewportDiff('1280x800', { pixelChangedRatio: 0.3, findings: [makeFinding('f2', { severity: 'high', label: 'button lost its name' })] }),
        },
      }),
      makeStepDiff('receipt', 'added', {
        viewports: { '1280x800': makeViewportDiff('1280x800', { pixelChangedRatio: 1, findings: [] }) },
      }),
      makeStepDiff('legacy', 'removed', {
        viewports: { '1280x800': makeViewportDiff('1280x800', { pixelChangedRatio: 1, findings: [] }) },
      }),
    ],
    summary: makeSummary({ totalFindings: 2, bySeverity: { high: 1, med: 0, low: 1 }, stepsCompared: 2, stepsChanged: 2, stepsAdded: 1, stepsRemoved: 1, maxPixelChangedRatio: 0.3 }),
  });
  const cells = shotCells(result).filter((cell) => cell.changed);
  const available = new Set(cells.flatMap((cell) => [cell.paths.base, cell.paths.head]));
  return { result, cells, available };
}

describe('the card the picture is taken of (D51)', () => {
  it('ranks additions and removals first, then the worst finding, then the most pixels', () => {
    const { cells } = fixture();
    expect(rankChanges(cells).map((cell) => `${cell.step}:${changeKind(cell)}`)).toEqual([
      'receipt:added',
      'legacy:removed',
      'pay-form:changed',
      'cart:changed',
    ]);
  });

  it('numbers every change and puts base and head side by side under it', () => {
    const { result, cells, available } = fixture();
    const html = renderPreviewCard({ result, cells, available, version: '0.15.0' });
    expect(html).toContain('<span class="n">1</span><code>receipt</code>');
    expect(html).toContain('<span class="n">3</span><code>pay-form</code>');
    // An added step has no base, and the card says so rather than showing a broken image.
    expect(html).toContain('not in the base — this step is new');
    expect(html).toContain('not in the head — this step is gone');
    // A changed step shows both captures, addressed relative to the bundle.
    expect(html).toContain('<img src="images/pay-form/1280x800/base.png"');
    expect(html).toContain('<img src="images/pay-form/1280x800/head.png"');
    // The pixel diff is not on the card: base and head only.
    expect(html).not.toContain('pixel.png');
    // What the reader reads first: the kind, the amount, the finding.
    expect(html).toContain('30.0% of pixels changed · 1 finding — button lost its name');
    // Nothing on the card needs a network or runs code.
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/src="https?:/);
  });

  it('says when a capture the change needs is not in the bundle', () => {
    const { result, cells } = fixture();
    const html = renderPreviewCard({ result, cells, available: new Set(), version: '0.15.0' });
    expect(html).toContain('capture not in the bundle');
    expect(html).not.toContain('<img');
  });

  it('caps the list and counts the rest', () => {
    const { result, cells, available } = fixture();
    const html = renderPreviewCard({ result, cells, available, version: '0.15.0', maxChanges: 2 });
    expect(html).toContain('<span class="n">2</span>');
    expect(html).not.toContain('<span class="n">3</span>');
    expect(html).toContain('and 2 more changes in the report');
    expect(DEFAULT_MAX_CHANGES).toBe(6);
  });

  it('has a sentence, not an empty list, when nothing moved', () => {
    const { result } = fixture();
    const html = renderPreviewCard({ result, cells: [], available: new Set(), version: '0.15.0' });
    expect(html).toContain('Nothing moved between the two revisions.');
    expect(html).not.toContain('<ol');
  });
});
