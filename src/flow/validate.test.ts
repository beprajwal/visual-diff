import { describe, expect, it } from 'vitest';
import type { FlowSpec, SourceLocation, Step } from '../types.js';
import { validateFlowSpec, type Locate } from './validate.js';

/** A locator that just echoes the key path, so tests assert on the offending key. */
const locate: Locate = (path): SourceLocation => ({
  file: 'checkout.yaml',
  line: 1,
  column: 1,
  key: path
    .map((segment, index) =>
      typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join(''),
});

function spec(overrides: Partial<FlowSpec> = {}, steps?: Step[]): FlowSpec {
  return {
    version: 1,
    flow: 'checkout',
    viewports: ['1280x800'],
    network: { mode: 'replay', har: 'checkout.har' },
    steps: steps ?? [{ id: 'cart', goto: '/cart', shoot: true }],
    ...overrides,
  };
}

describe('validateFlowSpec', () => {
  it('accepts a well-formed spec', () => {
    const { issues, warnings } = validateFlowSpec(spec(), locate);
    expect(issues).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('rejects a flow name that is not a safe directory name', () => {
    for (const flow of ['../escape', 'has space', '.hidden', '']) {
      const { issues } = validateFlowSpec(spec({ flow }), locate);
      expect(issues.map((issue) => issue.code)).toEqual(['invalid-flow-name']);
      expect(issues[0]?.at.key).toBe('flow');
    }
  });

  it('warns on a flow-name/file-name mismatch without failing', () => {
    const { issues, warnings } = validateFlowSpec(spec(), locate, { expectFlowName: 'cart' });
    expect(issues).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(['flow-name-mismatch']);
  });

  it('checks the viewport grammar', () => {
    const { issues } = validateFlowSpec(spec({ viewports: ['1280x800', '0x800', '1280-800'] }), locate);
    expect(issues.map((issue) => issue.at.key)).toEqual(['viewports[1]', 'viewports[2]']);
    expect(issues.every((issue) => issue.code === 'invalid-viewport')).toBe(true);
  });

  it('rejects a duplicated viewport', () => {
    const { issues } = validateFlowSpec(spec({ viewports: ['1280x800', '1280x800'] }), locate);
    expect(issues.map((issue) => issue.code)).toEqual(['duplicate-viewport']);
    expect(issues[0]?.at.key).toBe('viewports[1]');
  });

  it('requires a har for record and replay, and ignores one for off', () => {
    for (const mode of ['record', 'replay'] as const) {
      const { issues } = validateFlowSpec(spec({ network: { mode } }), locate);
      expect(issues.map((issue) => issue.code)).toEqual(['har-required']);
      expect(issues[0]?.at.key).toBe('network.har');
    }

    const off = validateFlowSpec(spec({ network: { mode: 'off' } }), locate);
    expect(off.issues).toEqual([]);

    const offWithHar = validateFlowSpec(spec({ network: { mode: 'off', har: 'c.har' } }), locate);
    expect(offWithHar.issues).toEqual([]);
    expect(offWithHar.warnings.map((w) => w.code)).toEqual(['har-ignored']);
  });

  /*
   * `mock` is the mode with no recording behind it (mocking spec D13), so unlike `record` and
   * `replay` it needs no `har` — and a `har` written next to it is worth a warning rather than
   * silence, because it suggests the author believes the recording is still being consulted.
   */
  it('needs no har for mock, and warns about one written anyway', () => {
    const mock = validateFlowSpec(spec({ network: { mode: 'mock' } }), locate);
    expect(mock.issues).toEqual([]);
    expect(mock.warnings).toEqual([]);

    const withHar = validateFlowSpec(spec({ network: { mode: 'mock', har: 'weather.har' } }), locate);
    expect(withHar.issues).toEqual([]);
    expect(withHar.warnings.map((w) => w.code)).toEqual(['har-ignored']);
    expect(withHar.warnings[0]?.message).toBe(
      "network.har 'weather.har' is ignored because network.mode is 'mock'",
    );
  });

  it('names the mode it is ignoring the har for', () => {
    const off = validateFlowSpec(spec({ network: { mode: 'off', har: 'c.har' } }), locate);
    expect(off.warnings[0]?.message).toBe(
      "network.har 'c.har' is ignored because network.mode is 'off'",
    );
  });

  it('treats a blank har as missing', () => {
    const { issues } = validateFlowSpec(spec({ network: { mode: 'replay', har: '   ' } }), locate);
    expect(issues.map((issue) => issue.code)).toEqual(['har-required']);
  });

  it('rejects step ids that would not be safe directory names', () => {
    const { issues } = validateFlowSpec(
      spec({}, [
        { id: 'cart' },
        { id: 'pay/form' },
        { id: '..' },
        { id: 'has space' },
      ]),
      locate,
    );
    expect(issues.map((issue) => issue.at.key)).toEqual([
      'steps[1].id',
      'steps[2].id',
      'steps[3].id',
    ]);
    expect(issues.every((issue) => issue.code === 'invalid-id')).toBe(true);
  });

  it('reports every repeat of a duplicated id against the first occurrence', () => {
    const { issues } = validateFlowSpec(
      spec({}, [{ id: 'cart' }, { id: 'pay' }, { id: 'cart' }, { id: 'cart' }]),
      locate,
    );
    expect(issues.map((issue) => issue.at.key)).toEqual(['steps[2].id', 'steps[3].id']);
    expect(issues.every((issue) => issue.code === 'duplicate-id')).toBe(true);
    expect(issues[0]?.message).toContain('steps[0]');
    expect(issues[1]?.message).toContain('steps[0]');
  });

  it('checks the viewport verb and rejects an empty fill', () => {
    const { issues } = validateFlowSpec(
      spec({}, [{ id: 'a', viewport: '390x844' }, { id: 'b', viewport: 'phone' }, { id: 'c', fill: {} }]),
      locate,
    );
    expect(issues.map((issue) => [issue.code, issue.at.key])).toEqual([
      ['invalid-viewport', 'steps[1].viewport'],
      ['empty-fill', 'steps[2].fill'],
    ]);
  });
});
