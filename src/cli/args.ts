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

import {
  EXIT,
  SCENARIO_NONE,
  type CliError,
  type NetworkMode,
  type RunId,
  type ScenarioName,
  type ViewportId,
} from '../types.js';
import { E2E_SOURCE_FORMATS, isE2eSourceFormat, type E2eSourceFormat } from './e2e.js';
import { VARIANT_NONE, type VariantName } from './variant.js';

export type Invocation =
  | { kind: 'help'; topic?: string; json: boolean }
  | { kind: 'version'; json: boolean }
  | { kind: 'init'; json: boolean }
  | { kind: 'flow-new'; name: string; json: boolean }
  | { kind: 'flow-check'; name: string; json: boolean }
  | { kind: 'scenario-new'; name: ScenarioName; json: boolean }
  | { kind: 'scenario-check'; name: ScenarioName; json: boolean }
  | { kind: 'scenario-list'; json: boolean }
  | { kind: 'variant-new'; name: VariantName; json: boolean }
  | { kind: 'variant-check'; name: VariantName; json: boolean }
  | { kind: 'variant-list'; json: boolean }
  | {
      kind: 'run';
      flow: string;
      at?: string;
      viewports?: ViewportId[];
      network?: NetworkMode;
      /** Capture under this scenario (mocking spec §7). Never `none`: that is the absence of one. */
      scenario?: ScenarioName;
      /** Capture under this variant (variants spec §6). Never `none`, for the same reason. */
      variant?: VariantName;
      /** Promote this variant run into the permanent timeline (D24). Only legal with a variant. */
      keep: boolean;
      continueOnError: boolean;
      noScrub: boolean;
      json: boolean;
    }
  | {
      /**
       * `vdiff e2e --from trace <path|glob> [--flow <name>]` — ingest artifacts a test suite already
       * produced (e2e spec §6). Nothing is run: this reads files that exist (D25).
       */
      kind: 'e2e-ingest';
      from: E2eSourceFormat;
      /** Path or glob, exactly as typed. The ingestion module expands it, not the CLI. */
      pattern: string;
      /** Override the flow name derived from the test title (D26). */
      flow?: string;
      json: boolean;
    }
  | {
      /** `vdiff e2e list --from trace <path|glob>` — what would be ingested. Writes nothing (§6). */
      kind: 'e2e-list';
      from: E2eSourceFormat;
      pattern: string;
      flow?: string;
      json: boolean;
    }
  | {
      kind: 'runs';
      flow: string;
      scenario?: ScenarioName;
      /**
       * List the variant runs instead of the regression timeline (variants spec §5). Variant runs
       * are exploratory and live in their own retention bucket, so the default timeline excludes
       * them; this is how you go and look at them.
       */
      variants: boolean;
      /**
       * List the ingested runs instead of the replay timeline (e2e spec §6, D27). Same shape as
       * `variants` and for the same reason: e2e runs are a separate timeline with its own retention
       * bucket (§7), so the default excludes them and this is how you go and look at them.
       */
      e2e: boolean;
      json: boolean;
    }
  | {
      kind: 'diff';
      flow: string;
      base?: RunId;
      head?: RunId;
      /** Restrict run selection to this scenario; `none` selects runs captured without one. */
      scenario?: ScenarioName;
      /** Restrict run selection to this variant; `none` selects runs captured without one. */
      variant?: VariantName;
      /**
       * Resolve the default pair over the ingested timeline instead of the replay one (D27).
       *
       * It narrows *both* ends, exactly as `--scenario` does: e2e pairs with e2e. Naming two runs
       * outright still crosses the axis if that is what was asked for, and the pair is then flagged.
       */
      e2e: boolean;
      json: boolean;
    }
  | { kind: 'serve'; port?: number; open: boolean; json: boolean }
  | { kind: 'feedback'; ack: boolean; json: boolean }
  | { kind: 'pin'; flow?: string; runId: RunId; json: boolean }
  | { kind: 'prune'; flow?: string; runId: RunId; json: boolean }
  | {
      kind: 'install';
      /**
       * Harness id, validated against the adapter registry by the command, not here.
       * Absent under `--list`, which describes every registered harness instead of writing one,
       * and optional under `--check`, which reports every harness when given none.
       */
      harness?: string;
      dir?: string;
      force: boolean;
      dryRun: boolean;
      /**
       * Write the user-level target instead of the project-local one (D16). Absent rather than
       * `false` when unasked, so the invocation of a plain `vdiff install <harness>` stays the
       * object it has always been.
       */
      global?: true;
      /** Print what would ship, for every harness, and write nothing. */
      list?: boolean;
      /** Report drift per harness and per scope, writing nothing. Always exit 0 (§5, "Drift"). */
      check?: true;
      json: boolean;
    }
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
  scenario: {
    usage: 'vdiff scenario new|check <name> | vdiff scenario list',
    summary: 'scaffold / validate / enumerate response scenarios',
    flags: flags(),
    // `list` takes no name, so the arity check moves into the case below and `scenario new` keeps
    // its own `missing-argument` message.
    minPositionals: 1,
    maxPositionals: 2,
  },
  variant: {
    usage: 'vdiff variant new|check <name> | vdiff variant list',
    summary: 'scaffold / validate / enumerate proposed UI changes',
    // `list` takes no name, exactly as under `scenario`.
    flags: flags(),
    minPositionals: 1,
    maxPositionals: 2,
  },
  run: {
    usage:
      'vdiff run <flow> [--at <ref>] [--scenario <name>] [--variant <name>] [--keep] [--viewport <WxH>] [--record|--no-net] [--continue-on-error] [--no-scrub]',
    summary: 'replay a flow at the working tree or a historical revision',
    flags: flags({
      at: { type: 'string' },
      scenario: { type: 'string' },
      variant: { type: 'string' },
      keep: { type: 'boolean' },
      viewport: { type: 'list' },
      record: { type: 'boolean' },
      'no-net': { type: 'boolean' },
      'continue-on-error': { type: 'boolean' },
      'no-scrub': { type: 'boolean' },
    }),
    minPositionals: 1,
    maxPositionals: 1,
  },
  e2e: {
    usage:
      'vdiff e2e --from trace <path|glob> [--flow <name>] | vdiff e2e list --from trace <path|glob>',
    summary: "ingest a test suite's Playwright traces as runs",
    // `list` is a leading positional rather than a flag, matching `flow`/`scenario`/`variant`, so
    // the arity check moves into the case below and each form keeps its own message.
    flags: flags({ from: { type: 'string' }, flow: { type: 'string' } }),
    minPositionals: 1,
    maxPositionals: 2,
  },
  runs: {
    usage: 'vdiff runs <flow> [--scenario <name>] [--variants] [--e2e]',
    summary: 'timeline: SHA, dirty, scenario, status, findings count',
    flags: flags({
      scenario: { type: 'string' },
      variants: { type: 'boolean' },
      e2e: { type: 'boolean' },
    }),
    minPositionals: 1,
    maxPositionals: 1,
  },
  diff: {
    usage: 'vdiff diff <flow> [base] [head] [--scenario <name>] [--variant <name>] [--e2e]',
    summary: 'compute and print summary (defaults: N-1 vs N)',
    flags: flags({
      scenario: { type: 'string' },
      variant: { type: 'string' },
      e2e: { type: 'boolean' },
    }),
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
  install: {
    usage:
      'vdiff install <harness> [--global] [--dir <path>] [--force] [--dry-run] | ' +
      'vdiff install --list [--dir <path>] | vdiff install --check [<harness>] [--dir <path>]',
    summary: 'write the skill and command files for an agent harness',
    // `--list` takes no harness, so the arity check moves into the case below — which keeps the
    // `missing-argument` error code identical for a bare `vdiff install`.
    flags: flags({
      dir: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      global: { type: 'boolean' },
      list: { type: 'boolean' },
      check: { type: 'boolean' },
    }),
    minPositionals: 0,
    maxPositionals: 1,
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
    case 'scenario-new':
      return 'scenario new';
    case 'scenario-check':
      return 'scenario check';
    case 'scenario-list':
      return 'scenario list';
    case 'variant-new':
      return 'variant new';
    case 'variant-check':
      return 'variant check';
    case 'variant-list':
      return 'variant list';
    case 'e2e-ingest':
      return 'e2e';
    case 'e2e-list':
      return 'e2e list';
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
 * A scenario or variant name becomes a filename under `.visual-diff/`, so it is restricted here.
 * One regex for both: the two dimensions are stored the same way and a name legal as one and
 * illegal as the other would be a difference nobody could explain.
 */
const SPEC_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
/**
 * A flow name is a *directory* name under `runs/`, so `--flow` is checked against the same shape the
 * store accepts rather than passed through.
 *
 * Only `vdiff e2e --flow` validates here, and deliberately so: everywhere else the flow name comes
 * from a file the user already created, and a name the store will refuse fails when that file is
 * read, naming the file. `--flow` has no file behind it — it invents a name on the command line —
 * so an unusable one has to be caught before ingestion writes anything under it.
 */
const FLOW_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * How a name is being used, which decides whether the reserved name `none` is legal.
 *
 * `none` is what `meta.json` records for a run captured *without* a scenario (mocking spec §6, §11)
 * or without a variant (variants spec §5). As a filename or a capture argument it is therefore
 * meaningless and rejected; as a *filter* over stored runs it is the real recorded value, so
 * `vdiff runs checkout --scenario none` selects exactly the runs that had no scenario. Silently
 * accepting it in the first two roles would create a scenario — or a variant — that nobody can tell
 * apart from its own absence.
 */
type SpecNameRole = 'capture' | 'file' | 'filter';

/** Which axis of run identity a name belongs to. The messages name it, so it travels explicitly. */
type SpecDimension = 'scenario' | 'variant';

const DIMENSION_HINT: Record<SpecDimension, string> = {
  scenario: 'use letters, digits, dot, dash or underscore, e.g. empty-forecast',
  variant: 'use letters, digits, dot, dash or underscore, e.g. denser-forecast',
};

/** Returns a failure outcome when the name is unusable in this role, or null when it is fine. */
function checkSpecName(
  dimension: SpecDimension,
  command: string,
  name: string,
  role: SpecNameRole,
): ParseOutcome | null {
  const reserved = dimension === 'scenario' ? SCENARIO_NONE : VARIANT_NONE;
  if (name === reserved) {
    if (role === 'filter') return null;
    return fail(
      command,
      `reserved-${dimension}-name`,
      `'${reserved}' is the reserved ${dimension} name for a run captured without one`,
      role === 'capture'
        ? `omit --${dimension} to capture without a ${dimension}`
        : `pick another name; '${reserved}' can never be a ${dimension} file`,
    );
  }
  if (name.length === 0 || !SPEC_NAME_RE.test(name) || name.includes('..')) {
    return fail(
      command,
      `invalid-${dimension}-name`,
      `invalid ${dimension} name '${name}'`,
      DIMENSION_HINT[dimension],
    );
  }
  return null;
}

const checkScenarioName = (
  command: string,
  name: string,
  role: SpecNameRole,
): ParseOutcome | null => checkSpecName('scenario', command, name, role);

const checkVariantName = (command: string, name: string, role: SpecNameRole): ParseOutcome | null =>
  checkSpecName('variant', command, name, role);

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

    case 'scenario': {
      const sub = positionals[0] as string;
      if (sub === 'list') {
        if (positionals.length > 1) {
          return fail(
            'scenario',
            'unexpected-argument',
            `'scenario list' enumerates every scenario and takes no name`,
            spec.usage,
          );
        }
        return { ok: true, value: { kind: 'scenario-list', json } };
      }
      if (sub !== 'new' && sub !== 'check') {
        return fail(
          'scenario',
          'unknown-subcommand',
          `unknown subcommand 'scenario ${sub}'`,
          spec.usage,
        );
      }
      const name = positionals[1];
      if (name === undefined) {
        return fail(
          'scenario',
          'missing-argument',
          `'scenario ${sub}' requires a scenario name`,
          spec.usage,
        );
      }
      const invalid = checkScenarioName('scenario', name, 'file');
      if (invalid !== null) return invalid;
      return {
        ok: true,
        value:
          sub === 'new'
            ? { kind: 'scenario-new', name, json }
            : { kind: 'scenario-check', name, json },
      };
    }

    case 'variant': {
      const sub = positionals[0] as string;
      if (sub === 'list') {
        if (positionals.length > 1) {
          return fail(
            'variant',
            'unexpected-argument',
            `'variant list' enumerates every variant and takes no name`,
            spec.usage,
          );
        }
        return { ok: true, value: { kind: 'variant-list', json } };
      }
      if (sub !== 'new' && sub !== 'check') {
        return fail(
          'variant',
          'unknown-subcommand',
          `unknown subcommand 'variant ${sub}'`,
          spec.usage,
        );
      }
      const name = positionals[1];
      if (name === undefined) {
        return fail(
          'variant',
          'missing-argument',
          `'variant ${sub}' requires a variant name`,
          spec.usage,
        );
      }
      const invalid = checkVariantName('variant', name, 'file');
      if (invalid !== null) return invalid;
      return {
        ok: true,
        value:
          sub === 'new'
            ? { kind: 'variant-new', name, json }
            : { kind: 'variant-check', name, json },
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
      const rawScenario = values['scenario'];
      // Recording captures reality and a scenario alters it, so a HAR blending both is neither
      // (mocking spec §2). This is a hard error rather than a precedence rule.
      if (record && typeof rawScenario === 'string') {
        return fail(
          'run',
          'conflicting-flags',
          "'--record' and '--scenario' are mutually exclusive: recording captures reality, a scenario alters it",
          'record the flow first, then replay it under a scenario',
        );
      }
      if (typeof rawScenario === 'string') {
        const invalid = checkScenarioName('run', rawScenario, 'capture');
        if (invalid !== null) return invalid;
      }
      const rawVariant = values['variant'];
      if (typeof rawVariant === 'string') {
        const invalid = checkVariantName('run', rawVariant, 'capture');
        if (invalid !== null) return invalid;
      }
      const keep = bool(values, 'keep');
      // `--keep` promotes a variant run out of its own retention bucket and into the permanent
      // timeline (D24). A run captured without a variant is already in that timeline, so asking to
      // keep it is a misunderstanding of what the flag does rather than a harmless no-op.
      if (keep && typeof rawVariant !== 'string') {
        return fail(
          'run',
          'keep-without-variant',
          "'--keep' promotes a variant run into the permanent timeline, and this run has no variant",
          'pass --variant <name>, or drop --keep: runs without a variant are kept already',
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
        keep,
        continueOnError: bool(values, 'continue-on-error'),
        noScrub: bool(values, 'no-scrub'),
        json,
      };
      const at = values['at'];
      if (typeof at === 'string') invocation.at = at;
      if (typeof rawScenario === 'string') invocation.scenario = rawScenario;
      if (typeof rawVariant === 'string') invocation.variant = rawVariant;
      if (viewports !== undefined) invocation.viewports = viewports;
      if (record) invocation.network = 'record';
      if (noNet) invocation.network = 'off';
      return { ok: true, value: invocation };
    }

    case 'e2e': {
      // `list` is recognised as a subcommand whenever it is the first positional. A trace archive
      // named exactly `list` is unreachable this way; that is the same trade `flow`, `scenario` and
      // `variant` already make, and `vdiff e2e list ./list` still reaches it.
      const listing = positionals[0] === 'list';
      const label = listing ? 'e2e list' : 'e2e';
      const pattern = listing ? positionals[1] : positionals[0];

      if (!listing && positionals.length > 1) {
        return fail(
          'e2e',
          'unexpected-argument',
          `'e2e' takes one path or glob, got ${positionals.length}`,
          spec.usage,
        );
      }

      const rawFrom = values['from'];
      if (typeof rawFrom !== 'string') {
        return fail(
          label,
          'missing-flag-value',
          `'${label}' requires --from <format>, naming the artifact format to read`,
          `supported formats: ${E2E_SOURCE_FORMATS.join(', ')}`,
        );
      }
      if (!isE2eSourceFormat(rawFrom)) {
        return fail(
          label,
          'unknown-e2e-source',
          `unknown artifact format '${rawFrom}'`,
          `supported formats: ${E2E_SOURCE_FORMATS.join(', ')}`,
        );
      }
      if (pattern === undefined || pattern === '') {
        return fail(
          label,
          'missing-argument',
          `'${label}' requires a path or glob naming the archives to read`,
          spec.usage,
        );
      }

      const invocation: Extract<Invocation, { kind: 'e2e-ingest' | 'e2e-list' }> = listing
        ? { kind: 'e2e-list', from: rawFrom, pattern, json }
        : { kind: 'e2e-ingest', from: rawFrom, pattern, json };

      const rawFlow = values['flow'];
      if (typeof rawFlow === 'string') {
        if (rawFlow === '' || !FLOW_NAME_RE.test(rawFlow) || rawFlow.includes('..')) {
          return fail(
            label,
            'invalid-flow-name',
            `invalid flow name '${rawFlow}'`,
            'use letters, digits, dot, dash or underscore, e.g. checkout',
          );
        }
        invocation.flow = rawFlow;
      }
      return { ok: true, value: invocation };
    }

    case 'runs': {
      const wantsE2e = bool(values, 'e2e');
      const wantsVariants = bool(values, 'variants');
      // Scenarios and variants both operate *during capture*, and an e2e capture already happened
      // (§2, explicit non-goals). Combining them is not a filter that matches nothing, it is a
      // request for something that cannot exist, so it is refused rather than silently emptied.
      if (wantsE2e && wantsVariants) {
        return fail(
          'runs',
          'conflicting-flags',
          "'--e2e' and '--variants' list two timelines that cannot overlap: a variant is applied during capture, and an e2e run was captured by the test suite",
          spec.usage,
        );
      }
      const invocation: Extract<Invocation, { kind: 'runs' }> = {
        kind: 'runs',
        flow: positionals[0] as string,
        variants: wantsVariants,
        e2e: wantsE2e,
        json,
      };
      const scenario = values['scenario'];
      if (typeof scenario === 'string') {
        const invalid = checkScenarioName('runs', scenario, 'filter');
        if (invalid !== null) return invalid;
        if (wantsE2e && scenario !== SCENARIO_NONE) {
          return fail(
            'runs',
            'conflicting-flags',
            `'--e2e' and '--scenario ${scenario}' cannot combine: a scenario shapes responses during capture, and an e2e run was captured by the test suite`,
            spec.usage,
          );
        }
        invocation.scenario = scenario;
      }
      return { ok: true, value: invocation };
    }

    case 'diff': {
      const wantsE2e = bool(values, 'e2e');
      const invocation: Extract<Invocation, { kind: 'diff' }> = {
        kind: 'diff',
        flow: positionals[0] as string,
        e2e: wantsE2e,
        json,
      };
      const base = positionals[1];
      const head = positionals[2];
      if (base !== undefined) invocation.base = base;
      if (head !== undefined) invocation.head = head;
      const scenario = values['scenario'];
      if (typeof scenario === 'string') {
        const invalid = checkScenarioName('diff', scenario, 'filter');
        if (invalid !== null) return invalid;
        if (wantsE2e && scenario !== SCENARIO_NONE) {
          return fail(
            'diff',
            'conflicting-flags',
            `'--e2e' and '--scenario ${scenario}' cannot combine: a scenario shapes responses during capture, and an e2e run was captured by the test suite`,
            spec.usage,
          );
        }
        invocation.scenario = scenario;
      }
      const variant = values['variant'];
      if (typeof variant === 'string') {
        const invalid = checkVariantName('diff', variant, 'filter');
        if (invalid !== null) return invalid;
        // Same refusal as `runs --e2e --variants`, and for the same reason (§2): a variant is
        // applied to the rendered page during capture, and an e2e capture already happened.
        if (wantsE2e && variant !== VARIANT_NONE) {
          return fail(
            'diff',
            'conflicting-flags',
            `'--e2e' and '--variant ${variant}' cannot combine: a variant is applied during capture, and an e2e run was captured by the test suite`,
            spec.usage,
          );
        }
        invocation.variant = variant;
      }
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

    case 'install': {
      const list = bool(values, 'list');
      const check = bool(values, 'check');
      const global = bool(values, 'global');
      const force = bool(values, 'force');
      const dryRun = bool(values, 'dry-run');
      const harness = positionals[0];

      if (list && check) {
        return fail(
          'install',
          'conflicting-flags',
          "'--list' and '--check' describe different things: what would ship, and what is installed",
          spec.usage,
        );
      }
      if (!list && !check && harness === undefined) {
        return fail(
          'install',
          'missing-argument',
          `'install' is missing a required argument`,
          spec.usage,
        );
      }
      if (list && harness !== undefined) {
        return fail(
          'install',
          'conflicting-flags',
          "'--list' describes every harness and takes no harness argument",
          spec.usage,
        );
      }
      // `--check` reports both scopes precisely so a shadowed global copy stays visible (D16);
      // narrowing it to one scope would hide the thing it exists to show.
      if (check && global) {
        return fail(
          'install',
          'conflicting-flags',
          "'--check' reports every scope and takes no '--global'",
          spec.usage,
        );
      }
      // Nothing is written under `--list` or `--check`, so a write flag is a misunderstanding
      // rather than a no-op worth swallowing.
      if ((list || check) && (force || dryRun)) {
        const asked = force ? '--force' : '--dry-run';
        const mode = list ? '--list' : '--check';
        return fail(
          'install',
          'conflicting-flags',
          `'${mode}' writes nothing, so '${asked}' has nothing to act on`,
          spec.usage,
        );
      }

      const invocation: Extract<Invocation, { kind: 'install' }> = {
        kind: 'install',
        force,
        dryRun,
        json,
      };
      if (harness !== undefined) invocation.harness = harness;
      if (list) invocation.list = true;
      if (check) invocation.check = true;
      if (global) invocation.global = true;
      const dir = values['dir'];
      if (typeof dir === 'string') invocation.dir = dir;
      return { ok: true, value: invocation };
    }

    case 'install-browser':
      return { ok: true, value: { kind: 'install-browser', json } };

    default:
      return fail('vdiff', 'unknown-command', `unknown command '${first}'`, 'vdiff --help');
  }
}
