import { describe, expect, it } from 'vitest';

import type { FlowDiffEntry, RunCompletedEvent, RunSummary } from '../../types.js';
import {
  type Action,
  type AppState,
  defaultPair,
  initialState,
  isAdjacentPair,
  navigableSteps,
  newestRunId,
  reduce,
  routeOf,
} from './state.js';
import { makeDiff, makeFinding, makeRun, makeStepDiff, makeViewportDiff } from './test-fixtures.js';

const RUNS: RunSummary[] = ['0001', '0002', '0003'].map((id) => makeRun(id));

function apply(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reduce, state);
}

function loaded(): AppState {
  return apply(
    initialState(),
    { type: 'flows-loaded', flows: [{ name: 'checkout', runs: 3, latest: '0003' }] },
    { type: 'runs-loaded', flow: 'checkout', runs: RUNS },
  );
}

function runEvent(runId: string): RunCompletedEvent {
  return {
    type: 'run',
    ts: '2026-08-08T11:00:00Z',
    flow: 'checkout',
    run: makeRun(runId),
  };
}

/* ------------------------------------------------------------------ bootstrap */

describe('bootstrap', () => {
  it('picks the first flow when the route names none', () => {
    const state = reduce(initialState(), {
      type: 'flows-loaded',
      flows: [
        { name: 'checkout', runs: 3, latest: '0003' },
        { name: 'signup', runs: 1, latest: '0001' },
      ],
    });
    expect(state.flow).toBe('checkout');
  });

  it('keeps the flow the route named', () => {
    const state = reduce(initialState({ flow: 'signup' }), {
      type: 'flows-loaded',
      flows: [
        { name: 'checkout', runs: 3, latest: '0003' },
        { name: 'signup', runs: 1, latest: '0001' },
      ],
    });
    expect(state.flow).toBe('signup');
  });

  it('defaults the pair to N-1 vs N and marks it as following', () => {
    const state = loaded();
    expect(state.base).toBe('0002');
    expect(state.head).toBe('0003');
    expect(state.following).toBe(true);
    expect(state.diffStale).toBe(true);
  });

  it('honours a pair named by the URL and treats an older head as pinned', () => {
    const state = apply(initialState({ flow: 'checkout', base: '0001', head: '0002' }), {
      type: 'runs-loaded',
      flow: 'checkout',
      runs: RUNS,
    });
    expect(state.runs).toHaveLength(3);
    expect(state.base).toBe('0001');
    expect(state.head).toBe('0002');
    expect(state.following).toBe(false);
  });

  it('treats a URL naming the newest run as following', () => {
    const state = apply(initialState({ flow: 'checkout', base: '0001', head: '0003' }), {
      type: 'runs-loaded',
      flow: 'checkout',
      runs: RUNS,
    });
    expect(state.following).toBe(true);
  });

  it('falls back to the default pair when the URL names a run that no longer exists', () => {
    const state = apply(initialState({ flow: 'checkout', base: '0001', head: '9999' }), {
      type: 'runs-loaded',
      flow: 'checkout',
      runs: RUNS,
    });
    expect(state.base).toBe('0002');
    expect(state.head).toBe('0003');
    expect(state.following).toBe(true);
  });

  it('handles a flow with no runs at all', () => {
    const state = apply(initialState(), { type: 'runs-loaded', flow: 'checkout', runs: [] });
    expect(state.base).toBeNull();
    expect(state.head).toBeNull();
    expect(state.diffStale).toBe(false);
  });

  it('ignores a runs payload for a flow the reviewer has since left', () => {
    const state = apply(
      { ...loaded(), flow: 'signup' },
      { type: 'runs-loaded', flow: 'checkout', runs: RUNS },
    );
    expect(state.flow).toBe('signup');
  });

  it('resets the pair when the flow changes', () => {
    const state = apply(loaded(), { type: 'select-flow', flow: 'signup' });
    expect(state.flow).toBe('signup');
    expect(state.runs).toEqual([]);
    expect(state.base).toBeNull();
    expect(state.head).toBeNull();
    expect(state.diff).toBeNull();
  });
});

