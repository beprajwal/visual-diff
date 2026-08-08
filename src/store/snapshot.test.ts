import { describe, expect, it } from 'vitest';

import { StoreError } from './errors.js';
import { parseFlowSnapshot, serializeFlowSnapshot } from './snapshot.js';
import type { FlowSnapshot } from '../types.js';

const CHECKOUT: FlowSnapshot = {
  version: 1,
  flow: 'checkout',
  baseUrl: 'http://localhost:5173',
  viewports: ['1280x800', '390x844'],
  network: { mode: 'replay', har: 'checkout.har' },
  steps: [
    { id: 'cart', goto: '/cart', waitFor: '[data-test=cart-list]', mask: ['[data-test=order-date]'], shoot: true },
    { id: 'pay-form', click: '[data-test=pay]', waitFor: 'text=Payment', shoot: true },
    { id: 'fill-card', fill: { '[name=card]': '4242424242424242' }, shoot: false },
  ],
};

describe('serializeFlowSnapshot', () => {
  it('round-trips the spec §6 example', () => {
    expect(parseFlowSnapshot(serializeFlowSnapshot(CHECKOUT))).toEqual(CHECKOUT);
  });

  it('is byte-stable regardless of key insertion order', () => {
    const shuffled = {
      steps: CHECKOUT.steps.map((step) => ({ ...step })),
      network: CHECKOUT.network,
      viewports: CHECKOUT.viewports,
      baseUrl: CHECKOUT.baseUrl,
      flow: CHECKOUT.flow,
      version: 1,
    } as FlowSnapshot;
    expect(serializeFlowSnapshot(shuffled)).toBe(serializeFlowSnapshot(CHECKOUT));
  });

  it('puts id first in every step, so the file reads as an ordered list of ids', () => {
    const yaml = serializeFlowSnapshot(CHECKOUT);
    const ids = [...yaml.matchAll(/^\s*- id: (.+)$/gm)].map((match) => match[1]);
    expect(ids).toEqual(['cart', 'pay-form', 'fill-card']);
  });

  it('preserves ordering, which is the only place ordering lives', () => {
    const yaml = serializeFlowSnapshot(CHECKOUT);
    expect(yaml.indexOf('cart')).toBeLessThan(yaml.indexOf('pay-form'));
    expect(yaml.indexOf('pay-form')).toBeLessThan(yaml.indexOf('fill-card'));
  });
});

describe('parseFlowSnapshot', () => {
  it('reads a hand-written fixture that omits the optional sections', () => {
    const parsed = parseFlowSnapshot('flow: mini\nsteps:\n  - id: only\n');
    expect(parsed.flow).toBe('mini');
    expect(parsed.steps).toEqual([{ id: 'only' }]);
    expect(parsed.viewports).toEqual([]);
    expect(parsed.network).toEqual({ mode: 'off' });
  });

  it('refuses a snapshot with no steps or no flow name', () => {
    expect(() => parseFlowSnapshot('flow: mini\n')).toThrow(StoreError);
    expect(() => parseFlowSnapshot('steps: []\n')).toThrow(/missing "flow"/);
  });

  it('refuses a step with no id, because D4 alignment is by id', () => {
    expect(() => parseFlowSnapshot('flow: mini\nsteps:\n  - goto: /\n')).toThrow(/steps\[0\]/);
  });

  it('reports unparsable YAML as a store error rather than throwing YAML internals', () => {
    expect(() => parseFlowSnapshot('flow: [unclosed\n')).toThrow(StoreError);
  });
});
