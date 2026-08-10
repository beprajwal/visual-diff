import { describe, expect, it } from 'vitest';

import type { Finding, FlowDiffEntry } from '../../types.js';
import {
  ALL_SCENARIOS,
  ALL_SOURCES,
  ALL_VARIANTS,
  alignFlowDiff,
  buildFilmstrip,
  degradedLayerNotes,
  e2eOriginLine,
  e2eRevisionNote,
  findingsForStep,
  groupBySeverity,
  isE2eWarning,
  isEphemeralRun,
  isHighSeverityWarning,
  isIngestedRun,
  isMockOnly,
  pairBanners,
  pairLabels,
  runIndex,
  runLabel,
  runsForScenario,
  runsForVariant,
  scenarioLabel,
  runsForSource,
  scenarioNoteRows,
  scenariosOf,
  sortFindings,
  sourceBanners,
  sourceLabel,
  sourcesOf,
  unavailableKindNote,
  topSeverity,
  variantBanners,
  variantLabel,
  variantNoteRows,
  variantsOf,
  viewportsOf,
  visibleCells,
} from './derive.js';
import {
  makeDiff,
  makeFinding,
  makePairScenarios,
  makeRun,
  makeRunMeta,
  makeStepAttribution,
  makeStepDiff,
  makeStepVariantAttribution,
  makeVariantHit,
  makeViewportDiff,
} from './test-fixtures.js';

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

/* ------------------------------------------------------------------ scenarios (mocking §6, §7) */

describe('scenariosOf', () => {
  it('lists `none` first and the rest alphabetically, so the default never moves', () => {
    const runs = [
      makeRun('0001', {}, { scenario: 'slow-air' }),
      makeRun('0002'),
      makeRun('0003', {}, { scenario: 'empty-forecast' }),
      makeRun('0004', {}, { scenario: 'empty-forecast' }),
    ];
    expect(scenariosOf(runs)).toEqual(['none', 'empty-forecast', 'slow-air']);
  });

  it('omits `none` entirely when every run had a scenario', () => {
    const runs = [makeRun('0001', {}, { scenario: 'empty-forecast' })];
    expect(scenariosOf(runs)).toEqual(['empty-forecast']);
  });

  it('is empty for an empty timeline, so the selector can hide itself', () => {
    expect(scenariosOf([])).toEqual([]);
  });
});

describe('runsForScenario', () => {
  const runs = [
    makeRun('0001'),
    makeRun('0002', {}, { scenario: 'empty-forecast' }),
    makeRun('0003'),
  ];

  it('narrows to one scenario, keeping the run ids as captured (mocking §6)', () => {
    expect(runsForScenario(runs, 'empty-forecast').map((r) => r.runId)).toEqual(['0002']);
    expect(runsForScenario(runs, 'none').map((r) => r.runId)).toEqual(['0001', '0003']);
  });

  it('passes everything through for the all-scenarios value and for no filter', () => {
    expect(runsForScenario(runs, ALL_SCENARIOS)).toHaveLength(3);
    expect(runsForScenario(runs, null)).toHaveLength(3);
  });
});

describe('scenarioLabel', () => {
  it('renders the reserved name as the absence it is', () => {
    expect(scenarioLabel('none')).toBe('no scenario');
    expect(scenarioLabel('empty-forecast')).toBe('empty-forecast');
  });
});

describe('pairLabels', () => {
  it('is empty for a same-scenario pair and for a diff stored before this slice', () => {
    expect(pairLabels(null)).toEqual([]);
    expect(pairLabels(makeDiff({}))).toEqual([]);
    expect(
      pairLabels(makeDiff({ scenarios: makePairScenarios({ base: 'e', head: 'e' }) })),
    ).toEqual([]);
  });

  it('orders the labels most severe first', () => {
    const diff = makeDiff({
      scenarios: makePairScenarios({ crossScenario: true, mockVsRecorded: true }),
    });
    expect(pairLabels(diff)).toEqual(['mock-vs-recorded', 'cross-scenario']);
  });
});

describe('isMockOnly', () => {
  it('is true only for the mock network mode (D13)', () => {
    expect(isMockOnly({ network: 'mock' })).toBe(true);
    expect(isMockOnly({ network: 'replay' })).toBe(false);
    expect(isMockOnly(null)).toBe(false);
    expect(isMockOnly(undefined)).toBe(false);
  });
});

