/**
 * cli — argv parsing (spec §9).
 *
 * Dependency-free on purpose: the CLI surface is a published contract across four harnesses, so
 * the exact set of accepted flags is written down here as data rather than inherited from a
 * framework's conventions. Two of those conventions would actively break this surface:
 *
 *  - `--no-x` does *not* negate `--x`. `--no-net` and `--no-scrub` are flags in their own right.
 *  - An unrecognised flag is never passed through. It is a config error, exit 2, because a
 *    silently ignored flag in an agent-generated command line is a wrong answer, not a warning.
 *
 * The parser returns a discriminated `Invocation`, so every command module receives already
 * validated arguments and never re-reads argv.
 */

import { EXIT, type CliError, type NetworkMode, type RunId, type ViewportId } from '../types.js';

export type Invocation =
  | { kind: 'help'; topic?: string; json: boolean }
  | { kind: 'version'; json: boolean }
  | { kind: 'init'; json: boolean }
  | { kind: 'flow-new'; name: string; json: boolean }
  | { kind: 'flow-check'; name: string; json: boolean }
  | {
      kind: 'run';
      flow: string;
      at?: string;
      viewports?: ViewportId[];
      network?: NetworkMode;
      continueOnError: boolean;
      noScrub: boolean;
      json: boolean;
    }
  | { kind: 'runs'; flow: string; json: boolean }
  | { kind: 'diff'; flow: string; base?: RunId; head?: RunId; json: boolean }
  | { kind: 'serve'; port?: number; open: boolean; json: boolean }
  | { kind: 'feedback'; ack: boolean; json: boolean }
  | { kind: 'pin'; flow?: string; runId: RunId; json: boolean }
  | { kind: 'prune'; flow?: string; runId: RunId; json: boolean }
  | { kind: 'install-browser'; json: boolean };

export type ParseOutcome =
  | { ok: true; value: Invocation }
  | { ok: false; error: CliError; command: string };

interface FlagSpec {
  type: 'boolean' | 'string' | 'number' | 'list';
}

export interface CommandSpec {
  usage: string;
  summary: string;
  flags: Record<string, FlagSpec>;
  minPositionals: number;
  maxPositionals: number;
}

/** Accepted by every command (spec §9: "Every command accepts --json"). */
const UNIVERSAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: 'boolean' },
  help: { type: 'boolean' },
};

function flags(extra: Record<string, FlagSpec> = {}): Record<string, FlagSpec> {
  return { ...UNIVERSAL_FLAGS, ...extra };
}

/** The whole CLI surface, exactly as spec §9 documents it. */
export const COMMANDS: Record<string, CommandSpec> = {
  init: {
    usage: 'vdiff init',
    summary: 'scaffold config, gitignore, example flow',
    flags: flags(),
    minPositionals: 0,
    maxPositionals: 0,
  },
  flow: {
    usage: 'vdiff flow new|check <name>',
    summary: 'scaffold / validate a spec without running',
    flags: flags(),
    minPositionals: 1,
    maxPositionals: 2,
  },
  run: {
    usage:
      'vdiff run <flow> [--at <ref>] [--viewport <WxH>] [--record|--no-net] [--continue-on-error] [--no-scrub]',
    summary: 'replay a flow at the working tree or a historical revision',
    flags: flags({
      at: { type: 'string' },
      viewport: { type: 'list' },
      record: { type: 'boolean' },
      'no-net': { type: 'boolean' },
      'continue-on-error': { type: 'boolean' },
      'no-scrub': { type: 'boolean' },
    }),
    minPositionals: 1,
    maxPositionals: 1,
  },
  runs: {
    usage: 'vdiff runs <flow>',
    summary: 'timeline: SHA, dirty, status, findings count',
    flags: flags(),
    minPositionals: 1,
    maxPositionals: 1,
  },
  diff: {
    usage: 'vdiff diff <flow> [base] [head]',
    summary: 'compute and print summary (defaults: N-1 vs N)',
    flags: flags(),
    minPositionals: 1,
    maxPositionals: 3,
  },
  serve: {
    usage: 'vdiff serve [--open] [--port <n>]',
    summary: 'live local report: filmstrip, side-by-side, findings, feedback',
    flags: flags({ open: { type: 'boolean' }, port: { type: 'number' } }),
    minPositionals: 0,
    maxPositionals: 0,
  },
  feedback: {
    usage: 'vdiff feedback [--json] [--ack]',
    summary: 'pull the human comments left in the report',
    flags: flags({ ack: { type: 'boolean' } }),
    minPositionals: 0,
    maxPositionals: 0,
  },
  pin: {
    usage: 'vdiff pin [<flow>] <run>',
    summary: 'exempt a run from retention pruning',
    flags: flags(),
    minPositionals: 1,
    maxPositionals: 2,
  },
  prune: {
    usage: 'vdiff prune [<flow>] <run>',
    summary: "delete a run's blobs, keeping its timeline entry",
    flags: flags(),
    minPositionals: 1,
    maxPositionals: 2,
  },
  'install-browser': {
    usage: 'vdiff install-browser',
    summary: 'download the Chromium build Playwright needs',
    flags: flags(),
    minPositionals: 0,
    maxPositionals: 0,
  },
};

