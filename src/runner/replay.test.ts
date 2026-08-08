import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import type { Step } from '../types.js';
import { nextAnchor, pngSize, selectorOf, verbOf } from './replay.js';

describe('pngSize', () => {
  it('reads the IHDR chunk of a real PNG', () => {
    const png = new PNG({ width: 37, height: 11 });
    const size = pngSize(PNG.sync.write(png));
    expect(size).toEqual({ width: 37, height: 11 });
  });

  it('reports zeroes rather than throwing on a truncated buffer', () => {
    expect(pngSize(new Uint8Array(4))).toEqual({ width: 0, height: 0 });
  });
});

describe('verbOf', () => {
  it('names the verb a step failed on, in vocabulary order', () => {
    expect(verbOf({ id: 'a', goto: '/cart' })).toBe('goto');
    expect(verbOf({ id: 'a', click: '#pay' })).toBe('click');
    expect(verbOf({ id: 'a', waitFor: 'text=Payment' })).toBe('waitFor');
    expect(verbOf({ id: 'a', shoot: true })).toBeUndefined();
  });
});

describe('selectorOf', () => {
  it('returns the selector the step resolved against — the D4 drift signal', () => {
    expect(selectorOf({ id: 'a', click: '[data-test=pay]' })).toBe('[data-test=pay]');
    expect(selectorOf({ id: 'a', fill: { '[name=card]': '4242' } })).toBe('[name=card]');
    expect(selectorOf({ id: 'a', scroll: { selector: '#footer' } })).toBe('#footer');
    expect(selectorOf({ id: 'a', goto: '/cart' })).toBeUndefined();
  });
});

describe('nextAnchor', () => {
  const steps: Step[] = [
    { id: 'cart', goto: '/cart' },
    { id: 'pay-form', click: '#pay' },
    { id: 'fill-card', fill: { '[name=card]': '4242' } },
    { id: 'receipt', goto: '/receipt' },
    { id: 'print', click: '#print' },
  ];

  it('finds the next goto step, which is where --continue-on-error re-anchors', () => {
    expect(nextAnchor(steps, 1)).toBe(3);
    expect(nextAnchor(steps, 4)).toBe(-1);
  });

  it('treats the step it starts on as a candidate', () => {
    expect(nextAnchor(steps, 3)).toBe(3);
    expect(nextAnchor(steps, 0)).toBe(0);
  });
});
