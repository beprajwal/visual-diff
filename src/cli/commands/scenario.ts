/**
 * `vdiff scenario new|check|list` — author, validate and enumerate response scenarios
 * (mocking spec §7).
 *
 * The three commands mirror `flow new|check` deliberately: a scenario is data with the same
 * lifecycle as a flow spec (D11), stored beside it under `.visual-diff/scenarios/` and read out of
 * git history at the target SHA during historical replay (D4). Anything that would only be true of
 * one of the two would be a bug in one of them.
 *
 * `check` is the fast feedback loop for an agent authoring a scenario: it parses and validates and
 * exits 2 with file, line and the offending key (mocking spec §8) without starting a browser, a dev
 * server or a run. Those messages *are* the feature's user interface, so they are printed verbatim
 * and carried into the `--json` envelope's `error.issues` unchanged.
 *
 * `list` is the one place that reads every scenario at once. An unparseable file there is reported
 * as a warning naming the file and the command that explains it, and its row is omitted — never
 * skipped silently, because a scenario missing from the list looks exactly like a scenario that was
 * never written.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  DEFAULTS,
  type ScenarioCheckResult,
  type ScenarioListResult,
  type ScenarioName,
  type ScenarioNewResult,
  type ScenarioSpec,
  type ScenarioSummary,
  type ValidationIssue,
} from '../../types.js';
import type { CommandContext, CommandResult } from '../command.js';
import { configError } from '../error.js';
import { table } from '../output.js';
import { scenarioYaml } from '../templates.js';

/** Path of a scenario file relative to the `.visual-diff` directory (mocking spec §5, §7). */
export function scenarioStorePath(name: ScenarioName): string {
  return `scenarios/${name}.yaml`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path of one scenario file, located exactly as `flow check` locates a flow spec. */
async function locate(ctx: CommandContext, name: ScenarioName): Promise<string> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  return ctx.ports.scenarioFile(config, name);
}

/** Projects a parsed spec onto the summary row `list` and `check` both report. */
export function toScenarioSummary(spec: ScenarioSpec): ScenarioSummary {
  const summary: ScenarioSummary = {
    name: spec.scenario,
    mode: spec.mode,
    ruleCount: spec.rules.length,
    path: scenarioStorePath(spec.scenario),
  };
  if (spec.description !== undefined) summary.description = spec.description;
  return summary;
}

function invalidScenario(name: ScenarioName, issues: ValidationIssue[]): never {
  const count = issues.length;
  throw configError(
    'scenario-invalid',
    `scenario '${name}' is invalid: ${count} ${count === 1 ? 'issue' : 'issues'}`,
    { issues },
  );
}

/* ------------------------------------------------------------------ new */

export async function scenarioNew(
  ctx: CommandContext,
  name: ScenarioName,
): Promise<CommandResult<ScenarioNewResult>> {
  const file = await locate(ctx, name);

  if (await exists(file)) {
    throw configError('scenario-exists', `scenario '${name}' already exists at ${file}`, {
      hint: `vdiff scenario check ${name}`,
    });
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, scenarioYaml(name), 'utf8');

  return {
    data: {
      scenario: name,
      path: scenarioStorePath(name),
      mode: DEFAULTS.scenarioMode,
    },
    human: [
      `created  ${file}`,
      '',
      `Edit the rules, then \`vdiff scenario check ${name}\` to validate without running.`,
      `Capture under it with \`vdiff run <flow> --scenario ${name}\`.`,
    ],
  };
}

/* ------------------------------------------------------------------ check */

export async function scenarioCheck(
  ctx: CommandContext,
  name: ScenarioName,
): Promise<CommandResult<ScenarioCheckResult>> {
  const file = await locate(ctx, name);

  if (!(await exists(file))) {
    throw configError('scenario-missing', `no scenario '${name}' at ${file}`, {
      hint: `vdiff scenario new ${name}`,
    });
  }

  const parsed = await ctx.ports.parseScenarioFile(file);
  if (!parsed.ok) invalidScenario(name, parsed.issues);

  const summary = toScenarioSummary(parsed.value);
  const rules = parsed.value.rules;

  const human = [
    `scenario '${name}' is valid`,
    `  mode: ${summary.mode}`,
    `  ${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}: ${rules
      .map((rule) => rule.id)
      .join(', ')}`,
  ];
  if (summary.description !== undefined) human.push(`  ${summary.description}`);

  return {
    data: { scenario: summary, warnings: parsed.warnings },
    human,
    warnings: parsed.warnings.map((issue) => `${issue.code}: ${issue.message}`),
  };
}

/* ------------------------------------------------------------------ list */

export async function scenarioList(
  ctx: CommandContext,
): Promise<CommandResult<ScenarioListResult>> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const dir = await ctx.ports.scenariosDir(config);
  const names = await ctx.ports.listScenarios(config);

  const scenarios: ScenarioSummary[] = [];
  const warnings: string[] = [];

  for (const name of names) {
    const parsed = await ctx.ports.parseScenarioFile(await ctx.ports.scenarioFile(config, name));
    if (!parsed.ok) {
      const count = parsed.issues.length;
      warnings.push(
        `scenario '${name}' is invalid: ${count} ${count === 1 ? 'issue' : 'issues'}` +
          ` — vdiff scenario check ${name}`,
      );
      continue;
    }
    scenarios.push(toScenarioSummary(parsed.value));
  }

  const human =
    scenarios.length === 0
      ? [
          names.length === 0
            ? `no scenarios in ${dir} — \`vdiff scenario new <name>\``
            : `no valid scenarios in ${dir}`,
        ]
      : table(
          ['SCENARIO', 'MODE', 'RULES', 'DESCRIPTION'],
          scenarios.map((scenario) => [
            scenario.name,
            scenario.mode,
            String(scenario.ruleCount),
            scenario.description ?? '',
          ]),
        );

  return { data: { scenarios }, human, warnings };
}
