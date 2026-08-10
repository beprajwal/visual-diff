import { describe, expect, it } from 'vitest';
import {
  describePlacement,
  describeRuleChanges,
  formatRuleChanges,
  ruleFieldChanges,
  structuralVariantDiff,
  variantLevelChanges,
  verbOf,
} from './structural-diff.js';
import type { CloneSpec, VariantRule, VariantSpec } from './types.js';

function spec(rules: VariantRule[], variant = 'denser-forecast'): VariantSpec {
  return { version: 1, variant, rules };
}

const style = (id: string, match: string, declarations: Record<string, string>): VariantRule => ({
  id,
  match,
  style: declarations,
});

const hide = (id: string, match: string): VariantRule => ({ id, match, hide: true });

const clone = (id: string, overrides: Partial<CloneSpec> = {}): VariantRule => ({
  id,
  clone: {
    from: { step: 'pricing', match: '.plan' },
    into: '.sidebar',
    position: 'append',
    times: 1,
    ...overrides,
  } as CloneSpec,
});

describe('structuralVariantDiff', () => {
  it('aligns by rule id and not by position', () => {
    const base = spec([hide('a', '.a'), hide('b', '.b')]);
    const head = spec([hide('b', '.b'), hide('a', '.a')]);
    const entries = structuralVariantDiff({ base, head });

    expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
      ['b', 'matched'],
      ['a', 'matched'],
    ]);
    expect(entries[0]).toMatchObject({ baseIndex: 1, headIndex: 0 });
    expect(entries[1]).toMatchObject({ baseIndex: 0, headIndex: 1 });
  });

  it('reports added and removed rules, keeping deletions where they disappeared from', () => {
    const base = spec([hide('a', '.a'), hide('gone', '.g'), hide('c', '.c')]);
    const head = spec([hide('a', '.a'), hide('new', '.n'), hide('c', '.c')]);
    const entries = structuralVariantDiff({ base, head });

    expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
      ['a', 'matched'],
      ['gone', 'removed'],
      ['new', 'added'],
      ['c', 'matched'],
    ]);
    expect(entries[1]).toMatchObject({ baseIndex: 1, headIndex: null });
    expect(entries[2]).toMatchObject({ baseIndex: null, headIndex: 1 });
  });

  it('describes what changed on a rule that kept its id', () => {
    const base = spec([style('tighter', '.card', { padding: '8px', gap: '4px' })]);
    const head = spec([style('tighter', '.card', { padding: '4px', gap: '4px' })]);
    const entries = structuralVariantDiff({ base, head });

    expect(entries[0]?.status).toBe('changed');
    expect(entries[0]?.detail).toBe("padding '8px' -> '4px'");
  });

  it('does not report a rule that only moved as changed', () => {
    const base = spec([hide('a', '.a'), style('b', '.b', { gap: '4px' })]);
    const head = spec([style('b', '.b', { gap: '4px' }), hide('a', '.a')]);
    expect(structuralVariantDiff({ base, head }).every((e) => e.status === 'matched')).toBe(true);
  });
});

