import { describe, expect, it } from 'vitest';

import { EXIT } from '../types.js';
import { COMMANDS, commandLabel, parseArgs, wantsJson, type Invocation } from './args.js';

function ok(argv: string[]): Invocation {
  const outcome = parseArgs(argv);
  if (!outcome.ok) throw new Error(`expected '${argv.join(' ')}' to parse: ${outcome.error.message}`);
  return outcome.value;
}

function err(argv: string[]): { code: string; message: string; exitCode: number; hint?: string } {
  const outcome = parseArgs(argv);
  if (outcome.ok) throw new Error(`expected '${argv.join(' ')}' to be rejected`);
  return outcome.error;
}

describe('parseArgs — the documented surface (spec §9)', () => {
  it('parses every command line the spec documents', () => {
    expect(ok(['init'])).toEqual({ kind: 'init', json: false });

    expect(ok(['flow', 'new', 'checkout'])).toEqual({
      kind: 'flow-new',
      name: 'checkout',
      json: false,
    });
    expect(ok(['flow', 'check', 'checkout'])).toEqual({
      kind: 'flow-check',
      name: 'checkout',
      json: false,
    });

    expect(ok(['run', 'checkout'])).toEqual({
      kind: 'run',
      flow: 'checkout',
      continueOnError: false,
      noScrub: false,
      json: false,
    });

    expect(ok(['runs', 'checkout'])).toEqual({ kind: 'runs', flow: 'checkout', json: false });

    expect(ok(['diff', 'checkout'])).toEqual({ kind: 'diff', flow: 'checkout', json: false });
    expect(ok(['diff', 'checkout', '0003', '0007'])).toEqual({
      kind: 'diff',
      flow: 'checkout',
      base: '0003',
      head: '0007',
      json: false,
    });

    expect(ok(['serve'])).toEqual({ kind: 'serve', open: false, json: false });
    expect(ok(['feedback'])).toEqual({ kind: 'feedback', ack: false, json: false });
    expect(ok(['pin', '0007'])).toEqual({ kind: 'pin', runId: '0007', json: false });
    expect(ok(['prune', 'checkout', '0007'])).toEqual({
      kind: 'prune',
      flow: 'checkout',
      runId: '0007',
      json: false,
    });
    expect(ok(['install', 'claude-code'])).toEqual({
      kind: 'install',
      harness: 'claude-code',
      force: false,
      dryRun: false,
      json: false,
    });
    expect(ok(['install-browser'])).toEqual({ kind: 'install-browser', json: false });
  });

  it('carries every `install` flag through to the invocation', () => {
    expect(ok(['install', 'claude-code', '--dir', '../other', '--force', '--dry-run'])).toEqual({
      kind: 'install',
      harness: 'claude-code',
      dir: '../other',
      force: true,
      dryRun: true,
      json: false,
    });
  });

  it('requires the harness argument — `vdiff install` alone is exit 2', () => {
    expect(err(['install'])).toMatchObject({
      code: 'missing-argument',
      exitCode: EXIT.CONFIG_ERROR,
    });
  });

  it('`--list` stands in for the harness argument', () => {
    expect(ok(['install', '--list'])).toEqual({
      kind: 'install',
      list: true,
      force: false,
      dryRun: false,
      json: false,
    });
    expect(ok(['install', '--list', '--json'])).toMatchObject({ list: true, json: true });
  });

  it('rejects `--list` combined with a harness, rather than silently picking one', () => {
    expect(err(['install', 'claude-code', '--list'])).toMatchObject({
      code: 'conflicting-flags',
      exitCode: EXIT.CONFIG_ERROR,
    });
  });

  it('leaves `list` off the invocation when it was not asked for', () => {
    expect('list' in ok(['install', 'claude-code'])).toBe(false);
  });

  it('does not confuse `install` with `install-browser`', () => {
    expect(ok(['install-browser'])).toEqual({ kind: 'install-browser', json: false });
    expect(err(['install-browser', 'claude-code']).code).toBe('unexpected-argument');
  });

  it('accepts --json on every command', () => {
    for (const command of Object.keys(COMMANDS)) {
      const argv =
        command === 'flow'
          ? ['flow', 'check', 'checkout', '--json']
          : command === 'pin' || command === 'prune'
            ? [command, '0007', '--json']
            : command === 'install'
              ? ['install', 'claude-code', '--json']
              : ['run', 'runs', 'diff'].includes(command)
                ? [command, 'checkout', '--json']
                : [command, '--json'];
      expect(ok(argv).json, `${command} should accept --json`).toBe(true);
    }
  });

  it('carries every `run` flag through to the invocation', () => {
    expect(
      ok([
        'run',
        'checkout',
        '--at',
        'HEAD~3',
        '--viewport',
        '1280x800',
        '--viewport',
        '390x844',
        '--continue-on-error',
        '--no-scrub',
        '--json',
      ]),
    ).toEqual({
      kind: 'run',
      flow: 'checkout',
      at: 'HEAD~3',
      viewports: ['1280x800', '390x844'],
      continueOnError: true,
      noScrub: true,
      json: true,
    });
  });

  it('accepts a comma-separated viewport list and --flag=value form', () => {
    const invocation = ok(['run', 'checkout', '--viewport=1280x800,390x844', '--at=abc123']);
    expect(invocation).toMatchObject({ viewports: ['1280x800', '390x844'], at: 'abc123' });
  });

  it('maps --record and --no-net onto the network mode', () => {
    expect(ok(['run', 'checkout', '--record'])).toMatchObject({ network: 'record' });
    expect(ok(['run', 'checkout', '--no-net'])).toMatchObject({ network: 'off' });
  });

  it('rejects --record together with --no-net', () => {
    expect(err(['run', 'checkout', '--record', '--no-net'])).toMatchObject({
      code: 'conflicting-flags',
      exitCode: EXIT.CONFIG_ERROR,
    });
  });

  it('does not treat --no-net or --no-scrub as negations of other flags', () => {
    // A framework that reads `--no-x` as `x: false` would silently turn --no-scrub into
    // scrub:true and write an unredacted HAR (spec §6). These are flags in their own right.
    const invocation = ok(['run', 'checkout', '--no-scrub', '--no-net']);
    expect(invocation).toMatchObject({ noScrub: true, network: 'off' });
  });

  it('parses serve flags', () => {
    expect(ok(['serve', '--open', '--port', '4321'])).toEqual({
      kind: 'serve',
      open: true,
      port: 4321,
      json: false,
    });
  });

  it('parses feedback --ack', () => {
    expect(ok(['feedback', '--json', '--ack'])).toEqual({
      kind: 'feedback',
      ack: true,
      json: true,
    });
  });
});