/* ------------------------------------------------------------------ live channel: follow vs pin */

describe('live channel', () => {
  it('follows to the new run when the reviewer is on the newest head', () => {
    const state = apply(loaded(), { type: 'server-event', event: runEvent('0004') });
    expect(state.head).toBe('0004');
    expect(state.base).toBe('0003');
    expect(state.following).toBe(true);
    expect(state.pendingRun).toBeNull();
    expect(state.diffStale).toBe(true);
    expect(state.runs.map((r) => r.runId)).toEqual(['0001', '0002', '0003', '0004']);
  });

  it('keeps a deliberately chosen base when following to a new head', () => {
    // Reviewer is comparing 0001 against the newest run, not the adjacent pair.
    const pinnedBase = apply(loaded(), { type: 'select-base', base: '0001' });
    expect(pinnedBase.following).toBe(true);

    const state = apply(pinnedBase, { type: 'server-event', event: runEvent('0004') });
    expect(state.head).toBe('0004');
    expect(state.base).toBe('0001');
  });

  it('shows a badge instead of yanking a reviewer who pinned an older pair', () => {
    const pinned = apply(
      loaded(),
      { type: 'select-pair', base: '0001', head: '0002' },
      { type: 'diff-loaded', diff: makeDiff({ pair: { base: '0001', head: '0002' } }) },
    );
    expect(pinned.following).toBe(false);
    expect(pinned.diffStale).toBe(false);

    const state = apply(pinned, { type: 'server-event', event: runEvent('0004') });
    expect(state.head).toBe('0002');
    expect(state.base).toBe('0001');
    expect(state.pendingRun?.runId).toBe('0004');
    // The pinned pair is not re-fetched, so the reviewer's view does not flicker or move.
    expect(state.diffStale).toBe(false);
    // The run still enters the timeline so the picker can offer it.
    expect(state.runs.map((r) => r.runId)).toEqual(['0001', '0002', '0003', '0004']);
  });

  it('jumps to the pending run only when the reviewer asks', () => {
    const pinned = apply(
      loaded(),
      { type: 'select-pair', base: '0001', head: '0002' },
      { type: 'server-event', event: runEvent('0004') },
      { type: 'jump-to-pending' },
    );
    expect(pinned.head).toBe('0004');
    expect(pinned.base).toBe('0003');
    expect(pinned.following).toBe(true);
    expect(pinned.pendingRun).toBeNull();
    expect(pinned.diffStale).toBe(true);
  });

  it('ignores a run event for another flow', () => {
    const state = apply(loaded(), {
      type: 'server-event',
      event: { ...runEvent('0004'), flow: 'signup' },
    });
    expect(state.head).toBe('0003');
    expect(state.runs).toHaveLength(3);
    expect(state.pendingRun).toBeNull();
  });

  it('replaces rather than duplicates a run that is announced twice', () => {
    const once = apply(loaded(), { type: 'server-event', event: runEvent('0004') });
    const twice = apply(once, { type: 'server-event', event: runEvent('0004') });
    expect(twice.runs.map((r) => r.runId)).toEqual(['0001', '0002', '0003', '0004']);
  });

  it('re-fetches when a diff event names the pair on screen, and ignores other pairs', () => {
    const settled = apply(loaded(), {
      type: 'diff-loaded',
      diff: makeDiff({ pair: { base: '0002', head: '0003' } }),
    });
    expect(settled.diffStale).toBe(false);

    const summary = makeDiff({}).summary;
    const matching = apply(settled, {
      type: 'server-event',
      event: { type: 'diff', ts: 'now', flow: 'checkout', pair: '0002..0003', summary },
    });
    expect(matching.diffStale).toBe(true);

    const other = apply(settled, {
      type: 'server-event',
      event: { type: 'diff', ts: 'now', flow: 'checkout', pair: '0001..0002', summary },
    });
    expect(other.diffStale).toBe(false);
  });

  it('records connection state from hello and from the transport', () => {
    const hello = apply(initialState(), {
      type: 'server-event',
      event: { type: 'hello', ts: 'now', flows: ['checkout'] },
    });
    expect(hello.connected).toBe(true);
    expect(hello.flow).toBe('checkout');
    expect(hello.flows.map((f) => f.name)).toEqual(['checkout']);

    expect(reduce(hello, { type: 'connection', connected: false }).connected).toBe(false);
  });

  it('surfaces a server error event', () => {
    const state = apply(loaded(), {
      type: 'server-event',
      event: { type: 'error', ts: 'now', message: 'watcher died' },
    });
    expect(state.error).toBe('watcher died');
  });
});

