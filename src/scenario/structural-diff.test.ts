import { describe, expect, it } from 'vitest';
import type { ScenarioRule, ScenarioSpec } from '../types.js';
import {
  describeRuleChanges,
  formatRuleChanges,
  ruleFieldChanges,
  scenarioLevelChanges,
  structuralScenarioDiff,
  verbOf,
} from './structural-diff.js';

function scenario(rules: ScenarioRule[], overrides: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return {
    version: 1,
    scenario: 'empty-forecast',
    mode: 'overlay',
    rules,
    ...overrides,
  };
}

const abortRule = (id: string, url = `**/${id}`): ScenarioRule => ({
  id,
  match: { url },
  abort: true,
});

describe('structuralScenarioDiff — alignment by rule id (mocking spec D11)', () => {
  it('reports matched rules with their positions', () => {
    const spec = scenario([abortRule('a'), abortRule('b')]);
    expect(structuralScenarioDiff({ base: spec, head: spec })).toEqual([
      { id: 'a', status: 'matched', baseIndex: 0, headIndex: 0 },
      { id: 'b', status: 'matched', baseIndex: 1, headIndex: 1 },
    ]);
  });

  it('reports added and removed rules', () => {
    const entries = structuralScenarioDiff({
      base: scenario([abortRule('a'), abortRule('gone')]),
      head: scenario([abortRule('a'), abortRule('new')]),
    });
    expect(entries).toEqual([
      { id: 'a', status: 'matched', baseIndex: 0, headIndex: 0 },
      { id: 'gone', status: 'removed', baseIndex: 1, headIndex: null },
      { id: 'new', status: 'added', baseIndex: null, headIndex: 1 },
    ]);
  });

  it('keeps a moved rule matched, reporting the move through the indices', () => {
    const entries = structuralScenarioDiff({
      base: scenario([abortRule('a'), abortRule('b'), abortRule('c')]),
      head: scenario([abortRule('c'), abortRule('a'), abortRule('b')]),
    });
    expect(entries.map((entry) => [entry.id, entry.status, entry.baseIndex, entry.headIndex])).toEqual([
      ['c', 'matched', 2, 0],
      ['a', 'matched', 0, 1],
      ['b', 'matched', 1, 2],
    ]);
  });

  it('never lets a renamed id read as a change, since a rename severs history', () => {
    const entries = structuralScenarioDiff({
      base: scenario([{ id: 'old-name', match: { url: '**/a' }, patch: { a: 1 } }]),
      head: scenario([{ id: 'new-name', match: { url: '**/a' }, patch: { a: 1 } }]),
    });
    // The removal is spliced in at the point it disappeared from, so the list reads like the head
    // scenario with deletions still visible.
    expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
      ['old-name', 'removed'],
      ['new-name', 'added'],
    ]);
  });

  it('collapses a duplicated id rather than emitting it twice', () => {
    const spec = scenario([abortRule('a'), abortRule('a', '**/other')]);
    const entries = structuralScenarioDiff({ base: spec, head: spec });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('a');
  });

  it('describes a changed rule in its detail', () => {
    const entries = structuralScenarioDiff({
      base: scenario([{ id: 'a', match: { url: '**/a' }, respond: { status: 200 } }]),
      head: scenario([{ id: 'a', match: { url: '**/b' }, respond: { status: 500 }, delay: 300 }]),
    });
    expect(entries[0]?.status).toBe('changed');
    expect(entries[0]?.detail).toBe(
      "url '**/a' -> '**/b'; respond.status 200 -> 500; added delay 300",
    );
  });
});

