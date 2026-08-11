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
      keep: false,
      continueOnError: false,
      noScrub: false,
      json: false,
    });

    expect(ok(['runs', 'checkout'])).toEqual({
      kind: 'runs',
      flow: 'checkout',
      variants: false,
      e2e: false,
      json: false,
    });

    expect(ok(['diff', 'checkout'])).toEqual({ kind: 'diff', flow: 'checkout', e2e: false, json: false });
    expect(ok(['diff', 'checkout', '0003', '0007'])).toEqual({
      kind: 'diff',
      e2e: false,
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

  it('--global rides on the invocation only when it was asked for (D16)', () => {
    expect(ok(['install', 'codex', '--global'])).toEqual({
      kind: 'install',
      harness: 'codex',
      global: true,
      force: false,
      dryRun: false,
      json: false,
    });
    expect('global' in ok(['install', 'codex'])).toBe(false);
  });

  it('`--check` takes an optional harness, unlike `--list`', () => {
    expect(ok(['install', '--check'])).toEqual({
      kind: 'install',
      check: true,
      force: false,
      dryRun: false,
      json: false,
    });
    expect(ok(['install', '--check', 'pi'])).toMatchObject({ check: true, harness: 'pi' });
    expect(ok(['install', '--check', '--json'])).toMatchObject({ check: true, json: true });
  });

  it('rejects `--list` with `--check`: they answer different questions', () => {
    const error = err(['install', '--list', '--check']);
    expect(error.code).toBe('conflicting-flags');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.message).toContain("'--list' and '--check'");
  });

  it('rejects `--check --global`: --check reports every scope by design', () => {
    const error = err(['install', '--check', '--global']);
    expect(error.code).toBe('conflicting-flags');
    expect(error.message).toBe("'--check' reports every scope and takes no '--global'");
  });

  it('rejects a write flag on a subcommand that writes nothing', () => {
    expect(err(['install', '--check', '--force']).message).toBe(
      "'--check' writes nothing, so '--force' has nothing to act on",
    );
    expect(err(['install', '--list', '--dry-run']).message).toBe(
      "'--list' writes nothing, so '--dry-run' has nothing to act on",
    );
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
          : command === 'scenario' || command === 'variant'
            ? [command, 'list', '--json']
          : command === 'pin' || command === 'prune'
            ? [command, '0007', '--json']
            : command === 'install'
              ? ['install', 'claude-code', '--json']
              : command === 'e2e'
                ? ['e2e', '--from', 'trace', 'trace.zip', '--json']
                : ['run', 'runs', 'diff', 'comment', 'export'].includes(command)
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
      keep: false,
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
    expect(commandLabel({ kind: 'runs', flow: 'x', variants: false, e2e: false, json: false })).toBe('runs');
  });
});

/* ------------------------------------------------------------------ scenarios (mocking §7, §8) */

