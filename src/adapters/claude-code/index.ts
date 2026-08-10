/**
 * Claude Code — the named entry point, now a thin projection of the harness table.
 *
 * The adapter itself no longer lives here: `harnesses.ts#CLAUDE_CODE` is the data, `compose.ts` is
 * the composition, and `registry.ts` builds the adapter. What remains is the named surface the CLI,
 * `src/index.ts` and the round-trip tests import — and those tests are the proof that generalising
 * the adapter did not change a byte of what Claude Code gets.
 *
 * Claude Code is also the one harness that keeps a native path under D18: it reads `.claude/skills`
 * and does not read `.agents/skills` — the string appears nowhere in its documentation — so the
 * shared directory the other three use would simply be invisible to it.
 */

import type { Adapter, AdapterId } from '../../types.js';
import { composeCommandFile, composeSkillFile, type ComposeContext } from '../compose.js';
import type { ManagedFile } from '../files.js';
import { CLAUDE_CODE, targetPath, type InstallScope } from '../harnesses.js';
import {
  createAdapter,
  harnessFiles,
  installHarness,
  type HarnessAdapter,
  type HarnessInstallDetail,
  type InstallOptions,
} from '../registry.js';
import { loadSkillBundle, type CommandManifestEntry, type SkillBundle, type SkillSource } from '../source.js';
import { TOOL_VERSION } from '../../version.js';

export const CLAUDE_CODE_ID: AdapterId = 'claude-code';
export const CLAUDE_CODE_LABEL = CLAUDE_CODE.label;

/**
 * Project-relative directories this adapter owns. Nothing outside `.claude/` is ever touched:
 * Claude Code has no `instructions` target, so no `AGENTS.md` is written for it.
 */
export const CLAUDE_CODE_DIRS = {
  skills: CLAUDE_CODE.skills?.project ?? '.claude/skills',
  commands: CLAUDE_CODE.commands?.project ?? '.claude/commands',
} as const;

/** Result of an install, widened with per-file detail so a caller can explain a skip. */
export type AdapterInstallDetail = HarnessInstallDetail;

/** `.claude/skills/<id>/SKILL.md` */
export function skillPath(id: string, scope: InstallScope = 'project'): string {
  return `${targetPath(CLAUDE_CODE.skills, scope) ?? CLAUDE_CODE_DIRS.skills}/${id}/SKILL.md`;
}

/** `.claude/commands/<id>.md` */
export function commandPath(id: string, scope: InstallScope = 'project'): string {
  return `${targetPath(CLAUDE_CODE.commands, scope) ?? CLAUDE_CODE_DIRS.commands}/${id}.md`;
}

function context(bundle: SkillBundle, scope: InstallScope = 'project'): ComposeContext {
  return { harness: CLAUDE_CODE, scope, bundle, version: TOOL_VERSION };
}

/**
 * A command file is composed from the manifest entry alone — it never consults the other skills —
 * so `composeCommand` can keep its one-argument signature. This stands in for the bundle the
 * shared context requires.
 */
const NO_BUNDLE: SkillBundle = { dir: '', manifest: { skills: [], commands: [] }, skills: [] };

/** The neutral body plus Claude Code's frontmatter and its "## Also installed" pointer. */
export function composeSkill(source: SkillSource, bundle: SkillBundle): ManagedFile {
  return composeSkillFile(context(bundle), source);
}

/** One `/vdiff`-style dispatcher per manifest command. */
export function composeCommand(command: CommandManifestEntry): ManagedFile {
  return composeCommandFile(context(NO_BUNDLE), command);
}

/**
 * Every file this adapter would write, fully rendered. Exported so tests, `--dry-run` and
 * `install --list` can inspect the result without touching a filesystem.
 */
export async function claudeCodeFiles(
  bundle?: SkillBundle,
  scope: InstallScope = 'project',
): Promise<ManagedFile[]> {
  return harnessFiles(CLAUDE_CODE, { scope, bundle: bundle ?? (await loadSkillBundle()) });
}

export async function installClaudeCode(
  root: string,
  options: InstallOptions = {},
): Promise<HarnessInstallDetail<'claude-code'>> {
  return installHarness(CLAUDE_CODE, root, options);
}

/**
 * The registered adapter. Typed against the shared `Adapter` contract from `src/types.ts` as well
 * as the registry's own, which is what keeps `AdapterId` honest: if this ever stopped returning
 * `id: 'claude-code'`, the annotation would fail to compile.
 */
export const claudeCodeAdapter: HarnessAdapter<'claude-code'> & Adapter =
  createAdapter(CLAUDE_CODE);
