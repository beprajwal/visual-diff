import { describe, expect, it } from 'vitest';

import {
  makeDiff,
  makeFinding,
  makeStepDiff,
  makeViewportDiff,
} from '../report/ui/test-fixtures.js';
import {
  allFindings,
  cropPath,
  isImageSelection,
  selectCells,
  shotCells,
  shotPath,
  sortFindings,
  stepScopedFindings,
} from './layout.js';

const diff = makeDiff({
  steps: [
    makeStepDiff('cart', 'matched', {
      viewports: {
        '1280x800': makeViewportDiff('1280x800'),
        '390x844': makeViewportDiff('390x844', { pixelChangedRatio: 0.031 }),
      },
    }),
    makeStepDiff('pay-form', 'matched', {
      // A console finding has no viewport: it belongs to the step.
      findings: [makeFinding('f9', { kind: 'console', severity: 'high', viewport: undefined })],
      viewports: {
        '1280x800': makeViewportDiff('1280x800', {
          pixelChangedRatio: 0.12,
          findings: [makeFinding('f1', { severity: 'low' })],
          pixelPath: 'diffs/checkout/0003..0007/steps/pay-form/1280x800/pixel.png',
        }),
      },
    }),
    makeStepDiff('receipt', 'added', {
      viewports: { '1280x800': makeViewportDiff('1280x800', { missing: 'base' }) },
    }),
  ],
});

describe('shotCells', () => {
  it('emits one cell per (step, viewport) in flow order', () => {
    expect(shotCells(diff).map((cell) => `${cell.step}/${cell.viewport}`)).toEqual([
      'cart/1280x800',
      'cart/390x844',
      'pay-form/1280x800',
      'receipt/1280x800',
    ]);
  });

  it('attaches step-scoped findings to every cell of that step', () => {
    const cell = shotCells(diff).find((c) => c.step === 'pay-form');
    expect(cell?.findings.map((f) => f.id)).toEqual(['f9', 'f1']);
  });

  it('carries the missing side and the pixel source through', () => {
    const cells = shotCells(diff);
    expect(cells.find((c) => c.step === 'receipt')?.missing).toBe('base');
    expect(cells.find((c) => c.step === 'pay-form')?.pixelStorePath).toContain('pixel.png');
    expect(cells.find((c) => c.step === 'cart' && c.viewport === '1280x800')?.pixelStorePath).toBeUndefined();
  });

  it('marks a cell changed on a finding, any pixel movement, or a non-matched step', () => {
    const byKey = new Map(shotCells(diff).map((cell) => [`${cell.step}/${cell.viewport}`, cell]));
    expect(byKey.get('cart/1280x800')?.changed).toBe(false);
    expect(byKey.get('cart/390x844')?.changed).toBe(true);
    expect(byKey.get('pay-form/1280x800')?.changed).toBe(true);
    expect(byKey.get('receipt/1280x800')?.changed).toBe(true);
  });
});

describe('selectCells', () => {
  const cells = shotCells(diff);

  it('changed keeps only the cells that moved', () => {
    expect(selectCells(cells, 'changed')).toHaveLength(3);
  });

  it('all keeps every cell and none keeps nothing', () => {
    expect(selectCells(cells, 'all')).toHaveLength(4);
    expect(selectCells(cells, 'none')).toEqual([]);
  });

  it('validates the selection vocabulary', () => {
    expect(isImageSelection('changed')).toBe(true);
    expect(isImageSelection('some')).toBe(false);
  });
});

describe('bundle paths', () => {
  it('are relative, slash-separated, and never escape the bundle', () => {
    expect(shotPath('pay-form', '1280x800', 'pixel')).toBe(
      'images/pay-form/1280x800/pixel.png',
    );
    expect(cropPath('f1')).toBe('images/crops/f1.png');
  });

  it('neutralise a segment that would escape or nest', () => {
    // The separators are gone, so what is left is one flat filename rather than a path.
    expect(shotPath('../../etc', 'a/b', 'base')).toBe('images/.._.._etc/a_b/base.png');
    // A segment that is nothing but dots is traversal, so it is replaced outright.
    expect(shotPath('..', '.', 'head')).toBe('images/_/_/head.png');
    expect(cropPath('')).toBe('images/crops/_.png');
  });
});

describe('finding collections', () => {
  it('sort by severity then id', () => {
    const sorted = sortFindings([
      makeFinding('f3', { severity: 'low' }),
      makeFinding('f1', { severity: 'high' }),
      makeFinding('f2', { severity: 'high' }),
      makeFinding('f4', { severity: 'med' }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(['f1', 'f2', 'f4', 'f3']);
  });

  it('allFindings gathers both scopes exactly once', () => {
    expect(allFindings(diff).map((f) => f.id)).toEqual(['f9', 'f1']);
  });

  it('stepScopedFindings gathers only the ones no image can show', () => {
    expect(stepScopedFindings(diff).map((f) => f.id)).toEqual(['f9']);
  });
});