/* ------------------------------------------------------------------ iteration navigation */

describe('iteration navigation', () => {
  it('moves the head one run older and brings the base with it', () => {
    const state = apply(loaded(), { type: 'run-older' });
    expect(state.head).toBe('0002');
    expect(state.base).toBe('0001');
    expect(state.following).toBe(false);
  });

  it('moves back to the newest run and resumes following', () => {
    const state = apply(loaded(), { type: 'run-older' }, { type: 'run-newer' });
    expect(state.head).toBe('0003');
    expect(state.base).toBe('0002');
    expect(state.following).toBe(true);
  });

  it('stops at the ends instead of wrapping', () => {
    const oldest = apply(loaded(), { type: 'run-older' }, { type: 'run-older' });
    expect(oldest.head).toBe('0001');
    expect(oldest.base).toBe('0001');
    const past = apply(oldest, { type: 'run-older' });
    expect(past.head).toBe('0001');

    const newest = apply(loaded(), { type: 'run-newer' });
    expect(newest.head).toBe('0003');
  });

  it('clears the pending badge once the reviewer reaches the newest run', () => {
    const pinned = apply(
      loaded(),
      { type: 'select-pair', base: '0001', head: '0002' },
      { type: 'server-event', event: runEvent('0004') },
    );
    expect(pinned.pendingRun?.runId).toBe('0004');

    const caught = apply(pinned, { type: 'select-pair', base: '0003', head: '0004' });
    expect(caught.following).toBe(true);
    expect(caught.pendingRun).toBeNull();
  });
});

/* ------------------------------------------------------------------ step navigation */

function entry(id: string, i: number, status: FlowDiffEntry['status'] = 'matched'): FlowDiffEntry {
  return { id, status, baseIndex: i, headIndex: i };
}

const DIFF = makeDiff({
  flowDiff: [entry('cart', 0), entry('pay-form', 1), entry('receipt', 2)],
  steps: [
    makeStepDiff('cart', 'matched', {
      viewports: { '1280x800': makeViewportDiff('1280x800') },
    }),
    makeStepDiff('pay-form', 'matched', {
      viewports: {
        '1280x800': makeViewportDiff('1280x800', {
          pixelChangedRatio: 0.02,
          findings: [makeFinding('f1')],
        }),
      },
    }),
    makeStepDiff('receipt', 'matched', {
      viewports: { '1280x800': makeViewportDiff('1280x800') },
    }),
  ],
});