describe('parseArgs — scenarios (mocking spec §7)', () => {
  it('parses the three scenario subcommands', () => {
    expect(ok(['scenario', 'new', 'empty-forecast'])).toEqual({
      kind: 'scenario-new',
      name: 'empty-forecast',
      json: false,
    });
    expect(ok(['scenario', 'check', 'empty-forecast'])).toEqual({
      kind: 'scenario-check',
      name: 'empty-forecast',
      json: false,
    });
    expect(ok(['scenario', 'list'])).toEqual({ kind: 'scenario-list', json: false });
    expect(ok(['scenario', 'list', '--json'])).toEqual({ kind: 'scenario-list', json: true });
  });

  it('labels the scenario subcommands as they are typed', () => {
    expect(commandLabel({ kind: 'scenario-new', name: 'x', json: false })).toBe('scenario new');
    expect(commandLabel({ kind: 'scenario-check', name: 'x', json: false })).toBe('scenario check');
    expect(commandLabel({ kind: 'scenario-list', json: false })).toBe('scenario list');
  });

  it('carries --scenario onto run, runs and diff', () => {
    expect(ok(['run', 'forecast', '--scenario', 'empty-forecast'])).toEqual({
      kind: 'run',
      flow: 'forecast',
      scenario: 'empty-forecast',
      keep: false,
      continueOnError: false,
      noScrub: false,
      json: false,
    });
    expect(ok(['runs', 'forecast', '--scenario', 'empty-forecast'])).toEqual({
      kind: 'runs',
      flow: 'forecast',
      scenario: 'empty-forecast',
      variants: false,
      e2e: false,
      json: false,
    });
    expect(ok(['diff', 'forecast', '0003', '0007', '--scenario', 'empty-forecast'])).toEqual({
      kind: 'diff',
      e2e: false,
      flow: 'forecast',
      base: '0003',
      head: '0007',
      scenario: 'empty-forecast',
      json: false,
    });
  });

  it('rejects --record with --scenario, naming why they cannot combine (mocking §2)', () => {
    expect(err(['run', 'forecast', '--record', '--scenario', 'empty-forecast'])).toEqual({
      code: 'conflicting-flags',
      message:
        "'--record' and '--scenario' are mutually exclusive: recording captures reality, a scenario alters it",
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'record the flow first, then replay it under a scenario',
    });
  });

  it('rejects the reserved name `none` where it would mean a file (mocking §11)', () => {
    expect(err(['scenario', 'new', 'none'])).toEqual({
      code: 'reserved-scenario-name',
      message: "'none' is the reserved scenario name for a run captured without one",
      exitCode: EXIT.CONFIG_ERROR,
      hint: "pick another name; 'none' can never be a scenario file",
    });
    expect(err(['scenario', 'check', 'none'])).toMatchObject({ code: 'reserved-scenario-name' });
  });

  it('rejects `run --scenario none` and says to omit the flag instead', () => {
    expect(err(['run', 'forecast', '--scenario', 'none'])).toEqual({
      code: 'reserved-scenario-name',
      message: "'none' is the reserved scenario name for a run captured without one",
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'omit --scenario to capture without a scenario',
    });
  });

  it('accepts `none` as a filter, because it is the value the store actually records', () => {
    expect(ok(['runs', 'forecast', '--scenario', 'none'])).toEqual({
      kind: 'runs',
      flow: 'forecast',
      variants: false,
      e2e: false,
      scenario: 'none',
      json: false,
    });
    expect(ok(['diff', 'forecast', '--scenario', 'none'])).toEqual({
      kind: 'diff',
      e2e: false,
      flow: 'forecast',
      scenario: 'none',
      json: false,
    });
  });

  it('rejects a scenario name that could not be a filename', () => {
    expect(err(['scenario', 'new', '../etc/passwd'])).toEqual({
      code: 'invalid-scenario-name',
      message: "invalid scenario name '../etc/passwd'",
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'use letters, digits, dot, dash or underscore, e.g. empty-forecast',
    });
    expect(err(['scenario', 'new', 'a..b'])).toMatchObject({ code: 'invalid-scenario-name' });
    expect(err(['run', 'forecast', '--scenario', 'has space'])).toMatchObject({
      code: 'invalid-scenario-name',
    });
    expect(err(['runs', 'forecast', '--scenario=empty/forecast'])).toMatchObject({
      code: 'invalid-scenario-name',
    });
    expect(err(['runs', 'forecast', '--scenario='])).toMatchObject({
      code: 'invalid-scenario-name',
    });
  });

  it('rejects an unknown subcommand, a missing name and a name given to `list`', () => {
    expect(err(['scenario', 'delete', 'x'])).toEqual({
      code: 'unknown-subcommand',
      message: "unknown subcommand 'scenario delete'",
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['scenario']?.usage,
    });
    expect(err(['scenario', 'new'])).toEqual({
      code: 'missing-argument',
      message: "'scenario new' requires a scenario name",
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['scenario']?.usage,
    });
    expect(err(['scenario', 'list', 'empty-forecast'])).toEqual({
      code: 'unexpected-argument',
      message: "'scenario list' enumerates every scenario and takes no name",
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['scenario']?.usage,
    });
    expect(err(['scenario'])).toMatchObject({ code: 'missing-argument' });
  });

  it('routes `vdiff scenario --help` to the help topic', () => {
    expect(ok(['scenario', '--help'])).toEqual({ kind: 'help', topic: 'scenario', json: false });
    expect(ok(['help', 'scenario'])).toEqual({ kind: 'help', topic: 'scenario', json: false });
  });
});

/* ------------------------------------------------------------------ variants (§6, §7) */

