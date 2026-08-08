/**
 * `vdiff flow new|check <name>` — scaffold or validate a spec without running it (spec §9).
 *
 * `check` is the fast feedback loop for an agent authoring a flow: it parses and validates and
 * exits 2 with file, line and the offending key on failure (spec §10, row 1), without starting a
 * browser or a dev server.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CommandContext, CommandResult } from '../command.js';
import { configError } from '../error.js';
import type { FlowCheckData, FlowNewData } from '../shapes.js';
import { flowYaml } from '../templates.js';

/** A flow name becomes a filename and a store directory, so it is restricted at the boundary. */
const FLOW_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function assertFlowName(name: string): void {
  if (!FLOW_NAME_RE.test(name) || name.includes('..')) {
    throw configError(
      'invalid-flow-name',
      `invalid flow name '${name}'`,
      { hint: 'use letters, digits, dot, dash or underscore, e.g. checkout' },
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function flowPath(ctx: CommandContext, name: string): Promise<string> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const store = await ctx.ports.openStore(config);
  return store.flowFile(name);
}

export async function flowNew(
  ctx: CommandContext,
  name: string,
): Promise<CommandResult<FlowNewData>> {
  assertFlowName(name);
  const path = await flowPath(ctx, name);

  if (await exists(path)) {
    throw configError('flow-exists', `flow '${name}' already exists at ${path}`, {
      hint: `vdiff flow check ${name}`,
    });
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, flowYaml(name), 'utf8');

  return {
    data: { flow: name, path, created: true },
    human: [
      `created  ${path}`,
      '',
      `Edit the steps, then \`vdiff flow check ${name}\` to validate without running.`,
    ],
  };
}

export async function flowCheck(
  ctx: CommandContext,
  name: string,
): Promise<CommandResult<FlowCheckData>> {
  assertFlowName(name);
  const path = await flowPath(ctx, name);

  const parsed = await ctx.ports.parseFlowFile(path);
  if (!parsed.ok) {
    const count = parsed.issues.length;
    throw configError(
      'flow-invalid',
      `flow '${name}' is invalid: ${count} ${count === 1 ? 'issue' : 'issues'}`,
      { issues: parsed.issues },
    );
  }

  const spec = parsed.value;
  const stepIds = spec.steps.map((step) => step.id);
  const warnings = parsed.warnings;

  const human = [
    `flow '${name}' is valid`,
    `  ${spec.steps.length} ${spec.steps.length === 1 ? 'step' : 'steps'}: ${stepIds.join(', ')}`,
    `  viewports: ${spec.viewports.join(', ')}`,
    `  network: ${spec.network.mode}${spec.network.har === undefined ? '' : ` (${spec.network.har})`}`,
  ];

  return {
    data: {
      flow: name,
      path,
      valid: true,
      steps: spec.steps.length,
      viewports: spec.viewports,
      stepIds,
      warnings,
    },
    human,
    warnings: warnings.map((issue) => `${issue.code}: ${issue.message}`),
  };
}
