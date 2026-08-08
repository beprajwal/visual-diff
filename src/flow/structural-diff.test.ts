import { describe, expect, it } from 'vitest';
import type { FlowSnapshot, FlowSpec, Step, StepId, StepResult } from '../types.js';
import { parseFlowSource } from './parse.js';
import {
  describeFillChanges,
  describeStepChanges,
  diffFlows,
  flowLevelChanges,
  formatStepChanges,
  isComparable,
  stepSpecChanges,
  structuralFlowDiff,
} from './structural-diff.js';

function flow(steps: Step[], patch: Partial<FlowSpec> = {}): FlowSnapshot {
  return {
    version: 1,
    flow: 'checkout',
    viewports: ['1280x800'],
    network: { mode: 'replay', har: 'checkout.har' },
    steps,
    ...patch,
  };
}

function results(
  entries: Array<[StepId, StepResult['status'], string?]>,
): Record<StepId, StepResult> {
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

const buckets = (base: FlowSnapshot, head: FlowSnapshot): Array<[StepId, string]> =>
  structuralFlowDiff({ base, head }).map((entry) => [entry.id, entry.status]);

describe('structuralFlowDiff — alignment (D4)', () => {
  it('aligns by id, not by index, when a step is inserted', () => {
    const base = flow([
      { id: 'cart', goto: '/cart' },
      { id: 'pay', click: '#pay' },
    ]);
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

    expect(buckets(base, head)).toEqual([
      ['a', 'matched'],
      ['b', 'removed'],
      ['c', 'matched'],
      ['d', 'added'],
    ]);
  });

  it('reports a pure reordering as matched, with the positions carried in the indices', () => {
    const base = flow([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const head = flow([{ id: 'c' }, { id: 'a' }, { id: 'b' }]);

    const entries = structuralFlowDiff({ base, head });

    expect(entries.map((e) => [e.id, e.status])).toEqual([
      ['c', 'matched'],
      ['a', 'matched'],
      ['b', 'matched'],
    ]);
    expect(entries.map((e) => [e.baseIndex, e.headIndex])).toEqual([
      [2, 0],
      [0, 1],
      [1, 2],
    ]);
  });

  it('does not let a reordered step drag an unrelated deletion to the front', () => {
    const base = flow([{ id: 'a' }, { id: 'gone' }, { id: 'b' }]);
    const head = flow([{ id: 'b' }, { id: 'a' }]);

    // Head order is preserved; the base-only step is appended rather than emitted before `b`,
    // because flushing stops at `a`, which still exists in head.
    expect(buckets(base, head)).toEqual([
      ['b', 'matched'],
      ['a', 'matched'],
      ['gone', 'removed'],
    ]);
  });

  it('keeps head order while splicing deletions between reordered survivors', () => {
    const base = flow([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    const head = flow([{ id: 'a' }, { id: 'c' }, { id: 'b' }]);

    expect(buckets(base, head)).toEqual([
      ['a', 'matched'],
      ['c', 'matched'],
      ['b', 'matched'],
      ['d', 'removed'],
    ]);
  });

  it('puts every step in exactly one bucket', () => {
    const base = flow([{ id: 'a' }, { id: 'b', click: '#x' }, { id: 'c' }]);
    const head = flow([{ id: 'a' }, { id: 'b', click: '#y' }, { id: 'd' }]);

    const entries = structuralFlowDiff({ base, head });
    const ids = entries.map((e) => e.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('exposes the same function under the module-edge name `diffFlows`', () => {
    expect(diffFlows).toBe(structuralFlowDiff);
  });
});

describe('structuralFlowDiff — edge cases', () => {
  it('returns nothing when both flows are empty', () => {
    expect(structuralFlowDiff({ base: flow([]), head: flow([]) })).toEqual([]);
  });

  it('marks every head step added when the base flow is empty', () => {
    expect(buckets(flow([]), flow([{ id: 'a' }, { id: 'b' }]))).toEqual([
      ['a', 'added'],
      ['b', 'added'],
    ]);
    expect(structuralFlowDiff({ base: flow([]), head: flow([{ id: 'a' }]) })[0]).toEqual({
      id: 'a',
      status: 'added',
      baseIndex: null,
      headIndex: 0,
    });
  });

  it('marks every base step removed when the head flow is empty', () => {
    expect(buckets(flow([{ id: 'a' }, { id: 'b' }]), flow([]))).toEqual([
      ['a', 'removed'],
      ['b', 'removed'],
    ]);
    expect(structuralFlowDiff({ base: flow([{ id: 'a' }]), head: flow([]) })[0]).toEqual({
      id: 'a',
      status: 'removed',
      baseIndex: 0,
      headIndex: null,
    });
  });

  it('shares no steps: everything is removed then added', () => {
    expect(buckets(flow([{ id: 'a' }, { id: 'b' }]), flow([{ id: 'x' }, { id: 'y' }]))).toEqual([
      ['a', 'removed'],
      ['b', 'removed'],
      ['x', 'added'],
      ['y', 'added'],
    ]);
  });

  it('degrades instead of throwing when a snapshot read off disk has no step list', () => {
    const truncated = { ...flow([]), steps: undefined } as unknown as FlowSnapshot;

    expect(buckets(truncated, flow([{ id: 'a' }]))).toEqual([['a', 'added']]);
    expect(buckets(flow([{ id: 'a' }]), truncated)).toEqual([['a', 'removed']]);
  });
});

describe('structuralFlowDiff — duplicate ids', () => {
  it('is protected upstream: validation rejects duplicate step ids', () => {
    const result = parseFlowSource(
      [
        'version: 1',
        'flow: checkout',
        'viewports: [1280x800]',
        'network: { mode: off }',
        'steps:',
        '  - id: pay',
        '    click: "#pay"',
        '  - id: pay',
        '    click: "#pay2"',
      ].join('\n'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('duplicate-id');
  });

  it('still emits one bucket per id if a hand-edited snapshot smuggles a duplicate through', () => {
    const base = flow([{ id: 'pay', click: '#pay' }, { id: 'pay', click: '#other' }, { id: 'z' }]);
    const head = flow([{ id: 'pay', click: '#pay' }, { id: 'pay', click: '#other' }]);

    const entries = structuralFlowDiff({ base, head });

    // First occurrence wins on both sides, so the pair compares equal rather than reporting drift.
    expect(entries.map((e) => [e.id, e.status])).toEqual([
      ['pay', 'matched'],
      ['z', 'removed'],
    ]);
    expect(entries[0]).toMatchObject({ baseIndex: 0, headIndex: 0 });
  });
});

describe('spec-changed detail strings', () => {
  it('renders selector drift the way spec §8 shows it', () => {
    const base = flow([{ id: 'pay', click: '#pay' }]);
    const head = flow([{ id: 'pay', click: '[data-test=pay]' }]);

    const [entry] = structuralFlowDiff({ base, head });

    expect(entry?.status).toBe('spec-changed');
    expect(entry?.detail).toBe("selector '#pay' -> '[data-test=pay]'");
  });

  it('describes added, removed and toggled step verbs', () => {
    const base: Step = { id: 'pay', click: '#pay', shoot: true };
    const head: Step = { id: 'pay', click: '#pay', waitFor: 'text=Payment', shoot: false };

    expect(describeStepChanges(base, head)).toEqual([
      "added waitFor 'text=Payment'",
      'shoot true -> false',
    ]);
    expect(describeStepChanges(head, base)).toEqual([
      "removed waitFor 'text=Payment'",
      'shoot false -> true',
    ]);
  });

  it('names the verb instead of "selector" when two selector verbs move at once', () => {
    const base: Step = { id: 'pay', click: '#pay', hover: '#row' };
    const head: Step = { id: 'pay', click: '#buy', hover: '#card' };

    expect(describeStepChanges(base, head)).toEqual([
      "click '#pay' -> '#buy'",
      "hover '#row' -> '#card'",
    ]);
  });

  it('keeps saying "selector" when only one selector verb moved, even alongside an addition', () => {
    const base: Step = { id: 'pay', click: '#pay' };
    const head: Step = { id: 'pay', click: '#buy', hover: '#card' };

    // `added hover '#card'` names its own verb, so it never makes `selector` ambiguous.
    expect(describeStepChanges(base, head)).toEqual([
      "selector '#pay' -> '#buy'",
      "added hover '#card'",
    ]);
  });

  it('renders scalar verbs with both values and structured verbs as "<verb> changed"', () => {
    expect(describeStepChanges({ id: 's', goto: '/cart' }, { id: 's', goto: '/checkout' })).toEqual([
      "goto '/cart' -> '/checkout'",
    ]);
    expect(
      describeStepChanges({ id: 's', viewport: '1280x800' }, { id: 's', viewport: '390x844' }),
    ).toEqual(["viewport '1280x800' -> '390x844'"]);
    expect(describeStepChanges({ id: 's', mask: ['#a'] }, { id: 's', mask: ['#a', '#b'] })).toEqual([
      'mask changed',
    ]);
    expect(
      describeStepChanges(
        { id: 's', expect: [{ selector: '#total', text: '10' }] },
        { id: 's', expect: [{ selector: '#total', text: '12' }] },
      ),
    ).toEqual(['expect changed']);
    expect(
      describeStepChanges({ id: 's', scroll: { y: 0 } }, { id: 's', scroll: { y: 400 } }),
    ).toEqual(['scroll changed']);
  });

  it('joins several changes with "; " into one detail string', () => {
    const base = flow([{ id: 'pay', click: '#pay', goto: '/cart' }]);
    const head = flow([{ id: 'pay', click: '#buy', goto: '/checkout' }]);

    expect(structuralFlowDiff({ base, head })[0]?.detail).toBe(
      "goto '/cart' -> '/checkout'; selector '#pay' -> '#buy'",
    );
  });

  it('orders changes by the closed step vocabulary, not by authored key order', () => {
    const base: Step = { id: 's', shoot: true, goto: '/a', click: '#a' };
    const head: Step = { id: 's', shoot: false, click: '#b', goto: '/b' };

    expect(stepSpecChanges(base, head).map((c) => c.key)).toEqual(['goto', 'click', 'shoot']);
  });

  it('exposes the structured change list behind the strings', () => {
    expect(stepSpecChanges({ id: 's', click: '#a' }, { id: 's', click: '#b', press: 'Enter' })).toEqual([
      { key: 'click', from: '#a', to: '#b' },
      { key: 'press', from: undefined, to: 'Enter' },
    ]);
  });

  it('formats a change list directly', () => {
    expect(formatStepChanges([{ key: 'press', from: 'Enter', to: 'Escape' }])).toEqual([
      "press 'Enter' -> 'Escape'",
    ]);
  });
});

describe('spec-changed — canonicalization', () => {
  it('treats an omitted shoot as shoot: true, like the flow hash does', () => {
    expect(describeStepChanges({ id: 's', click: '#a' }, { id: 's', click: '#a', shoot: true })).toEqual(
      [],
    );
    expect(buckets(flow([{ id: 's' }]), flow([{ id: 's', shoot: true }]))).toEqual([['s', 'matched']]);
  });

  it('ignores key order inside scroll and expect', () => {
    const base: Step = { id: 's', scroll: { y: 10, selector: '#x' }, expect: [{ text: 'A', selector: '#t' }] };
    const head: Step = { id: 's', scroll: { selector: '#x', y: 10 }, expect: [{ selector: '#t', text: 'A' }] };

    expect(describeStepChanges(base, head)).toEqual([]);
  });

  it('still sees a real change inside scroll or expect', () => {
    expect(
      describeStepChanges({ id: 's', scroll: { to: 'top' } }, { id: 's', scroll: { to: 'bottom' } }),
    ).toEqual(['scroll changed']);
  });
});

describe('fill drift', () => {
  it('reports fill changes per field, never printing the values', () => {
    const base: Step = { id: 'f', fill: { '[name=card]': '4242', '[name=cvc]': '123' } };
    const head: Step = { id: 'f', fill: { '[name=card]': '1111', '[name=zip]': '90210' } };

    const lines = describeStepChanges(base, head);

    expect(lines).toEqual([
      "fill '[name=card]' changed",
      "removed fill '[name=cvc]'",
      "added fill '[name=zip]'",
    ]);
    for (const secret of ['4242', '1111', '123', '90210']) {
      expect(lines.join('; ')).not.toContain(secret);
    }
  });

  it('reports a pure reordering of fill fields, because fill order is typing order', () => {
    const base: Step = { id: 'f', fill: { a: '1', b: '2' } };
    const head: Step = { id: 'f', fill: { b: '2', a: '1' } };

    expect(describeStepChanges(base, head)).toEqual(['fill reordered']);
  });

  it('does not call an insertion a reordering', () => {
    expect(describeFillChanges({ a: '1', b: '2' }, { a: '1', c: '3', b: '2' })).toEqual([
      "added fill 'c'",
    ]);
  });

  it('expands a wholly added or removed fill map per field', () => {
    expect(describeStepChanges({ id: 'f' }, { id: 'f', fill: { a: '1' } })).toEqual([
      "added fill 'a'",
    ]);
    expect(describeStepChanges({ id: 'f', fill: { a: '1' } }, { id: 'f' })).toEqual([
      "removed fill 'a'",
    ]);
  });
});

describe('run-outcome buckets', () => {
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

  it('names the failing side and omits the reason when the result carries none', () => {
    const base = flow([{ id: 'pay' }]);
    const head = flow([{ id: 'pay' }]);

    const [entry] = structuralFlowDiff({
      base,
      head,
      baseSteps: results([['pay', 'failed']]),
    });

    expect(entry).toMatchObject({ status: 'failed', detail: 'failed in base' });
  });

  it('buckets blocked and skipped steps as blocked, and excludes them from comparison', () => {
    const base = flow([{ id: 'pay' }]);
    const head = flow([{ id: 'pay' }]);

    expect(
      structuralFlowDiff({ base, head, headSteps: results([['pay', 'blocked']]) })[0],
    ).toMatchObject({ status: 'blocked', detail: 'blocked in head' });
    expect(
      structuralFlowDiff({ base, head, headSteps: results([['pay', 'skipped']]) })[0],
    ).toMatchObject({ status: 'blocked', detail: 'skipped in head' });

    expect(isComparable('blocked')).toBe(false);
    expect(isComparable('failed')).toBe(false);
    expect(isComparable('added')).toBe(false);
    expect(isComparable('removed')).toBe(false);
    expect(isComparable('matched')).toBe(true);
    expect(isComparable('spec-changed')).toBe(true);
  });

  it('prefers a failure over a block when the two sides disagree', () => {
    const base = flow([{ id: 'pay' }]);
    const head = flow([{ id: 'pay' }]);

    const [entry] = structuralFlowDiff({
      base,
      head,
      baseSteps: results([['pay', 'blocked']]),
      headSteps: results([['pay', 'failed', 'boom']]),
    });

    expect(entry).toMatchObject({ status: 'failed', detail: 'failed in head: boom' });
  });

  it('never lets a run outcome override added or removed', () => {
    const base = flow([{ id: 'gone' }]);
    const head = flow([{ id: 'fresh' }]);

    expect(
      structuralFlowDiff({
        base,
        head,
        baseSteps: results([['gone', 'failed', 'boom']]),
        headSteps: results([['fresh', 'blocked']]),
      }).map((e) => [e.id, e.status]),
    ).toEqual([
      ['gone', 'removed'],
      ['fresh', 'added'],
    ]);
  });

  it('ignores results for steps that are in neither snapshot', () => {
    const base = flow([{ id: 'a' }]);
    const head = flow([{ id: 'a' }]);

    expect(
      structuralFlowDiff({ base, head, headSteps: results([['orphan', 'failed', 'boom']]) }).map(
        (e) => e.id,
      ),
    ).toEqual(['a']);
  });
});

describe('flowLevelChanges', () => {
  it('reports nothing for two identical flow headers', () => {
    expect(flowLevelChanges(flow([]), flow([]))).toEqual([]);
  });

  it('reports base URL, viewport matrix and network drift', () => {
    const base = flow([], {
      baseUrl: 'http://localhost:5173',
      viewports: ['1280x800'],
      network: { mode: 'replay', har: 'checkout.har' },
    });
    const head = flow([], {
      baseUrl: 'http://localhost:4000',
      viewports: ['1280x800', '390x844'],
      network: { mode: 'record', har: 'checkout2.har' },
    });

    expect(flowLevelChanges(base, head)).toEqual([
      "baseUrl 'http://localhost:5173' -> 'http://localhost:4000'",
      'viewports ["1280x800"] -> ["1280x800","390x844"]',
      "network.mode 'replay' -> 'record'",
      "network.har 'checkout.har' -> 'checkout2.har'",
    ]);
  });

  it('names an absent value rather than rendering it as undefined', () => {
    const base = flow([], { network: { mode: 'off' } });
    const head = flow([], { baseUrl: 'http://localhost:5173', network: { mode: 'off' } });

    expect(flowLevelChanges(base, head)).toEqual([
      "baseUrl unset -> 'http://localhost:5173'",
    ]);
    expect(flowLevelChanges(head, base)).toEqual([
      "baseUrl 'http://localhost:5173' -> unset",
    ]);
  });
});
