/**
 * The two emit switches, where the flag meets the file (D54).
 *
 * `diffOptions` is the single place `config.yaml` and the command line become engine options for
 * every command that resolves a pair, so the precedence rule is pinned here rather than discovered
 * one command at a time.
 */

import { describe, expect, it } from 'vitest';

import { fakeConfig, fakeDiffResult } from '../testing.js';
import { diffOptions, emitChannelsOf, omittedKindsOf } from './pair.js';
import type { PairSelection } from './pair.js';

function selection(overrides: Partial<PairSelection> = {}): PairSelection {
  return { flow: 'checkout', e2e: false, ...overrides };
}

describe('diffOptions', () => {
  it('emits both channels by default', () => {
    const options = diffOptions(fakeConfig(), selection());
    expect(options.emitFindings).toBe(true);
    expect(options.emitWarnings).toBe(true);
  });

  it('turns a channel off from the flag', () => {
    const options = diffOptions(fakeConfig(), selection({ noFindings: true }));
    expect(options.emitFindings).toBe(false);
    expect(options.emitWarnings).toBe(true);
  });

  it('turns a channel off from the file', () => {
    const config = fakeConfig();
    config.diff.warnings = false;
    const options = diffOptions(config, selection());
    expect(options.emitWarnings).toBe(false);
    expect(options.emitFindings).toBe(true);
  });

  it('has no flag that turns a channel the file disabled back on', () => {
    // The switch goes one way on purpose: a project that wrote `diff.findings: false` decided that
    // for every invocation, and a per-command override would make the config unreadable.
    const config = fakeConfig();
    config.diff.findings = false;
    expect(diffOptions(config, selection()).emitFindings).toBe(false);
    expect(diffOptions(config, selection({ noFindings: true })).emitFindings).toBe(false);
  });

  it('reads both channels as on when no selection is given at all', () => {
    const options = diffOptions(fakeConfig());
    expect(options.emitFindings).toBe(true);
    expect(options.emitWarnings).toBe(true);
  });
});

describe('diffOptions and the kind allowlist', () => {
  it('leaves kinds absent when the project wants every kind', () => {
    expect(diffOptions(fakeConfig(), selection()).kinds).toBeUndefined();
  });

  it('passes a narrowed list through', () => {
    const config = fakeConfig();
    config.diff.kinds = ['content', 'layout'];
    expect(diffOptions(config, selection()).kinds).toEqual(['content', 'layout']);
  });
});

describe('omittedKindsOf', () => {
  it('is empty for a diff that emitted every kind', () => {
    expect(omittedKindsOf(fakeDiffResult())).toEqual([]);
  });

  it('names what was never looked for, in vocabulary order', () => {
    const narrowed = fakeDiffResult({
      emit: { findings: true, warnings: true, kinds: ['content', 'layout'] },
    });
    expect(omittedKindsOf(narrowed)).toEqual(['style', 'structural', 'a11y', 'console', 'network']);
  });
});

describe('emitChannelsOf', () => {
  it('reads an unstamped diff as both channels on', () => {
    expect(emitChannelsOf(fakeDiffResult())).toEqual({ findings: true, warnings: true });
  });

  it('reads the stamp when there is one', () => {
    const stamped = fakeDiffResult({ emit: { findings: false, warnings: true } });
    expect(emitChannelsOf(stamped)).toEqual({ findings: false, warnings: true });
  });
});
