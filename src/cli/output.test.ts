import { describe, expect, it } from 'vitest';

import { EXIT } from '../types.js';
import {
  createBufferWriter,
  failureEnvelope,
  formatError,
  percent,
  successEnvelope,
  table,
  writeEnvelope,
  writeLines,
} from './output.js';

describe('envelopes', () => {
  it('omits absent fields rather than emitting nulls, so the JSON is byte-stable', () => {
    const envelope = successEnvelope('runs', '0.1.0', { flow: 'checkout', runs: [] });
    expect(envelope).toEqual({
      ok: true,
      command: 'runs',
      version: '0.1.0',
      data: { flow: 'checkout', runs: [] },
    });
    expect(Object.keys(envelope)).toEqual(['ok', 'command', 'version', 'data']);
  });

  it('includes warnings only when there are some', () => {
    expect(successEnvelope('run', '0.1.0', 1, [])).not.toHaveProperty('warnings');
    expect(successEnvelope('run', '0.1.0', 1, ['har-miss: /api/x'])).toMatchObject({
      warnings: ['har-miss: /api/x'],
    });
  });

  it('carries data alongside the error when a command produced both', () => {
    const envelope = failureEnvelope(
      'run',
      '0.1.0',
      { code: 'run-partial', message: 'pay-click failed', exitCode: EXIT.RUN_FAILURE },
      { runDir: '/x' },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toEqual({ runDir: '/x' });
    expect(envelope.error?.code).toBe('run-partial');
  });
});

describe('writeEnvelope', () => {
  it('writes exactly one JSON object to stdout and nothing to stderr', () => {
    const writer = createBufferWriter();
    writeEnvelope(writer, successEnvelope('init', '0.1.0', { created: [] }));

    const stdout = writer.stdout();
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout) as unknown).toEqual({
      ok: true,
      command: 'init',
      version: '0.1.0',
      data: { created: [] },
    });
    expect(writer.stderr()).toBe('');
  });
});

describe('writeLines', () => {
  it('writes nothing at all for an empty list', () => {
    const writer = createBufferWriter();
    writeLines(writer, []);
    expect(writer.stdout()).toBe('');
  });

  it('routes to the requested stream', () => {
    const writer = createBufferWriter();
    writeLines(writer, ['a', 'b'], 'err');
    expect(writer.stderr()).toBe('a\nb\n');
    expect(writer.stdout()).toBe('');
  });
});

describe('table', () => {
  it('pads every column but the last and never leaves trailing spaces', () => {
    const rows = table(
      ['RUN', 'STATUS', 'FINDINGS'],
      [
        ['0003', 'ok', '0'],
        ['0007', 'partial', '12'],
      ],
    );
    expect(rows).toEqual([
      'RUN   STATUS   FINDINGS',
      '0003  ok       0',
      '0007  partial  12',
    ]);
    for (const row of rows) expect(row).toBe(row.trimEnd());
  });

  it('fills short rows instead of throwing', () => {
    expect(table(['A', 'B'], [['only']])).toEqual(['A     B', 'only']);
  });
});

describe('formatError', () => {
  it('prints file, line and offending key for a spec error (spec §10, row 1)', () => {
    expect(
      formatError({
        code: 'flow-invalid',
        message: "flow 'checkout' is invalid: 1 issue",
        exitCode: EXIT.CONFIG_ERROR,
        issues: [
          {
            code: 'sleep-forbidden',
            message: 'a fixed sleep captures half-rendered frames; use waitFor',
            at: { file: '.visual-diff/flows/checkout.yaml', line: 12, column: 5, key: 'steps[2].sleep' },
          },
        ],
        hint: 'vdiff flow check checkout',
      }),
    ).toEqual([
      "error: flow 'checkout' is invalid: 1 issue  (flow-invalid)",
      '  .visual-diff/flows/checkout.yaml:12:5  steps[2].sleep  sleep-forbidden: a fixed sleep captures half-rendered frames; use waitFor',
      'hint: vdiff flow check checkout',
    ]);
  });
});

describe('percent', () => {
  it('renders a changed-pixel ratio the way the report does', () => {
    expect(percent(0.021)).toBe('2.1%');
    expect(percent(0)).toBe('0.0%');
    expect(percent(1)).toBe('100.0%');
  });
});