describe('pairBanners', () => {
  it('says nothing for a same-scenario pair', () => {
    expect(pairBanners(null)).toEqual([]);
    expect(pairBanners(makeDiff({}))).toEqual([]);
    expect(
      pairBanners(makeDiff({ scenarios: makePairScenarios({ base: 'e', head: 'e' }) })),
    ).toEqual([]);
  });

  it('states a cross-scenario pair at medium severity, naming both states', () => {
    const rows = pairBanners(
      makeDiff({
        scenarios: makePairScenarios({
          base: 'none',
          head: 'empty-forecast',
          crossScenario: true,
        }),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('cross-scenario');
    expect(rows[0]?.severity).toBe('med');
    expect(rows[0]?.message).toBe(
      'base ran no scenario, head ran empty-forecast. This compares two states, not two' +
        ' revisions — findings below describe the difference between the scenarios as much as' +
        ' the code.',
    );
  });

  it('flags mock-versus-recorded high, and puts it first', () => {
    const rows = pairBanners(
      makeDiff({
        scenarios: makePairScenarios({
          base: 'none',
          head: 'offline',
          crossScenario: true,
          mockVsRecorded: true,
        }),
      }),
    );
    expect(rows.map((row) => [row.label, row.severity])).toEqual([
      ['mock-vs-recorded', 'high'],
      ['cross-scenario', 'med'],
    ]);
    expect(rows[0]?.message).toContain('compares a fiction to a measurement');
  });
});

describe('scenarioNoteRows', () => {
  const patched = makeStepAttribution('forecast', {
    rules: [
      {
        scenario: 'empty-forecast',
        ruleId: 'forecast-empty',
        action: 'patch',
        requests: 1,
        bodyChanged: 1,
        urls: ['https://api/v1/forecast'],
      },
    ],
  });

  it('is empty when there is no attribution and when nothing fired', () => {
    expect(scenarioNoteRows('head', undefined)).toEqual([]);
    expect(scenarioNoteRows('head', makeStepAttribution('forecast'))).toEqual([]);
  });

  it('prints the spec’s sentence, keyed and sided so both ends can coexist', () => {
    expect(scenarioNoteRows('head', patched)).toEqual([
      {
        key: 'head-forecast-empty-patch',
        side: 'head',
        text: 'response modified by empty-forecast rule forecast-empty',
        urls: ['https://api/v1/forecast'],
        severity: 'note',
      },
    ]);
    expect(scenarioNoteRows('base', patched)[0]?.key).toBe('base-forecast-empty-patch');
  });

  it('counts repeats rather than repeating the line', () => {
    const many = makeStepAttribution('forecast', {
      rules: [{ ...patched.rules[0]!, requests: 3, bodyChanged: 3 }],
    });
    expect(scenarioNoteRows('head', many)[0]?.text).toBe(
      'response modified by empty-forecast rule forecast-empty ×3',
    );
  });

  it('raises a mock-mode miss to high severity, since the page never got a response', () => {
    const missed = makeStepAttribution('home', { misses: 1 });
    expect(scenarioNoteRows('head', missed)).toEqual([
      {
        key: 'head-miss',
        side: 'head',
        text: '1 request matched no rule and was aborted — this step rendered without it',
        urls: [],
        severity: 'high',
      },
    ]);

    const several = makeStepAttribution('home', { misses: 3 });
    expect(scenarioNoteRows('head', several)[0]?.text).toBe(
      '3 requests matched no rule and were aborted — this step rendered without them',
    );
  });
});

/* ------------------------------------------------------------------ variants (§5, §7) */

describe('variantsOf', () => {
  it('lists `none` first and the rest alphabetically, like the scenario axis', () => {
    expect(
      variantsOf([
        makeRun('0001', {}, { variant: 'sidebar-upsell' }),
        makeRun('0002'),
        makeRun('0003', {}, { variant: 'denser-forecast' }),
      ]),
    ).toEqual(['none', 'denser-forecast', 'sidebar-upsell']);
  });

  /** A store with no variants must offer nothing, so the selector never appears at all. */
  it('reports only `none` for a timeline written before variants existed', () => {
    expect(variantsOf([makeRun('0001'), makeRun('0002')])).toEqual(['none']);
    expect(variantsOf([])).toEqual([]);
  });
});

describe('runsForVariant', () => {
  const runs = [
    makeRun('0001'),
    makeRun('0002', {}, { variant: 'denser-forecast' }),
    makeRun('0003', {}, { variant: 'denser-forecast', kept: true }),
  ];

  it('narrows to one proposal, and `none` selects the runs captured without one', () => {
    expect(runsForVariant(runs, 'denser-forecast').map((run) => run.runId)).toEqual(['0002', '0003']);
    expect(runsForVariant(runs, 'none').map((run) => run.runId)).toEqual(['0001']);
  });

  /**
   * The report is not the CLI timeline: `vdiff runs` hides unpromoted proposals so they cannot
   * crowd out regression history (D24), but a proposal that cannot be selected in the report cannot
   * be looked at, which is the only reason to have run one.
   */
  it('offers unpromoted variant runs by default rather than hiding them as `vdiff runs` does', () => {
    expect(runsForVariant(runs, ALL_VARIANTS).map((run) => run.runId)).toEqual([
      '0001',
      '0002',
      '0003',
    ]);
    expect(runsForVariant(runs, null)).toHaveLength(3);
  });

  it('still knows which of them the CLI would have hidden', () => {
    expect(runs.map(isEphemeralRun)).toEqual([false, true, false]);
  });
});

describe('variantLabel', () => {
  it('renders the reserved name as an absence, not as a name', () => {
    expect(variantLabel('none')).toBe('no variant');
    expect(variantLabel('denser-forecast')).toBe('denser-forecast');
  });
});

describe('variantBanners', () => {
  const revision = { sha: 'abc1234', ref: 'main', dirty: false };

  it('says nothing for a pair with no variant on either side', () => {
    expect(variantBanners(null)).toEqual([]);
    expect(variantBanners(makeDiff({}))).toEqual([]);
  });

  /**
   * The decision this asserts (D24): the proposal comparison is the normal case, so it is stated at
   * `note` severity. A `med` here would put a warning stripe on the one thing a variant run exists
   * to produce, and a reader who learns to ignore that stripe will also ignore the two below.
   */
  it('states the proposal pair calmly, at `note` severity', () => {
    const rows = variantBanners(
      makeDiff({
        baseMeta: makeRunMeta('0003', { revision }),
        headMeta: makeRunMeta('0007', { revision, variant: 'denser-forecast' }),
      }),
    );
    expect(rows).toEqual([
      {
        label: 'variant-proposal',
        severity: 'note',
        message:
          "proposal: variant 'denser-forecast' against the unmodified page at the same revision",
      },
    ]);
  });

  it('raises a cross-variant pair, which compares two proposals rather than two revisions', () => {
    const rows = variantBanners(
      makeDiff({
        baseMeta: makeRunMeta('0003', { revision, variant: 'denser-forecast' }),
        headMeta: makeRunMeta('0007', { revision, variant: 'sidebar-upsell' }),
      }),
    );
    expect(rows[0]?.severity).toBe('med');
    expect(rows[0]?.message).toBe(
      "cross-variant: base ran 'denser-forecast', head ran 'sidebar-upsell' —" +
        ' this compares two proposals, not two revisions',
    );
  });

  it('raises a proposal pair that also spans revisions, which mixes two changes', () => {
    const rows = variantBanners(
      makeDiff({
        baseMeta: makeRunMeta('0003', { revision }),
        headMeta: makeRunMeta('0007', {
          revision: { sha: 'def5678', ref: 'main', dirty: false },
          variant: 'denser-forecast',
        }),
      }),
    );
    expect(rows[0]?.label).toBe('variant-across-revisions');
    expect(rows[0]?.severity).toBe('med');
    expect(rows[0]?.message).toContain('mixes the proposal with the code change between them');
  });

  it('leaves a same-variant pair across revisions alone — it is an ordinary regression', () => {
    expect(
      variantBanners(
        makeDiff({
          baseMeta: makeRunMeta('0003', { revision, variant: 'denser-forecast' }),
          headMeta: makeRunMeta('0007', {
            revision: { sha: 'def5678', ref: 'main', dirty: false },
            variant: 'denser-forecast',
          }),
        }),
      ),
    ).toEqual([]);
  });
});

describe('variantNoteRows', () => {
  const step = makeStepVariantAttribution('forecast', {
    rules: [makeVariantHit('tighter-cards', { elements: 12, viewports: ['1280x800', '390x844'] })],
  });

  it('is empty when there is no attribution and when no rule touched this step', () => {
    expect(variantNoteRows('head', undefined)).toEqual([]);
    expect(variantNoteRows('head', makeStepVariantAttribution('forecast'))).toEqual([]);
  });

  it('prints the spec’s sentence, keyed and sided so both ends can coexist', () => {
    expect(variantNoteRows('head', step)).toEqual([
      {
        key: 'head-tighter-cards-style',
        side: 'head',
        verb: 'style',
        text: '12 elements modified by denser-forecast rule tighter-cards',
        viewports: ['1280x800', '390x844'],
      },
    ]);
    expect(variantNoteRows('base', step)[0]?.key).toBe('base-tighter-cards-style');
  });

  it('keys by rule *and* verb, so two verbs of one rule are two rows', () => {
    const both = makeStepVariantAttribution('forecast', {
      rules: [makeVariantHit('r'), makeVariantHit('r', { verb: 'hide' })],
    });
    expect(variantNoteRows('head', both).map((row) => row.key)).toEqual([
      'head-r-style',
      'head-r-hide',
    ]);
  });
});

describe('isHighSeverityWarning', () => {
  /**
   * All three variant warnings mean the screenshot is not the proposal its label claims — the same
   * hazard `scenario-rule-unmatched` carries one axis over, and the loudest thing this tool says.
   */
  it('raises every variant warning, including the D22 revert', () => {
    expect(isHighSeverityWarning('variant-rule-unmatched')).toBe(true);
    expect(isHighSeverityWarning('variant-rule-reverted')).toBe(true);
    expect(isHighSeverityWarning('variant-clone-unstyled')).toBe(true);
  });

  it('keeps the pre-existing severities exactly as they were', () => {
    expect(isHighSeverityWarning('scenario-rule-unmatched')).toBe(true);
    expect(isHighSeverityWarning('har-miss')).toBe(true);
    expect(isHighSeverityWarning('dom-truncated')).toBe(false);
    expect(isHighSeverityWarning('settle-timeout')).toBe(false);
    expect(isHighSeverityWarning('har-recorded')).toBe(false);
  });
});

/* ------------------------------------------------------------------ e2e (e2e spec §4, §7, D27) */

describe('the source axis in the report (e2e spec §7)', () => {
  it('reads a run written before this slice as a replay, and badges nothing', () => {
    expect(isIngestedRun(makeRun('0001'))).toBe(false);
    expect(sourcesOf([makeRun('0001'), makeRun('0002')])).toEqual(['replay']);
  });

  it('lists both sources in a fixed order, so the picker does not reorder as runs arrive', () => {
    const runs = [makeRun('0001', {}, { source: 'e2e' }), makeRun('0002')];
    expect(sourcesOf(runs)).toEqual(['replay', 'e2e']);
    expect(sourceLabel('e2e')).toBe('e2e');
    expect(sourceLabel('replay')).toBe('replay');
  });

  /**
   * Deliberately unlike `vdiff runs`, which hides them (D27). The report is a viewer with an
   * explicit picker, and a run that cannot be selected cannot be looked at.
   */
  it('does not hide ingested runs from the picker; it filters only when asked', () => {
    const runs = [makeRun('0001'), makeRun('0002', {}, { source: 'e2e' })];
    expect(runsForSource(runs, null).map((run) => run.runId)).toEqual(['0001', '0002']);
    expect(runsForSource(runs, ALL_SOURCES).map((run) => run.runId)).toEqual(['0001', '0002']);
    expect(runsForSource(runs, 'e2e').map((run) => run.runId)).toEqual(['0002']);
    expect(runsForSource(runs, 'replay').map((run) => run.runId)).toEqual(['0001']);
  });

  it('renders one provenance line for an ingested run, and nothing for a replay', () => {
    expect(
      e2eOriginLine(
        makeRun('0002', {}, {
          source: 'e2e',
          e2e: { title: 'weather.spec.ts:12 › weather › shows the forecast', browser: 'chromium' },
        }),
      ),
    ).toBe('test weather.spec.ts:12 › weather › shows the forecast · chromium');
    expect(e2eOriginLine(makeRun('0001'))).toBeNull();
  });

  it('explains an ingested run with no revision, and stays silent about a replay with none', () => {
    expect(e2eRevisionNote(makeRun('0002', { sha: '' }, { source: 'e2e' }))).toBe(
      'revision unknown: a Playwright trace records no git metadata, so this run is not attributed' +
        ' to a commit rather than being attributed to the wrong one',
    );
    // A replay with no revision means git could not be read — a different problem with a different
    // remedy, and answering it with "traces carry no git metadata" would be actively misleading.
    expect(e2eRevisionNote(makeRun('0001', { sha: '' }))).toBeNull();
    expect(e2eRevisionNote(makeRun('0002', {}, { source: 'e2e' }))).toBeNull();
  });
});

describe('sourceBanners (e2e spec §4, D27)', () => {
  const e2eDiff = (base: string | null, head: string | null) =>
    makeDiff({
      baseMeta: makeRunMeta('0003', base === null ? {} : { source: 'e2e' }),
      headMeta: makeRunMeta('0007', head === null ? {} : { source: 'e2e' }),
    });

  it('shows nothing for two replays — every pair the report could show before this slice', () => {
    expect(sourceBanners(e2eDiff(null, null))).toEqual([]);
    expect(sourceBanners(null)).toEqual([]);
  });

  it('states an e2e pair at note severity, carrying the reduced-detail list', () => {
    const [row] = sourceBanners(e2eDiff('e2e', 'e2e'));
    expect(row?.label).toBe('e2e-pair');
    expect(row?.severity).toBe('note');
    expect(row?.details).toHaveLength(3);
    expect(row?.details[0]).toContain('no property-level findings');
  });

  it('raises a mixed pair to high, the same severity as mock-vs-recorded', () => {
    const [row] = sourceBanners(e2eDiff(null, 'e2e'));
    expect(row?.label).toBe('e2e-vs-replay');
    expect(row?.severity).toBe('high');
    expect(row?.message).toContain('captured by different machinery');
    // Degraded as well as confounded: the property-level findings are missing from this comparison
    // too, and a reader told only "these are incomparable" would still misread the empty layers.
    expect(row?.details).toHaveLength(3);
  });
});

describe('the degraded-diff explanation in the findings rail (§4)', () => {
  it('says nothing on a replay pair, so an ordinary review is unchanged', () => {
    expect(degradedLayerNotes(makeDiff({}))).toEqual([]);
    expect(degradedLayerNotes(null)).toEqual([]);
  });

  /**
   * The whole requirement of §4: an empty findings list and an unobtainable one look identical
   * until one of them says so, and the difference is a passing review versus a review that never
   * happened.
   */
  it('explains each layer a trace cannot supply, naming the layer', () => {
    const diff = makeDiff({
      baseMeta: makeRunMeta('0003', { source: 'e2e' }),
      headMeta: makeRunMeta('0007', { source: 'e2e' }),
    });
    expect(degradedLayerNotes(diff)).toEqual([
      'computed-style findings: not available for an e2e pair: a Playwright trace records no' +
        ' computed styles, so there is nothing to compare property by property',
      'accessibility findings: not available for an e2e pair: a Playwright trace records no' +
        ' accessibility tree',
    ]);
  });

  it('says nothing about a kind an e2e pair can still produce', () => {
    const diff = makeDiff({
      baseMeta: makeRunMeta('0003', { source: 'e2e' }),
      headMeta: makeRunMeta('0007', { source: 'e2e' }),
    });
    // Console entries are recorded unconditionally by Playwright tracing, and pixel regions and DOM
    // attribution both survive; only the two style layers are gone.
    expect(unavailableKindNote(diff, 'console')).toBeNull();
    expect(unavailableKindNote(diff, 'content')).toBeNull();
    expect(unavailableKindNote(diff, 'style')).not.toBeNull();
    expect(unavailableKindNote(diff, 'a11y')).not.toBeNull();
  });
});

describe('isHighSeverityWarning over the e2e kinds (§8)', () => {
  it('promotes a stale e2e-map entry, exactly as it promotes a never-matched scenario rule', () => {
    expect(isHighSeverityWarning('e2e-map-unmatched')).toBe(true);
  });

  it('leaves the two ordinary e2e notices where they are', () => {
    expect(isHighSeverityWarning('e2e-step-title-duplicate')).toBe(false);
    expect(isHighSeverityWarning('e2e-revision-unknown')).toBe(false);
    expect(isE2eWarning('e2e-step-title-duplicate')).toBe(true);
    expect(isE2eWarning('har-miss')).toBe(false);
  });
});