/**
 * The variant surface is the scenario surface with one difference that matters: `--variants` on
 * `runs` is not a filter but a switch between two timelines, because variant runs are excluded
 * from the regression timeline by default (D24). Everything else — reserved `none`, name shape,
 * subcommand arity — is asserted to behave identically, because a difference between the two axes
 * would be a bug in one of them rather than a design.
 */
describe('parseArgs — variants (variants spec §6)', () => {
  it('parses the three variant subcommands', () => {
    expect(ok(['variant', 'new', 'denser-forecast'])).toEqual({
      kind: 'variant-new',
      name: 'denser-forecast',
      json: false,
    });
    expect(ok(['variant', 'check', 'denser-forecast'])).toEqual({
      kind: 'variant-check',
      name: 'denser-forecast',
      json: false,
    });
    expect(ok(['variant', 'list'])).toEqual({ kind: 'variant-list', json: false });
    expect(ok(['variant', 'list', '--json'])).toEqual({ kind: 'variant-list', json: true });
  });

  it('labels the variant subcommands as they are typed', () => {
    expect(commandLabel({ kind: 'variant-new', name: 'x', json: false })).toBe('variant new');
    expect(commandLabel({ kind: 'variant-check', name: 'x', json: false })).toBe('variant check');
    expect(commandLabel({ kind: 'variant-list', json: false })).toBe('variant list');
  });

  it('carries --variant onto run and diff, and --variants onto runs', () => {
    expect(ok(['run', 'forecast', '--variant', 'denser-forecast'])).toEqual({
      kind: 'run',
      flow: 'forecast',
      variant: 'denser-forecast',
      keep: false,
      continueOnError: false,
      noScrub: false,
      json: false,
    });
    expect(ok(['runs', 'forecast', '--variants'])).toEqual({
      kind: 'runs',
      flow: 'forecast',
      variants: true,
      e2e: false,
      json: false,
    });
    expect(ok(['diff', 'forecast', '0003', '0007', '--variant', 'denser-forecast'])).toEqual({
      kind: 'diff',
      e2e: false,
      flow: 'forecast',
      base: '0003',
      head: '0007',
      variant: 'denser-forecast',
      json: false,
    });
  });

  /** "The denser layout, in the empty state" is a reasonable question (variants spec §5). */
  it('combines --variant with --scenario on one run', () => {
    expect(
      ok(['run', 'forecast', '--scenario', 'empty-forecast', '--variant', 'denser-forecast']),
    ).toEqual({
      kind: 'run',
      flow: 'forecast',
      scenario: 'empty-forecast',
      variant: 'denser-forecast',
      keep: false,
      continueOnError: false,
      noScrub: false,
      json: false,
    });
  });

  it('carries --keep alongside the variant it promotes (D24)', () => {
    expect(ok(['run', 'forecast', '--variant', 'denser-forecast', '--keep'])).toMatchObject({
      variant: 'denser-forecast',
      keep: true,
    });
  });

  it('rejects --keep without a variant, because a plain run is kept already', () => {
    expect(err(['run', 'forecast', '--keep'])).toEqual({
      code: 'keep-without-variant',
      message:
        "'--keep' promotes a variant run into the permanent timeline, and this run has no variant",
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'pass --variant <name>, or drop --keep: runs without a variant are kept already',
    });
  });

  it('rejects `none` as a variant file name and as a capture argument', () => {
    expect(err(['variant', 'new', 'none'])).toEqual({
      code: 'reserved-variant-name',
      message: "'none' is the reserved variant name for a run captured without one",
      exitCode: EXIT.CONFIG_ERROR,
      hint: "pick another name; 'none' can never be a variant file",
    });
    expect(err(['variant', 'check', 'none'])).toMatchObject({ code: 'reserved-variant-name' });
    expect(err(['run', 'forecast', '--variant', 'none'])).toEqual({
      code: 'reserved-variant-name',
      message: "'none' is the reserved variant name for a run captured without one",
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'omit --variant to capture without a variant',
    });
  });

  it('accepts `none` as a diff filter, because it is the value the store records', () => {
    expect(ok(['diff', 'forecast', '--variant', 'none'])).toEqual({
      kind: 'diff',
      e2e: false,
      flow: 'forecast',
      variant: 'none',
      json: false,
    });
  });

  it('rejects a variant name that could not be a filename', () => {
    expect(err(['variant', 'new', '../etc/passwd'])).toEqual({
      code: 'invalid-variant-name',
      message: "invalid variant name '../etc/passwd'",
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'use letters, digits, dot, dash or underscore, e.g. denser-forecast',
    });
    expect(err(['variant', 'new', 'a..b'])).toMatchObject({ code: 'invalid-variant-name' });
    expect(err(['run', 'forecast', '--variant', 'has space'])).toMatchObject({
      code: 'invalid-variant-name',
    });
    expect(err(['diff', 'forecast', '--variant='])).toMatchObject({
      code: 'invalid-variant-name',
    });
  });

  it('reports an unknown subcommand and a missing name', () => {
    expect(err(['variant', 'delete', 'x'])).toEqual({
      code: 'unknown-subcommand',
      message: "unknown subcommand 'variant delete'",
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['variant']?.usage,
    });
    expect(err(['variant', 'new'])).toEqual({
      code: 'missing-argument',
      message: "'variant new' requires a variant name",
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['variant']?.usage,
    });
    expect(err(['variant', 'list', 'denser-forecast'])).toEqual({
      code: 'unexpected-argument',
      message: "'variant list' enumerates every variant and takes no name",
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['variant']?.usage,
    });
    expect(err(['variant'])).toMatchObject({ code: 'missing-argument' });
  });

  it('routes `vdiff variant --help` to the help topic', () => {
    expect(ok(['variant', '--help'])).toEqual({ kind: 'help', topic: 'variant', json: false });
    expect(ok(['help', 'variant'])).toEqual({ kind: 'help', topic: 'variant', json: false });
  });
});