describe('step navigation', () => {
  const withDiff = apply(loaded(), { type: 'diff-loaded', diff: DIFF });

  it('selects the first step and a viewport when a diff loads', () => {
    expect(withDiff.step).toBe('cart');
    expect(withDiff.viewport).toBe('1280x800');
    expect(withDiff.diffStale).toBe(false);
    expect(withDiff.loadingDiff).toBe(false);
  });

  it('walks forward and backward without wrapping', () => {
    const next = apply(withDiff, { type: 'step-next' });
    expect(next.step).toBe('pay-form');
    expect(apply(next, { type: 'step-next' }).step).toBe('receipt');
    expect(apply(next, { type: 'step-next' }, { type: 'step-next' }).step).toBe('receipt');
    expect(apply(next, { type: 'step-prev' }).step).toBe('cart');
    expect(apply(withDiff, { type: 'step-prev' }).step).toBe('cart');
  });

  it('clears the selected finding when the step changes', () => {
    const selected = apply(withDiff, { type: 'select-finding', findingId: 'f1' });
    expect(apply(selected, { type: 'step-next' }).selectedFinding).toBeNull();
    expect(apply(selected, { type: 'select-step', step: 'receipt' }).selectedFinding).toBeNull();
  });

  it('navigates only findings-bearing steps once the filter is on', () => {
    const filtered = apply(withDiff, { type: 'toggle-findings-only' });
    expect(filtered.findingsOnly).toBe(true);
    expect(navigableSteps(filtered)).toEqual(['pay-form']);
    // The selection moved off the now-hidden 'cart'.
    expect(filtered.step).toBe('pay-form');
    expect(apply(filtered, { type: 'toggle-findings-only' }).findingsOnly).toBe(false);
  });

  it('keeps the selected step when it survives the filter', () => {
    const onPay = apply(withDiff, { type: 'select-step', step: 'pay-form' });
    expect(apply(onPay, { type: 'toggle-findings-only' }).step).toBe('pay-form');
  });

  it('keeps a still-valid step across a diff reload and falls back when it vanishes', () => {
    const onReceipt = apply(withDiff, { type: 'select-step', step: 'receipt' });
    const reloaded = apply(onReceipt, { type: 'diff-loaded', diff: DIFF });
    expect(reloaded.step).toBe('receipt');

    const shrunk = makeDiff({
      flowDiff: [entry('cart', 0)],
      steps: [
        makeStepDiff('cart', 'matched', {
          viewports: { '1280x800': makeViewportDiff('1280x800') },
        }),
      ],
    });
    expect(apply(onReceipt, { type: 'diff-loaded', diff: shrunk }).step).toBe('cart');
  });

  it('does nothing when there is no diff yet', () => {
    const empty = loaded();
    expect(apply(empty, { type: 'step-next' }).step).toBeNull();
    expect(navigableSteps(empty)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ view modes and feedback */

describe('view modes', () => {
  it('toggles overlay on and back to side-by-side', () => {
    const overlay = apply(initialState(), { type: 'toggle-overlay' });
    expect(overlay.view).toBe('overlay');
    expect(apply(overlay, { type: 'toggle-overlay' }).view).toBe('side-by-side');
  });

  it('returns to side-by-side when overlay is toggled off from swipe', () => {
    const swipe = apply(initialState(), { type: 'set-view', view: 'swipe' });
    expect(apply(swipe, { type: 'toggle-overlay' }).view).toBe('overlay');
  });

  it('clamps the onion-skin and swipe positions to 0..1', () => {
    const s = apply(
      initialState(),
      { type: 'set-overlay-opacity', value: 1.8 },
      { type: 'set-swipe', value: -0.3 },
    );
    expect(s.overlayOpacity).toBe(1);
    expect(s.swipeAt).toBe(0);
  });
});

describe('feedback', () => {
  const target = { step: 'pay-form', viewport: '1280x800', findingId: 'f1', label: 'f1' };

  it('opens, saves and records an entry', () => {
    const open = apply(loaded(), { type: 'open-feedback', target });
    expect(open.feedback?.findingId).toBe('f1');

    const saving = apply(open, { type: 'feedback-saving' });
    expect(saving.feedbackSaving).toBe(true);

    const saved = apply(saving, {
      type: 'feedback-saved',
      entry: {
        id: 'fb_01',
        ts: 'now',
        flow: 'checkout',
        pair: '0002..0003',
        text: 'too tight',
        status: 'pending',
      },
    });
    expect(saved.feedback).toBeNull();
    expect(saved.feedbackSaving).toBe(false);
    expect(saved.recentFeedback.map((e) => e.id)).toEqual(['fb_01']);
  });

  it('keeps the box open and surfaces the message when the POST fails', () => {
    const failed = apply(
      loaded(),
      { type: 'open-feedback', target },
      { type: 'feedback-saving' },
      { type: 'feedback-failed', message: 'network down' },
    );
    expect(failed.feedback).not.toBeNull();
    expect(failed.feedbackSaving).toBe(false);
    expect(failed.error).toBe('network down');
  });

  it('deduplicates a feedback entry echoed back over SSE', () => {
    const entry1 = {
      id: 'fb_01',
      ts: 'now',
      flow: 'checkout',
      pair: '0002..0003',
      text: 'too tight',
      status: 'pending' as const,
    };
    const state = apply(
      loaded(),
      { type: 'feedback-saved', entry: entry1 },
      { type: 'server-event', event: { type: 'feedback', ts: 'now', entry: entry1 } },
    );
    expect(state.recentFeedback).toHaveLength(1);
  });
});

describe('dismiss', () => {
  it('closes the comment box first, then the finding selection, then the error', () => {
    const base = apply(loaded(), { type: 'diff-loaded', diff: DIFF });
    const noisy = apply(
      base,
      { type: 'select-finding', findingId: 'f1' },
      { type: 'open-feedback', target: { label: 'f1', findingId: 'f1' } },
      { type: 'error', message: 'boom' },
    );

    const a = apply(noisy, { type: 'dismiss' });
    expect(a.feedback).toBeNull();
    expect(a.selectedFinding).toBe('f1');

    const b = apply(a, { type: 'dismiss' });
    expect(b.selectedFinding).toBeNull();
    expect(b.error).toBe('boom');

    const c = apply(b, { type: 'dismiss' });
    expect(c.error).toBeNull();
    expect(apply(c, { type: 'dismiss' })).toBe(c);
  });
});

/* ------------------------------------------------------------------ pruned pairs and helpers */

describe('pruned pairs', () => {
  it('replaces the diff with the backfill instructions rather than an error', () => {
    const state = apply(loaded(), {
      type: 'diff-backfill',
      backfill: {
        error: 'pruned',
        message: 'run 0001 was pruned',
        backfill: ['vdiff run checkout --at 9f8e7d6'],
      },
    });
    expect(state.diff).toBeNull();
    expect(state.backfill?.backfill).toEqual(['vdiff run checkout --at 9f8e7d6']);
    expect(state.diffStale).toBe(false);
  });

  it('clears the backfill notice once a new pair is chosen', () => {
    const state = apply(
      loaded(),
      {
        type: 'diff-backfill',
        backfill: { error: 'pruned', message: 'gone', backfill: [] },
      },
      { type: 'select-pair', base: '0002', head: '0003' },
    );
    expect(state.backfill).toBeNull();
  });
});

describe('helpers', () => {
  it('reports the newest run id', () => {
    expect(newestRunId(RUNS)).toBe('0003');
    expect(newestRunId([])).toBeNull();
  });

  it('detects adjacency', () => {
    expect(isAdjacentPair(RUNS, '0002', '0003')).toBe(true);
    expect(isAdjacentPair(RUNS, '0001', '0003')).toBe(false);
    expect(isAdjacentPair(RUNS, null, '0003')).toBe(false);
  });

  it('computes the default pair, collapsing to a single run when only one exists', () => {
    expect(defaultPair(RUNS)).toEqual({ base: '0002', head: '0003' });
    expect(defaultPair([makeRun('0001')])).toEqual({ base: '0001', head: '0001' });
    expect(defaultPair([])).toBeNull();
  });

  it('projects the current position onto a route', () => {
    const state = apply(loaded(), { type: 'diff-loaded', diff: DIFF });
    expect(routeOf(state)).toEqual({
      flow: 'checkout',
      base: '0002',
      head: '0003',
      step: 'cart',
      viewport: '1280x800',
      view: 'side-by-side',
      findingsOnly: false,
    });
  });
});
