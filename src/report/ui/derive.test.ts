import { describe, expect, it } from 'vitest';

import type { Finding, FlowDiffEntry } from '../../types.js';
import {
  alignFlowDiff,
  buildFilmstrip,
  findingsForStep,
  groupBySeverity,
  runIndex,
  runLabel,
  sortFindings,
  topSeverity,
  viewportsOf,
  visibleCells,
} from './derive.js';
import { makeDiff, makeFinding, makeRun, makeStepDiff, makeViewportDiff } from './test-fixtures.js';

function entry(
  id: string,
  baseIndex: number | null,
  headIndex: number | null,
  status: FlowDiffEntry['status'],
): FlowDiffEntry {
  return { id, status, baseIndex, headIndex };
}

describe('alignFlowDiff', () => {
  it('orders matched steps by head index', () => {
    const aligned = alignFlowDiff([
      entry('c', 2, 2, 'matched'),
      entry('a', 0, 0, 'matched'),
      entry('b', 1, 1, 'matched'),
    ]);
    expect(aligned.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('splices a removed step back into the position it used to occupy', () => {
    // base: a, gone, b   head: a, b
    const aligned = alignFlowDiff([
      entry('a', 0, 0, 'matched'),
      entry('b', 2, 1, 'matched'),
      entry('gone', 1, null, 'removed'),
    ]);
    expect(aligned.map((e) => e.id)).toEqual(['a', 'gone', 'b']);
  });

  it('places a step removed from the front of the flow first', () => {
    const aligned = alignFlowDiff([
      entry('a', 1, 0, 'matched'),
      entry('gone', 0, null, 'removed'),
    ]);
    expect(aligned.map((e) => e.id)).toEqual(['gone', 'a']);
  });

  it('keeps added steps in head order alongside removals', () => {
    // base: a, old, c    head: a, new, c
    // Both the removal and the addition belong between a and c; the removal is placed by its base
    // position, the addition by its head position, and both stay inside the a…c bracket.
    const aligned = alignFlowDiff([
      entry('a', 0, 0, 'matched'),
      entry('new', null, 1, 'added'),
      entry('c', 2, 2, 'matched'),
      entry('old', 1, null, 'removed'),
    ]);
    expect(aligned.map((e) => e.id)).toEqual(['a', 'old', 'new', 'c']);
  });

  it('never drops or duplicates an entry', () => {
    const input = [
      entry('a', 0, 0, 'matched'),
      entry('x', 1, null, 'removed'),
      entry('y', 2, null, 'removed'),
      entry('b', 3, 1, 'matched'),
    ];
    const aligned = alignFlowDiff(input);
    expect(aligned).toHaveLength(input.length);
    expect(new Set(aligned.map((e) => e.id)).size).toBe(input.length);
  });
});

describe('findingsForStep', () => {
  it('includes step-scoped findings alongside the selected viewport', () => {
    const step = makeStepDiff('pay', 'matched', {
      viewports: {
        '1280x800': makeViewportDiff('1280x800', { findings: [makeFinding('f1')] }),
        '390x844': makeViewportDiff('390x844', { findings: [makeFinding('f2')] }),
      },
      findings: [makeFinding('f9', { kind: 'console', viewport: undefined })],
    });
    expect(findingsForStep(step, '1280x800').map((f) => f.id)).toEqual(['f1', 'f9']);
    expect(findingsForStep(step, '390x844').map((f) => f.id)).toEqual(['f2', 'f9']);
  });

  it('collects every viewport when none is selected', () => {
    const step = makeStepDiff('pay', 'matched', {
      viewports: {
        '1280x800': makeViewportDiff('1280x800', { findings: [makeFinding('f1')] }),
        '390x844': makeViewportDiff('390x844', { findings: [makeFinding('f2')] }),
      },
    });
    expect(findingsForStep(step, null).map((f) => f.id).sort()).toEqual(['f1', 'f2']);
  });

  it('returns an empty list for an unknown step', () => {
    expect(findingsForStep(undefined, '1280x800')).toEqual([]);
  });
});

describe('severity helpers', () => {
  const findings: Finding[] = [
    makeFinding('f1', { severity: 'low', kind: 'style' }),
    makeFinding('f2', { severity: 'high', kind: 'a11y' }),
    makeFinding('f3', { severity: 'med', kind: 'content' }),
    makeFinding('f4', { severity: 'high', kind: 'console' }),
  ];

  it('sorts high before med before low', () => {
    expect(sortFindings(findings).map((f) => f.id)).toEqual(['f2', 'f4', 'f3', 'f1']);
  });

  it('groups in high → low order and omits empty severities', () => {
    const groups = groupBySeverity(findings);
    expect(groups.map((g) => g.severity)).toEqual(['high', 'med', 'low']);
    expect(groups[0]?.findings.map((f) => f.id)).toEqual(['f2', 'f4']);

    const onlyLow = groupBySeverity([makeFinding('f5', { severity: 'low' })]);
    expect(onlyLow.map((g) => g.severity)).toEqual(['low']);
  });

  it('never hides a finding while grouping', () => {
    const total = groupBySeverity(findings).reduce((n, g) => n + g.findings.length, 0);
    expect(total).toBe(findings.length);
  });

  it('reports the top severity', () => {
    expect(topSeverity(findings)).toBe('high');
    expect(topSeverity([makeFinding('a', { severity: 'low' })])).toBe('low');
    expect(topSeverity([])).toBeNull();
  });
});

describe('buildFilmstrip', () => {
  const diff = makeDiff({
    flowDiff: [
      entry('cart', 0, 0, 'matched'),
      entry('pay-form', 1, 1, 'matched'),
      entry('receipt', null, 2, 'added'),
      entry('legacy', 2, null, 'removed'),
      entry('pay-click', 3, 3, 'failed'),
    ],
    steps: [
      makeStepDiff('cart', 'matched', {
        viewports: { '1280x800': makeViewportDiff('1280x800', { pixelChangedRatio: 0 }) },
      }),
      makeStepDiff('pay-form', 'matched', {
        viewports: {
          '1280x800': makeViewportDiff('1280x800', {
            pixelChangedRatio: 0.021,
            findings: [
              makeFinding('f1', { severity: 'med' }),
              makeFinding('f2', { severity: 'high' }),
            ],
          }),
        },
      }),
      makeStepDiff('receipt', 'added', {
        viewports: { '1280x800': makeViewportDiff('1280x800', { missing: 'base' }) },
      }),
      makeStepDiff('legacy', 'removed', {
        viewports: { '1280x800': makeViewportDiff('1280x800', { missing: 'head' }) },
      }),
      makeStepDiff('pay-click', 'failed', { viewports: {} }),
    ],
  });

  const cells = buildFilmstrip(diff, '1280x800');

  it('emits one cell per aligned step, in display order', () => {
    // base: cart, pay-form, legacy, pay-click    head: cart, pay-form, receipt, pay-click
    expect(cells.map((c) => c.id)).toEqual([
      'cart',
      'pay-form',
      'legacy',
      'receipt',
      'pay-click',
    ]);
    expect(cells.map((c) => c.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('marks an unchanged matched step identical with an "=" badge', () => {
    const cart = cells[0];
    expect(cart?.variant).toBe('identical');
    expect(cart?.badge).toBe('=');
    expect(cart?.identical).toBe(true);
  });

  it('badges a changed step with its finding count and top severity', () => {
    const pay = cells[1];
    expect(pay?.variant).toBe('changed');
    expect(pay?.badge).toBe('2');
    expect(pay?.findingsCount).toBe(2);
    expect(pay?.topSeverity).toBe('high');
    expect(pay?.pixelChangedRatio).toBeCloseTo(0.021);
  });

  it('uses the categorical badges for added, removed and failed', () => {
    expect(cells[3]?.variant).toBe('added');
    expect(cells[3]?.badge).toBe('+');
    expect(cells[2]?.variant).toBe('removed');
    expect(cells[2]?.badge).toBe('−');
    expect(cells[4]?.variant).toBe('failed');
    expect(cells[4]?.badge).toBe('!');
  });

  it('takes the thumbnail from the base side for a removed step', () => {
    expect(cells[2]?.thumbSide).toBe('base');
    expect(cells[3]?.thumbSide).toBe('head');
  });

  it('treats a matched step with zero pixel change but a console finding as changed', () => {
    const withConsole = makeDiff({
      flowDiff: [entry('cart', 0, 0, 'matched')],
      steps: [
        makeStepDiff('cart', 'matched', {
          viewports: { '1280x800': makeViewportDiff('1280x800', { pixelChangedRatio: 0 }) },
          findings: [makeFinding('f1', { kind: 'console', severity: 'high' })],
        }),
      ],
    });
    const cell = buildFilmstrip(withConsole, '1280x800')[0];
    expect(cell?.variant).toBe('changed');
    expect(cell?.badge).toBe('1');
  });
});

describe('visibleCells', () => {
  const diff = makeDiff({
    flowDiff: [entry('a', 0, 0, 'matched'), entry('b', 1, 1, 'matched')],
    steps: [
      makeStepDiff('a', 'matched', {
        viewports: { '1280x800': makeViewportDiff('1280x800') },
      }),
      makeStepDiff('b', 'matched', {
        viewports: {
          '1280x800': makeViewportDiff('1280x800', {
            pixelChangedRatio: 0.1,
            findings: [makeFinding('f1')],
          }),
        },
      }),
    ],
  });
  const cells = buildFilmstrip(diff, '1280x800');

  it('passes everything through when the filter is off', () => {
    expect(visibleCells(cells, false).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('keeps only steps with findings when the filter is on', () => {
    expect(visibleCells(cells, true).map((c) => c.id)).toEqual(['b']);
  });

  it('falls back to the full strip rather than filtering to nothing', () => {
    const clean = buildFilmstrip(
      makeDiff({
        flowDiff: [entry('a', 0, 0, 'matched')],
        steps: [
          makeStepDiff('a', 'matched', {
            viewports: { '1280x800': makeViewportDiff('1280x800') },
          }),
        ],
      }),
      '1280x800',
    );
    expect(visibleCells(clean, true).map((c) => c.id)).toEqual(['a']);
  });
});

describe('viewportsOf', () => {
  it('lists head viewports first, then any extra base viewport', () => {
    const diff = makeDiff({});
    diff.headMeta.viewports = ['1280x800'];
    diff.baseMeta.viewports = ['1280x800', '390x844'];
    expect(viewportsOf(diff)).toEqual(['1280x800', '390x844']);
  });
});

describe('run helpers', () => {
  it('labels a run with id, short sha, ref and dirty marker', () => {
    expect(runLabel(makeRun('0007', { sha: '9f8e7d6abc', ref: 'feat/pay', dirty: true }))).toBe(
      '0007  9f8e7d6 feat/pay *',
    );
    expect(runLabel(makeRun('0003', { sha: 'aaaaaaabbb', ref: null, dirty: false }))).toBe(
      '0003  aaaaaaa',
    );
  });

  it('finds a run index and reports -1 for unknown ids', () => {
    const runs = [makeRun('0001'), makeRun('0002')];
    expect(runIndex(runs, '0002')).toBe(1);
    expect(runIndex(runs, '0009')).toBe(-1);
    expect(runIndex(runs, null)).toBe(-1);
  });
});