/* ------------------------------------------------------------------ e2e (e2e spec §6, §8) */

describe('parseArgs — e2e (e2e spec §6)', () => {
  it('parses the two forms the spec documents', () => {
    expect(ok(['e2e', '--from', 'trace', 'test-results/**/trace.zip'])).toEqual({
      kind: 'e2e-ingest',
      from: 'trace',
      pattern: 'test-results/**/trace.zip',
      json: false,
    });
    expect(ok(['e2e', 'list', '--from', 'trace', 'test-results/**/trace.zip'])).toEqual({
      kind: 'e2e-list',
      from: 'trace',
      pattern: 'test-results/**/trace.zip',
      json: false,
    });
  });

  it('carries --flow, the override for the name derived from the test title (D26)', () => {
    expect(ok(['e2e', '--from', 'trace', 'trace.zip', '--flow', 'weather'])).toEqual({
      kind: 'e2e-ingest',
      from: 'trace',
      pattern: 'trace.zip',
      flow: 'weather',
      json: false,
    });
    expect('flow' in ok(['e2e', '--from', 'trace', 'trace.zip'])).toBe(false);
  });

  it('labels the two forms as they are typed, for the --json envelope', () => {
    expect(
      commandLabel({ kind: 'e2e-ingest', from: 'trace', pattern: 'a.zip', json: false }),
    ).toBe('e2e');
    expect(commandLabel({ kind: 'e2e-list', from: 'trace', pattern: 'a.zip', json: false })).toBe(
      'e2e list',
    );
  });

  /**
   * `--from` is required rather than defaulted to `trace`. One reader ships today and the
   * ingestion layer is deliberately format-agnostic (§2), so a command line that never named its
   * format would silently change meaning the day a second reader is added.
   */
  it('requires --from, listing the formats this build can read', () => {
    expect(err(['e2e', 'trace.zip'])).toEqual({
      code: 'missing-flag-value',
      message: "'e2e' requires --from <format>, naming the artifact format to read",
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'supported formats: trace',
    });
    expect(err(['e2e', 'list', 'trace.zip']).message).toBe(
      "'e2e list' requires --from <format>, naming the artifact format to read",
    );
  });

  it('names the supported formats when given one it does not have', () => {
    expect(err(['e2e', '--from', 'cypress', 'out/**/*.json'])).toEqual({
      code: 'unknown-e2e-source',
      message: "unknown artifact format 'cypress'",
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'supported formats: trace',
    });
  });

  it('requires the path, including after `list`', () => {
    expect(err(['e2e', 'list', '--from', 'trace'])).toEqual({
      code: 'missing-argument',
      message: "'e2e list' requires a path or glob naming the archives to read",
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['e2e']?.usage,
    });
    expect(err(['e2e', '--from', 'trace'])).toMatchObject({ code: 'missing-argument' });
  });

  it('refuses a second path on the ingest form, which would silently drop one', () => {
    expect(err(['e2e', '--from', 'trace', 'a.zip', 'b.zip'])).toEqual({
      code: 'unexpected-argument',
      message: "'e2e' takes one path or glob, got 2",
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['e2e']?.usage,
    });
  });

  /** `--flow` becomes a directory under `runs/`, and it is the one flow name typed on a command line. */
  it('rejects a flow name that could not be a directory', () => {
    expect(err(['e2e', '--from', 'trace', 'a.zip', '--flow', '../etc/passwd'])).toEqual({
      code: 'invalid-flow-name',
      message: "invalid flow name '../etc/passwd'",
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'use letters, digits, dot, dash or underscore, e.g. checkout',
    });
    expect(err(['e2e', '--from', 'trace', 'a.zip', '--flow', 'a/b']).code).toBe(
      'invalid-flow-name',
    );
  });

  it('routes `vdiff e2e --help` to the help topic', () => {
    expect(ok(['e2e', '--help'])).toEqual({ kind: 'help', topic: 'e2e', json: false });
  });
});

