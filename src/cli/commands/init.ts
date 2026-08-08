/**
 * `vdiff init` — scaffold config, gitignore rules, example flow (spec §9).
 *
 * Idempotent: an existing file is reported as skipped, never overwritten, and the gitignore block
 * is appended at most once. Running `init` twice must be safe, because an agent will.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandContext, CommandResult } from '../command.js';
import type { InitData } from '../shapes.js';
import {
  CONFIG_YAML,
  EXAMPLE_FLOW_NAME,
  GITIGNORE_BLOCK,
  GITIGNORE_MARKER,
  flowYaml,
} from '../templates.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function init(ctx: CommandContext): Promise<CommandResult<InitData>> {
  const root = ctx.cwd;
  const dir = join(root, '.visual-diff');
  const flowsDir = join(dir, 'flows');

  await mkdir(flowsDir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  const files: Array<{ path: string; relative: string; content: string }> = [
    { path: join(dir, 'config.yaml'), relative: '.visual-diff/config.yaml', content: CONFIG_YAML },
    {
      path: join(flowsDir, `${EXAMPLE_FLOW_NAME}.yaml`),
      relative: `.visual-diff/flows/${EXAMPLE_FLOW_NAME}.yaml`,
      content: flowYaml(EXAMPLE_FLOW_NAME),
    },
  ];

  for (const file of files) {
    if (await exists(file.path)) {
      skipped.push(file.relative);
      continue;
    }
    await writeFile(file.path, file.content, 'utf8');
    created.push(file.relative);
  }

  const gitignorePath = join(root, '.gitignore');
  let gitignore: InitData['gitignore'];
  if (await exists(gitignorePath)) {
    const current = await readFile(gitignorePath, 'utf8');
    if (current.includes(GITIGNORE_MARKER)) {
      gitignore = 'unchanged';
    } else {
      const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
      await writeFile(gitignorePath, `${current}${separator}\n${GITIGNORE_BLOCK}`, 'utf8');
      gitignore = 'updated';
    }
  } else {
    await writeFile(gitignorePath, GITIGNORE_BLOCK, 'utf8');
    gitignore = 'created';
  }

  const human: string[] = [];
  for (const path of created) human.push(`created  ${path}`);
  for (const path of skipped) human.push(`exists   ${path}`);
  human.push(
    gitignore === 'unchanged'
      ? '.gitignore already ignores the local .visual-diff directories'
      : `${gitignore === 'created' ? 'created' : 'updated'}  .gitignore`,
  );
  human.push('');
  human.push('Commit .visual-diff/config.yaml and .visual-diff/flows/ — replaying a historical');
  human.push('revision reads the flow spec out of git history at that SHA.');
  human.push('');
  human.push('Next: edit .visual-diff/config.yaml, then `vdiff run example`.');

  return { data: { root, dir, created, skipped, gitignore }, human };
}