describe('parseArgs — rejections are exit 2 (spec §9, §10)', () => {
  it('rejects an unknown command', () => {
    expect(err(['frobnicate'])).toMatchObject({
      code: 'unknown-command',
      exitCode: EXIT.CONFIG_ERROR,
    });
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    const error = err(['run', 'checkout', '--threshold', '0.5']);
    expect(error.code).toBe('unknown-flag');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.hint).toContain('vdiff run <flow>');
  });

  it('rejects a flag that belongs to a different command', () => {
    expect(err(['diff', 'checkout', '--open'])).toMatchObject({ code: 'unknown-flag' });
    expect(err(['runs', 'checkout', '--ack'])).toMatchObject({ code: 'unknown-flag' });
  });

  it('rejects a missing required argument', () => {
    expect(err(['run'])).toMatchObject({ code: 'missing-argument', exitCode: EXIT.CONFIG_ERROR });
    expect(err(['flow', 'new'])).toMatchObject({ code: 'missing-argument' });
  });

  it('rejects extra positionals', () => {
    expect(err(['diff', 'checkout', '0003', '0007', '0009'])).toMatchObject({
      code: 'unexpected-argument',
    });
    expect(err(['init', 'now'])).toMatchObject({ code: 'unexpected-argument' });
  });

  it('rejects an unknown flow subcommand', () => {
    expect(err(['flow', 'delete', 'checkout'])).toMatchObject({ code: 'unknown-subcommand' });
  });

  it('rejects a malformed viewport', () => {
    expect(err(['run', 'checkout', '--viewport', 'wide'])).toMatchObject({
      code: 'invalid-viewport',
    });
    expect(err(['run', 'checkout', '--viewport', '1280*800'])).toMatchObject({
      code: 'invalid-viewport',
    });
  });

  it('rejects a malformed port and a flag missing its value', () => {
    expect(err(['serve', '--port', 'http'])).toMatchObject({ code: 'invalid-flag-value' });
    expect(err(['serve', '--port', '99999'])).toMatchObject({ code: 'invalid-flag-value' });
    expect(err(['run', 'checkout', '--at'])).toMatchObject({ code: 'missing-flag-value' });
  });

  it('rejects a run id that is not a run number', () => {
    expect(err(['pin', 'checkout'])).toMatchObject({ code: 'invalid-run-id' });
  });
});

describe('parseArgs — help and version', () => {
  it('treats a bare invocation as help', () => {
    expect(ok([])).toEqual({ kind: 'help', json: false });
  });

  it('routes --help, -h and `help <command>`', () => {
    expect(ok(['--help'])).toEqual({ kind: 'help', json: false });
    expect(ok(['-h'])).toEqual({ kind: 'help', json: false });
    expect(ok(['help', 'run'])).toEqual({ kind: 'help', topic: 'run', json: false });
    expect(ok(['run', '--help'])).toEqual({ kind: 'help', topic: 'run', json: false });
  });

  it('routes --version', () => {
    expect(ok(['--version'])).toEqual({ kind: 'version', json: false });
  });
});

describe('wantsJson', () => {
  it('sees --json anywhere before a literal separator, so parse failures stay JSON', () => {
    expect(wantsJson(['run', 'checkout', '--json'])).toBe(true);
    expect(wantsJson(['--json', 'run', 'checkout'])).toBe(true);
    expect(wantsJson(['run', 'checkout'])).toBe(false);
    expect(wantsJson(['run', '--', '--json'])).toBe(false);
  });
});

describe('commandLabel', () => {
  it('renders the two-word flow subcommands as they are typed', () => {
    expect(commandLabel({ kind: 'flow-new', name: 'x', json: false })).toBe('flow new');
    expect(commandLabel({ kind: 'flow-check', name: 'x', json: false })).toBe('flow check');
    expect(commandLabel({ kind: 'runs', flow: 'x', json: false })).toBe('runs');
  });
});