describe('ruleFieldChanges', () => {
  it('reports a changed match', () => {
    expect(describeRuleChanges(hide('a', '.a'), hide('a', '.b'))).toEqual([
      "match '.a' -> '.b'",
    ]);
  });

  it('reports a changed verb without dumping both bodies', () => {
    const base = style('a', '.a', { padding: '8px' });
    const head = hide('a', '.a');
    expect(ruleFieldChanges(base, head)).toEqual([{ key: 'verb', from: 'style', to: 'hide' }]);
    expect(describeRuleChanges(base, head)).toEqual(["verb 'style' -> 'hide'"]);
  });

  it('compares style declaration by declaration', () => {
    const base = style('a', '.a', { padding: '8px', gap: '4px' });
    const head = style('a', '.a', { padding: '8px', color: 'red' });
    expect(describeRuleChanges(base, head)).toEqual(['added color \'red\'', "removed gap '4px'"]);
  });

  it('says nothing about two identical hide rules', () => {
    expect(describeRuleChanges(hide('a', '.a'), hide('a', '.a'))).toEqual([]);
  });

  it('reports a changed text', () => {
    const base: VariantRule = { id: 'a', match: '.cta', text: 'One' };
    const head: VariantRule = { id: 'a', match: '.cta', text: 'Two' };
    expect(describeRuleChanges(base, head)).toEqual(["text 'One' -> 'Two'"]);
  });

  it('renders a placement as one readable token rather than "order changed"', () => {
    const base: VariantRule = { id: 'a', match: '.chart', order: 'first' };
    const head: VariantRule = { id: 'a', match: '.chart', order: { before: '.card' } };
    expect(describeRuleChanges(base, head)).toEqual(["order 'first' -> 'before .card'"]);
  });

  it('reports every field of a clone that moved', () => {
    const base = clone('a');
    const head = clone('a', {
      from: { url: '/pricing', match: '.plan-b' },
      into: '.aside',
      position: { before: '.card' },
      times: 3,
    });
    expect(describeRuleChanges(base, head)).toEqual([
      "removed clone.from.step 'pricing'",
      "added clone.from.url '/pricing'",
      "clone.from.match '.plan' -> '.plan-b'",
      "clone.into '.sidebar' -> '.aside'",
      "clone.position 'append' -> 'before .card'",
      'clone.times 1 -> 3',
    ]);
  });

  it('says nothing when a clone only had its defaults written out', () => {
    expect(describeRuleChanges(clone('a'), clone('a', { position: 'append', times: 1 }))).toEqual(
      [],
    );
  });
});

describe('formatRuleChanges', () => {
  it('names appearances and disappearances', () => {
    expect(
      formatRuleChanges([
        { key: 'clone.times', from: undefined, to: 3 },
        { key: 'style.gap', from: '4px', to: undefined },
      ]),
    ).toEqual(['added clone.times 3', "removed gap '4px'"]);
  });

  it('falls back to "<key> changed" for anything structured', () => {
    expect(formatRuleChanges([{ key: 'clone', from: { a: 1 }, to: { a: 2 } }])).toEqual([
      'clone changed',
    ]);
  });
});

describe('variantLevelChanges', () => {
  it('reports a renamed variant and a rewritten description', () => {
    const base: VariantSpec = { ...spec([hide('a', '.a')]), description: 'One' };
    const head: VariantSpec = { ...spec([hide('a', '.a')], 'sparse-sidebar'), description: 'Two' };
    expect(variantLevelChanges(base, head)).toEqual([
      "variant 'denser-forecast' -> 'sparse-sidebar'",
      "description 'One' -> 'Two'",
    ]);
  });

  it('names an absent description rather than rendering it as "undefined"', () => {
    const base = spec([hide('a', '.a')]);
    const head: VariantSpec = { ...spec([hide('a', '.a')]), description: 'Two' };
    expect(variantLevelChanges(base, head)).toEqual(["description unset -> 'Two'"]);
  });

  it('reports a reordering, because rules apply in file order', () => {
    const base = spec([hide('a', '.a'), hide('b', '.b')]);
    const head = spec([hide('b', '.b'), hide('a', '.a')]);
    expect(variantLevelChanges(base, head)).toEqual([
      'rules reordered, which changes the order they are applied in',
    ]);
  });

  it('does not call an insertion a reordering', () => {
    const base = spec([hide('a', '.a'), hide('b', '.b')]);
    const head = spec([hide('a', '.a'), hide('new', '.n'), hide('b', '.b')]);
    expect(variantLevelChanges(base, head)).toEqual([]);
  });
});

describe('verbOf and describePlacement', () => {
  it('names the verb a rule is built around', () => {
    expect(verbOf(style('a', '.a', { gap: '4px' }))).toBe('style');
    expect(verbOf(hide('a', '.a'))).toBe('hide');
    expect(verbOf(clone('a'))).toBe('clone');
    expect(verbOf({ id: 'a', match: '.a', text: 'x' })).toBe('text');
    expect(verbOf({ id: 'a', match: '.a', order: 'last' })).toBe('order');
  });

  it('renders every placement form', () => {
    expect(describePlacement('first')).toBe('first');
    expect(describePlacement('append')).toBe('append');
    expect(describePlacement({ before: '.card' })).toBe('before .card');
    expect(describePlacement({ after: '.card' })).toBe('after .card');
  });
});
