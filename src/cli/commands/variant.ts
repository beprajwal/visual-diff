/**
 * `vdiff variant new|check|list` — author, validate and enumerate proposed UI changes
 * (variants spec §6).
 *
 * A deliberate mirror of `vdiff scenario new|check|list`, down to the error codes and the shape of
 * the messages. A variant is the second axis of run identity and has the same lifecycle as the
 * first: data, committed beside the flow specs, read out of git history at the target SHA during
 * historical replay (D4, variants spec §4 "Storage"). Anything true of one and not the other would
 * be a bug in one of them.
 *
 * `check` is the authoring loop: it parses and validates and exits 2 with file, line and the
 * offending key (variants spec §7) without starting a browser, a dev server or a run. Those
 * messages *are* the feature's user interface, so they are printed verbatim and carried into the
 * `--json` envelope's `error.issues` unchanged.
 *
 * `list` is the one place that reads every variant at once. An unparseable file there is reported
 * as a warning naming the file and the command that explains it, and its row is omitted — never
 * skipped silently, because a variant missing from the list looks exactly like one never written.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ValidationIssue } from '../../types.js';
import type { CommandContext, CommandResult } from '../command.js';
import { configError } from '../error.js';
import { table } from '../output.js';
import { variantYaml } from '../templates.js';
import {
  toVariantSummary,
  variantStorePath,
  type VariantCheckResult,
  type VariantListResult,
  type VariantName,
  type VariantNewResult,
  type VariantSummary,
} from '../variant.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path of one variant file, located exactly as `scenario check` locates a scenario. */
async function locate(ctx: CommandContext, name: VariantName): Promise<string> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  return ctx.ports.variantFile(config, name);
}

function invalidVariant(name: VariantName, issues: ValidationIssue[]): never {
  const count = issues.length;
  throw configError(
    'variant-invalid',
    `variant '${name}' is invalid: ${count} ${count === 1 ? 'issue' : 'issues'}`,
    { issues },
  );
}

/* ------------------------------------------------------------------ new */

export async function variantNew(
  ctx: CommandContext,
  name: VariantName,
): Promise<CommandResult<VariantNewResult>> {
  const file = await locate(ctx, name);

  if (await exists(file)) {
    throw configError('variant-exists', `variant '${name}' already exists at ${file}`, {
      hint: `vdiff variant check ${name}`,
    });
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, variantYaml(name), 'utf8');

  return {
    data: { variant: name, path: variantStorePath(name) },
    human: [
      `created  ${file}`,
      '',
      `Edit the rules, then \`vdiff variant check ${name}\` to validate without running.`,
      `Preview it with \`vdiff run <flow> --variant ${name}\`.`,
    ],
  };
}

/* ------------------------------------------------------------------ check */

export async function variantCheck(
  ctx: CommandContext,
  name: VariantName,
): Promise<CommandResult<VariantCheckResult>> {
  const file = await locate(ctx, name);

  if (!(await exists(file))) {
    throw configError('variant-missing', `no variant '${name}' at ${file}`, {
      hint: `vdiff variant new ${name}`,
    });
  }

  const parsed = await ctx.ports.parseVariantFile(file);
  if (!parsed.ok) invalidVariant(name, parsed.issues);

  const summary = toVariantSummary(parsed.value);
  const rules = parsed.value.rules;

  const human = [
    `variant '${name}' is valid`,
    `  ${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}: ${rules
      .map((rule) => rule.id)
      .join(', ')}`,
    `  verbs: ${summary.verbs.join(', ')}`,
  ];
  if (summary.description !== undefined) human.push(`  ${summary.description}`);

  return {
    data: { variant: summary, warnings: parsed.warnings },
    human,
    warnings: parsed.warnings.map((issue) => `${issue.code}: ${issue.message}`),
  };
}

/* ------------------------------------------------------------------ list */

export async function variantList(ctx: CommandContext): Promise<CommandResult<VariantListResult>> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const dir = await ctx.ports.variantsDir(config);
  const names = await ctx.ports.listVariants(config);

  const variants: VariantSummary[] = [];
  const warnings: string[] = [];

  for (const name of names) {
    const parsed = await ctx.ports.parseVariantFile(await ctx.ports.variantFile(config, name));
    if (!parsed.ok) {
      const count = parsed.issues.length;
      warnings.push(
        `variant '${name}' is invalid: ${count} ${count === 1 ? 'issue' : 'issues'}` +
          ` — vdiff variant check ${name}`,
      );
      continue;
    }
    variants.push(toVariantSummary(parsed.value));
  }

  const human =
    variants.length === 0
      ? [
          names.length === 0
            ? `no variants in ${dir} — \`vdiff variant new <name>\``
            : `no valid variants in ${dir}`,
        ]
      : table(
          ['VARIANT', 'RULES', 'VERBS', 'DESCRIPTION'],
          variants.map((variant) => [
            variant.name,
            String(variant.ruleCount),
            variant.verbs.join(' '),
            variant.description ?? '',
          ]),
        );

  return { data: { variants }, human, warnings };
}