/** Human-facing command label used in the `--json` envelope's `command` field. */
export function commandLabel(invocation: Invocation): string {
  switch (invocation.kind) {
    case 'flow-new':
      return 'flow new';
    case 'flow-check':
      return 'flow check';
    default:
      return invocation.kind;
  }
}

function fail(command: string, code: string, message: string, hint?: string): ParseOutcome {
  const error: CliError = { code, message, exitCode: EXIT.CONFIG_ERROR };
  if (hint !== undefined) error.hint = hint;
  return { ok: false, error, command };
}

const VIEWPORT_RE = /^[1-9]\d{0,4}x[1-9]\d{0,4}$/;
const RUN_ID_RE = /^\d{1,8}$/;

/**
 * `--json` is read straight off argv before parsing, so a *parse* failure can still be reported as
 * a JSON envelope. An agent that asked for JSON must never get a bare human sentence back.
 */
export function wantsJson(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === '--') break;
    if (token === '--json' || token === '--json=true') return true;
  }
  return false;
}

interface TokenizeOk {
  ok: true;
  positionals: string[];
  values: Record<string, string | boolean | string[] | number>;
}

function tokenize(
  command: string,
  spec: CommandSpec,
  argv: readonly string[],
): TokenizeOk | ParseOutcome {
  const positionals: string[] = [];
  const values: Record<string, string | boolean | string[] | number> = {};
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;

    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    if (token === '-h') {
      values['help'] = true;
      continue;
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const flagSpec = spec.flags[name];

      if (flagSpec === undefined) {
        return fail(
          command,
          'unknown-flag',
          `unknown flag '--${name}' for '${command}'`,
          spec.usage,
        );
      }

      if (flagSpec.type === 'boolean') {
        if (inline !== undefined && inline !== 'true' && inline !== 'false') {
          return fail(
            command,
            'invalid-flag-value',
            `flag '--${name}' takes no value`,
            spec.usage,
          );
        }
        values[name] = inline !== 'false';
        continue;
      }

      let raw = inline;
      if (raw === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('-') && next.length > 1)) {
          return fail(
            command,
            'missing-flag-value',
            `flag '--${name}' requires a value`,
            spec.usage,
          );
        }
        raw = next;
        i += 1;
      }

      if (flagSpec.type === 'number') {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          return fail(
            command,
            'invalid-flag-value',
            `flag '--${name}' expects an integer between 0 and 65535, got '${raw}'`,
            spec.usage,
          );
        }
        values[name] = parsed;
        continue;
      }

      if (flagSpec.type === 'list') {
        const previous = values[name];
        const list = Array.isArray(previous) ? previous : [];
        for (const part of raw.split(',')) {
          const trimmed = part.trim();
          if (trimmed.length > 0) list.push(trimmed);
        }
        values[name] = list;
        continue;
      }

      values[name] = raw;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      return fail(command, 'unknown-flag', `unknown flag '${token}' for '${command}'`, spec.usage);
    }

    positionals.push(token);
  }

  // `--help` short-circuits argument checking: `vdiff run --help` must print usage, not complain
  // that the flow name is missing.
  if (values['help'] === true) {
    return { ok: true, positionals, values };
  }

  if (positionals.length < spec.minPositionals) {
    return fail(command, 'missing-argument', `'${command}' is missing a required argument`, spec.usage);
  }
  if (positionals.length > spec.maxPositionals) {
    return fail(
      command,
      'unexpected-argument',
      `'${command}' got ${positionals.length} arguments, expected at most ${spec.maxPositionals}`,
      spec.usage,
    );
  }

  return { ok: true, positionals, values };
}

function bool(values: Record<string, unknown>, name: string): boolean {
  return values[name] === true;
}