describe('ruleFieldChanges', () => {
  it('is empty for a rule that only changed key order', () => {
    const base: ScenarioRule = {
      id: 'a',
      match: { method: 'GET', url: '**/a' },
      respond: { status: 200, headers: { 'content-type': 'application/json' } },
    };
    const head: ScenarioRule = {
      respond: { headers: { 'content-type': 'application/json' }, status: 200 },
      match: { url: '**/a', method: 'GET' },
      id: 'a',
    };
    expect(ruleFieldChanges(base, head)).toEqual([]);
  });

  it('names the verb when the verb itself changed, and nothing underneath it', () => {
    const changes = ruleFieldChanges(
      { id: 'a', match: { url: '**/a' }, patch: { hourly: {} } },
      { id: 'a', match: { url: '**/a' }, respond: { status: 500 } },
    );
    expect(changes).toEqual([{ key: 'verb', from: 'patch', to: 'respond' }]);
    expect(formatRuleChanges(changes)).toEqual(["verb 'patch' -> 'respond'"]);
  });

  it('treats a delay-only rule as having no verb', () => {
    expect(verbOf({ id: 'a', match: { url: '**' }, delay: 10 })).toBeNull();
    expect(verbOf({ id: 'a', match: { url: '**' }, abort: true })).toBe('abort');
    expect(
      describeRuleChanges(
        { id: 'a', match: { url: '**' }, delay: 10 },
        { id: 'a', match: { url: '**' }, abort: true },
      ),
    ).toEqual(["added verb 'abort'", 'removed delay 10']);
  });

  it('reports match fields individually, without the match. prefix in the message', () => {
    expect(
      describeRuleChanges(
        { id: 'a', match: { url: '**/a' }, abort: true },
        { id: 'a', match: { method: 'GET', url: '**/b', nth: 2 }, abort: true },
      ),
    ).toEqual(["added method 'GET'", "url '**/a' -> '**/b'", 'added nth 2']);
  });

  it('reports a removed match field', () => {
    expect(
      describeRuleChanges(
        { id: 'a', match: { url: '**/a', nth: 2 }, abort: true },
        { id: 'a', match: { url: '**/a' }, abort: true },
      ),
    ).toEqual(['removed nth 2']);
  });

  it('says "changed" for a structured payload rather than dumping it', () => {
    expect(
      describeRuleChanges(
        { id: 'a', match: { url: '**' }, patch: { hourly: { t: [1, 2, 3] } } },
        { id: 'a', match: { url: '**' }, patch: { hourly: { t: [] } } },
      ),
    ).toEqual(['patch changed']);

    expect(
      describeRuleChanges(
        { id: 'a', match: { url: '**' }, patchOps: [{ op: 'remove', path: '/a' }] },
        { id: 'a', match: { url: '**' }, patchOps: [{ op: 'remove', path: '/b' }] },
      ),
    ).toEqual(['patchOps changed']);
  });

  it('sees through key order inside a patchOps entry', () => {
    expect(
      ruleFieldChanges(
        { id: 'a', match: { url: '**' }, patchOps: [{ op: 'move', path: '/b', from: '/a' }] },
        { id: 'a', match: { url: '**' }, patchOps: [{ from: '/a', path: '/b', op: 'move' }] },
      ),
    ).toEqual([]);
  });

  it('breaks a respond down into status, headers and body', () => {
    expect(
      describeRuleChanges(
        { id: 'a', match: { url: '**' }, respond: { status: 200, body: { a: 1 } } },
        {
          id: 'a',
          match: { url: '**' },
          respond: { status: 503, headers: { 'retry-after': '5' }, body: { a: 2 } },
        },
      ),
    ).toEqual(['respond.status 200 -> 503', 'added respond.headers', 'respond.body changed']);
  });

  it('reports a changed string body as the string it is', () => {
    expect(
      describeRuleChanges(
        { id: 'a', match: { url: '**' }, respond: { status: 200, body: 'yes' } },
        { id: 'a', match: { url: '**' }, respond: { status: 200, body: 'no' } },
      ),
    ).toEqual(["respond.body 'yes' -> 'no'"]);
  });

  it('sees no change between two identical abort rules', () => {
    expect(
      ruleFieldChanges(
        { id: 'a', match: { url: '**' }, abort: true },
        { id: 'a', match: { url: '**' }, abort: true },
      ),
    ).toEqual([]);
  });
});

describe('scenarioLevelChanges', () => {
  it('is empty for two identical scenarios', () => {
    const spec = scenario([abortRule('a')]);
    expect(scenarioLevelChanges(spec, spec)).toEqual([]);
  });

  it('reports mode, description and name', () => {
    expect(
      scenarioLevelChanges(
        scenario([abortRule('a')]),
        scenario([abortRule('a')], {
          scenario: 'wireframe',
          mode: 'mock',
          description: 'now with a description',
        }),
      ),
    ).toEqual([
      "scenario 'empty-forecast' -> 'wireframe'",
      "mode 'overlay' -> 'mock'",
      "description unset -> 'now with a description'",
    ]);
  });

  it('reports a reordering, because first match wins in file order', () => {
    expect(
      scenarioLevelChanges(
        scenario([abortRule('a'), abortRule('b')]),
        scenario([abortRule('b'), abortRule('a')]),
      ),
    ).toEqual(['rules reordered, which changes which rule wins a request']);
  });

  it('does not call an insertion a reordering', () => {
    expect(
      scenarioLevelChanges(
        scenario([abortRule('a'), abortRule('b')]),
        scenario([abortRule('a'), abortRule('inserted'), abortRule('b')]),
      ),
    ).toEqual([]);
  });
});
