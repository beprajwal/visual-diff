import { describe, expect, it } from 'vitest';

import type { ShotResult, Step, StepResult, ViewportId } from '../types.js';
import { mergeStep, statusOf } from './run.js';
import type { StepOutcome } from './replay.js';

function outcome(overrides: Partial<StepOutcome> & { id: string }): StepOutcome {
  return {
    index: 0,
    status: 'ok',
    shoot: true,
    startedAt: '2026-08-08T10:00:00.000Z',
    finishedAt: '2026-08-08T10:00:01.000Z',
    durationMs: 1_000,
    console: [],
    network: [],
    harMisses: 0,
    ...overrides,
  };
}

function shot(viewport: ViewportId, overrides: Partial<ShotResult> = {}): ShotResult {
  return {
    viewport,
    screenshot: `steps/cart/${viewport}/screenshot.png`,
    dom: `steps/cart/${viewport}/dom.json`,
    a11y: `steps/cart/${viewport}/a11y.json`,
    width: 1280,
    height: 2400,
    nodeCount: 12,
    truncated: false,
    ...overrides,
  };
}

const step: Step = { id: 'cart', goto: '/cart', waitFor: '[data-test=cart-list]' };

describe('mergeStep', () => {
  it('folds every viewport into the one step.json the store holds', () => {
    const merged = mergeStep(
      step,
      0,
      [
        { viewport: '1280x800', outcome: outcome({ id: 'cart' }) },
        {
          viewport: '390x844',
          outcome: outcome({
            id: 'cart',
            durationMs: 2_500,
            console: [
              { step: 'cart', viewport: '390x844', level: 'error', text: 'boom', ts: '2026-08-08T10:00:00Z' },
            ],
            network: [
              {
                step: 'cart',
                viewport: '390x844',
                method: 'GET',
                url: 'http://localhost:5173/api/cart',
                status: null,
                resourceType: 'fetch',
                harMatch: 'miss',
                durationMs: 5,
              },
            ],
            harMisses: 1,
          }),
        },
      ],
      { '1280x800': shot('1280x800'), '390x844': shot('390x844', { truncated: true }) },
    );

    expect(merged).toMatchObject({
      id: 'cart',
      index: 0,
      status: 'ok',
      shoot: true,
      durationMs: 2_500,
      truncated: true,
      consoleErrors: 1,
      networkRequests: 1,
      harMisses: 1,
      resolvedSelector: '[data-test=cart-list]',
    });
    expect(Object.keys(merged.viewports)).toEqual(['1280x800', '390x844']);
  });

  it('is failed when any viewport failed, and carries that failure', () => {
    const merged = mergeStep(
      step,
      1,
      [
        { viewport: '1280x800', outcome: outcome({ id: 'cart' }) },
        {
          viewport: '390x844',
          outcome: outcome({ id: 'cart', status: 'failed', failure: { message: 'selector not found' } }),
        },
      ],
      {},
    );
    expect(merged.status).toBe('failed');
    expect(merged.failure).toEqual({ message: 'selector not found' });
  });

  it('is blocked when a viewport was blocked and none failed', () => {
    const merged = mergeStep(
      step,
      2,
      [{ viewport: '1280x800', outcome: outcome({ id: 'cart', status: 'blocked' }) }],
      {},
    );
    expect(merged.status).toBe('blocked');
  });

  it('is skipped when no viewport reached the step at all', () => {
    const merged = mergeStep(step, 3, [{ viewport: '1280x800', outcome: undefined }], {});
    expect(merged.status).toBe('skipped');
    expect(merged.viewports).toEqual({});
  });
});

describe('statusOf', () => {
  const base: StepResult = {
    id: 'cart',
    index: 0,
    status: 'ok',
    shoot: true,
    startedAt: '2026-08-08T10:00:00Z',
    finishedAt: '2026-08-08T10:00:01Z',
    durationMs: 1,
    viewports: {},
    truncated: false,
    consoleErrors: 0,
    networkRequests: 0,
    harMisses: 0,
  };

  it('is ok when every step replayed', () => {
    expect(statusOf([base, { ...base, id: 'pay' }])).toBe('ok');
  });

  it('is partial when a step failed — the evidence survives the failure (spec §7)', () => {
    expect(statusOf([base, { ...base, id: 'pay', status: 'failed' }])).toBe('partial');
    expect(statusOf([base, { ...base, id: 'pay', status: 'blocked' }])).toBe('partial');
  });
});