/** Parse a full argv tail (`process.argv.slice(2)`). */
export function parseArgs(argv: readonly string[]): ParseOutcome {
  const json = wantsJson(argv);

  if (argv.length === 0) {
    return { ok: true, value: { kind: 'help', json } };
  }

  const first = argv[0] as string;

  if (first === '--help' || first === '-h' || first === 'help') {
    const topic = argv[1];
    if (topic !== undefined && topic in COMMANDS) {
      return { ok: true, value: { kind: 'help', topic, json } };
    }
    return { ok: true, value: { kind: 'help', json } };
  }
  if (first === '--version' || first === '-v') {
    return { ok: true, value: { kind: 'version', json } };
  }
  if (first.startsWith('-')) {
    return fail('vdiff', 'unknown-flag', `unknown flag '${first}'`, 'vdiff --help');
  }

  const spec = COMMANDS[first];
  if (spec === undefined) {
    return fail('vdiff', 'unknown-command', `unknown command '${first}'`, 'vdiff --help');
  }

  const tokens = tokenize(first, spec, argv.slice(1));
  if (!('positionals' in tokens)) return tokens;
  const { positionals, values } = tokens;

  if (bool(values, 'help')) {
    return { ok: true, value: { kind: 'help', topic: first, json } };
  }

  switch (first) {
    case 'init':
      return { ok: true, value: { kind: 'init', json } };

    case 'flow': {
      const sub = positionals[0] as string;
      if (sub !== 'new' && sub !== 'check') {
        return fail(
          'flow',
          'unknown-subcommand',
          `unknown subcommand 'flow ${sub}'`,
          spec.usage,
        );
      }
      const name = positionals[1];
      if (name === undefined) {
        return fail('flow', 'missing-argument', `'flow ${sub}' requires a flow name`, spec.usage);
      }
      return {
        ok: true,
        value: sub === 'new' ? { kind: 'flow-new', name, json } : { kind: 'flow-check', name, json },
      };
    }

    case 'run': {
      const record = bool(values, 'record');
      const noNet = bool(values, 'no-net');
      if (record && noNet) {
        return fail(
          'run',
          'conflicting-flags',
          "'--record' and '--no-net' are mutually exclusive",
          spec.usage,
        );
      }
      const rawViewports = values['viewport'];
      let viewports: ViewportId[] | undefined;
      if (Array.isArray(rawViewports)) {
        for (const viewport of rawViewports) {
          if (!VIEWPORT_RE.test(viewport)) {
            return fail(
              'run',
              'invalid-viewport',
              `invalid viewport '${viewport}', expected WIDTHxHEIGHT such as 1280x800`,
              spec.usage,
            );
          }
        }
        viewports = rawViewports;
      }

      const invocation: Extract<Invocation, { kind: 'run' }> = {
        kind: 'run',
        flow: positionals[0] as string,
        continueOnError: bool(values, 'continue-on-error'),
        noScrub: bool(values, 'no-scrub'),
        json,
      };
      const at = values['at'];
      if (typeof at === 'string') invocation.at = at;
      if (viewports !== undefined) invocation.viewports = viewports;
      if (record) invocation.network = 'record';
      if (noNet) invocation.network = 'off';
      return { ok: true, value: invocation };
    }

    case 'runs':
      return { ok: true, value: { kind: 'runs', flow: positionals[0] as string, json } };

    case 'diff': {
      const invocation: Extract<Invocation, { kind: 'diff' }> = {
        kind: 'diff',
        flow: positionals[0] as string,
        json,
      };
      const base = positionals[1];
      const head = positionals[2];
      if (base !== undefined) invocation.base = base;
      if (head !== undefined) invocation.head = head;
      return { ok: true, value: invocation };
    }

    case 'serve': {
      const invocation: Extract<Invocation, { kind: 'serve' }> = {
        kind: 'serve',
        open: bool(values, 'open'),
        json,
      };
      const port = values['port'];
      if (typeof port === 'number') invocation.port = port;
      return { ok: true, value: invocation };
    }

    case 'feedback':
      return { ok: true, value: { kind: 'feedback', ack: bool(values, 'ack'), json } };

    case 'pin':
    case 'prune': {
      const kind = first === 'pin' ? ('pin' as const) : ('prune' as const);
      const flow = positionals.length === 2 ? (positionals[0] as string) : undefined;
      const runId = (positionals.length === 2 ? positionals[1] : positionals[0]) as string;
      if (!RUN_ID_RE.test(runId)) {
        return fail(
          first,
          'invalid-run-id',
          `invalid run id '${runId}', expected a run number such as 0007`,
          spec.usage,
        );
      }
      return flow === undefined
        ? { ok: true, value: { kind, runId, json } }
        : { ok: true, value: { kind, flow, runId, json } };
    }

    case 'install-browser':
      return { ok: true, value: { kind: 'install-browser', json } };

    default:
      return fail('vdiff', 'unknown-command', `unknown command '${first}'`, 'vdiff --help');
  }
}
