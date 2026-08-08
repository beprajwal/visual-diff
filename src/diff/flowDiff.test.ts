import { describe, expect, it } from 'vitest';
import type { FlowSnapshot, Step, StepId, StepResult } from '../types.js';
import { describeStepChanges, isComparable, structuralFlowDiff } from './flowDiff.js';

function flow(steps: Step[]): FlowSnapshot {
  return {
    version: 1,
    flow: 'checkout',
    viewports: ['1280x800'],
    network: { mode: 'replay', har: 'checkout.har' },
    steps,
  };
}

function results(entries: Array<[StepId, StepResult['status'], string?]>): Record<StepId, StepResult> {
  return Object.fromEntries(
    entries.map(([id, status, message], index) => [
      id,
      {
        id,
        index,
        status,
        shoot: true,
        startedAt: '2026-08-08T10:00:00.000Z',
        finishedAt: '2026-08-08T10:00:00.000Z',
        durationMs: 1,
        viewports: {},
        truncated: false,
        consoleErrors: 0,
        networkRequests: 0,
        harMisses: 0,
        ...(message === undefined ? {} : { failure: { message } }),
      } satisfies StepResult,
    ]),
  );
}

describe('structuralFlowDiff', () => {
  it('aligns by id, not by index, when a step is inserted', () => {
    const base = flow([{ id: 'cart', goto: '/cart' }, { id: 'pay', click: '#pay' }]);
    const head = flow([
      { id: 'cart', goto: '/cart' },
      { id: 'promo', click: '#promo' },
      { id: 'pay', click: '#pay' },
    ]);

    const entries = structuralFlowDiff({ base, head });

    expect(entries.map((e) => [e.id, e.status])).toEqual([
      ['cart', 'matched'],
      ['promo', 'added'],
      ['pay', 'matched'],
    ]);
    // Index drift alone is never spec drift: an insertion must not mark every later step changed.
    expect(entries.find((e) => e.id === 'pay')).toMatchObject({ baseIndex: 1, headIndex: 2 });
  });

  it('emits a removed step at the position it disappeared from', () => {
    const base = flow([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const head = flow([{ id: 'a' }, { id: 'c' }, { id: 'd' }]);

    expect(structuralFlowDiff({ base, head }).map((e) => [e.id, e.status])).toEqual([
      ['a', 'matched'],
      ['b', 'removed'],
      ['c', 'matched'],
      ['d', 'added'],
    ]);
  });

  it('reports selector drift as spec-changed with a readable detail', () => {
    const base = flow([{ id: 'pay', click: '#pay' }]);
    const head = flow([{ id: 'pay', click: '[data-test=pay]' }]);

    const [entry] = structuralFlowDiff({ base, head });

    expect(entry?.status).toBe('spec-changed');
    expect(entry?.detail).toBe("selector '#pay' -> '[data-test=pay]'");
  });

  it('describes added, removed and toggled step keys', () => {
    const base: Step = { id: 'pay', click: '#pay', shoot: true };
    const head: Step = { id: 'pay', click: '#pay', waitFor: 'text=Payment', shoot: false };

    expect(describeStepChanges(base, head)).toEqual([
      "added waitFor 'text=Payment'",
      'shoot true -> false',
    ]);
  });

  it('reports fill changes per field', () => {
    const base: Step = { id: 'f', fill: { '[name=card]': '4242', '[name=cvc]': '123' } };
    const head: Step = { id: 'f', fill: { '[name=card]': '1111', '[name=zip]': '90210' } };

    expect(describeStepChanges(base, head)).toEqual([
      "fill '[name=card]' changed",
      "removed fill '[name=cvc]'",
      "added fill '[name=zip]'",
    ]);
  });

  it('lets a failure outrank spec drift but keeps the drift in the detail', () => {
    const base = flow([{ id: 'pay', click: '#pay' }]);
    const head = flow([{ id: 'pay', click: '[data-test=pay]' }]);

    const [entry] = structuralFlowDiff({
      base,
      head,
      headSteps: results([['pay', 'failed', 'selector not found']]),
    });

    expect(entry?.status).toBe('failed');
    expect(entry?.detail).toBe(
      "failed in head: selector not found; selector '#pay' -> '[data-test=pay]'",
    );
  });

  it('buckets blocked steps and excludes them from comparison', () => {
    const base = flow([{ id: 'pay' }]);
    const head = flow([{ id: 'pay' }]);

    const [entry] = structuralFlowDiff({
      base,
      head,
      headSteps: results([['pay', 'blocked']]),
    });

    expect(entry?.status).toBe('blocked');
    expect(isComparable('blocked')).toBe(false);
    expect(isComparable('matched')).toBe(true);
    expect(isComparable('spec-changed')).toBe(true);
  });

  it('puts every step in exactly one bucket', () => {
    const base = flow([{ id: 'a' }, { id: 'b', click: '#x' }, { id: 'c' }]);
    const head = flow([{ id: 'a' }, { id: 'b', click: '#y' }, { id: 'd' }]);

    const entries = structuralFlowDiff({ base, head });
    const ids = entries.map((e) => e.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});