describe('parseArgs — the --e2e timeline switch (e2e spec §6, D27)', () => {
  it('carries --e2e onto runs and diff', () => {
    expect(ok(['runs', 'weather', '--e2e'])).toEqual({
      kind: 'runs',
      flow: 'weather',
      variants: false,
      e2e: true,
      json: false,
    });
    expect(ok(['diff', 'weather', '--e2e'])).toEqual({
      kind: 'diff',
      flow: 'weather',
      e2e: true,
      json: false,
    });
  });

  /**
   * §2, explicit non-goals: "No scenarios or variants over e2e runs. Both operate during capture,
   * and e2e capture already happened." So these are not filters that match nothing — they are
   * requests for something that cannot exist, and are refused rather than silently emptied.
   */
  it('refuses --e2e with --variants, naming why they cannot overlap', () => {
    expect(err(['runs', 'weather', '--e2e', '--variants'])).toEqual({
      code: 'conflicting-flags',
      message:
        "'--e2e' and '--variants' list two timelines that cannot overlap: a variant is applied" +
        ' during capture, and an e2e run was captured by the test suite',
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['runs']?.usage,
    });
  });

  it('refuses --e2e with a named scenario, on runs and on diff', () => {
    expect(err(['runs', 'weather', '--e2e', '--scenario', 'empty-forecast'])).toEqual({
      code: 'conflicting-flags',
      message:
        "'--e2e' and '--scenario empty-forecast' cannot combine: a scenario shapes responses" +
        ' during capture, and an e2e run was captured by the test suite',
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['runs']?.usage,
    });
    expect(err(['diff', 'weather', '--e2e', '--scenario', 'empty-forecast']).code).toBe(
      'conflicting-flags',
    );
  });

  it('refuses --e2e with a named variant on diff', () => {
    expect(err(['diff', 'weather', '--e2e', '--variant', 'denser-forecast'])).toEqual({
      code: 'conflicting-flags',
      message:
        "'--e2e' and '--variant denser-forecast' cannot combine: a variant is applied during" +
        ' capture, and an e2e run was captured by the test suite',
      exitCode: EXIT.CONFIG_ERROR,
      hint: COMMANDS['diff']?.usage,
    });
  });

  /**
   * `none` is the value the store records for a run captured without a scenario or a variant, and
   * every ingested run is one of those. Refusing it would forbid the one combination that is
   * exactly true of an e2e run.
   */
  it('accepts `none` alongside --e2e, because that is what an ingested run records', () => {
    expect(ok(['runs', 'weather', '--e2e', '--scenario', 'none'])).toMatchObject({
      e2e: true,
      scenario: 'none',
    });
    expect(ok(['diff', 'weather', '--e2e', '--variant', 'none'])).toMatchObject({
      e2e: true,
      variant: 'none',
    });
  });
});
