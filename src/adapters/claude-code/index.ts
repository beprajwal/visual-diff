/**
 * Claude Code adapter (spec §9).
 *
 * Copies the shipped `SKILL.md` files into `.claude/skills/<id>/` and composes one command file per
 * `manifest.json#commands` entry into `.claude/commands/`. That is the entire adapter: it moves
 * markdown and prepends frontmatter. All logic stays in the CLI, and all prose stays in `skills/`,
 * which is what keeps the Codex, opencode and pi adapters near-copies of this file — they differ
 * only in the directory names below and in which frontmatter keys they emit.
 */

import type { Adapter, AdapterId, AdapterInstallResult } from '../../types.js';
import type { FileOutcome, ManagedFile, WriteOptions } from '../files.js';
import { writeManagedFiles } from '../files.js';
import { withFrontmatter, yamlString } from '../frontmatter.js';
import { loadSkillBundle, type CommandManifestEntry, type SkillBundle, type SkillSource } from '../source.js';

export const CLAUDE_CODE_ID: AdapterId = 'claude-code';
export const CLAUDE_CODE_LABEL = 'Claude Code';

/** Project-relative directories this adapter owns. Nothing outside `.claude/` is ever touched. */
export const CLAUDE_CODE_DIRS = {
  skills: '.claude/skills',
  commands: '.claude/commands',
} as const;

/** Result of an install, widened with per-file detail so a caller can explain a skip. */
export interface AdapterInstallDetail extends AdapterInstallResult {
  files: FileOutcome[];
}

/** `.claude/skills/<id>/SKILL.md` */
export function skillPath(id: string): string {
  return `${CLAUDE_CODE_DIRS.skills}/${id}/SKILL.md`;
}

/** `.claude/commands/<id>.md` */
export function commandPath(id: string): string {
  return `${CLAUDE_CODE_DIRS.commands}/${id}.md`;
}

/**
 * The neutral body plus Claude Code's frontmatter, and — only for a skill that declares companions —
 * a short pointer at them. The pointer is composed here rather than written into `SKILL.md` because
 * "load this other skill" is phrased differently by every harness.
 */
export function composeSkill(source: SkillSource, bundle: SkillBundle): ManagedFile {
  const { entry } = source;
  const parts = [source.body.trim()];

  const companions = entry.loadWith ?? [];
  const commands = bundle.manifest.commands.filter((command) => command.invokes === entry.id);
  if (companions.length > 0 || commands.length > 0) {
    const lines = ['## Also installed', ''];
    if (companions.length > 0) {
      lines.push(
        `- Companion skills: ${companions.map((id) => `\`${id}\``).join(', ')} — load them when this` +
          ' skill points you at them.',
      );
    }
    if (commands.length > 0) {
      lines.push(`- Slash commands: ${commands.map((c) => `\`/${c.id}\``).join(', ')}.`);
    }
    parts.push(lines.join('\n'));
  }

  return {
    path: skillPath(entry.id),
    body: withFrontmatter(
      [
        ['name', entry.name],
        ['description', yamlString(entry.description)],
      ],
      parts.join('\n\n'),
    ),
  };
}

/**
 * A command file is a dispatcher, not a second copy of the skill: it names the flow argument, hands
 * off to the skill, and restates only the two rules an agent gets wrong when it skips the skill.
 */
export function composeCommand(command: CommandManifestEntry): ManagedFile {
  const body = `${command.description}

Flow: **$1** — if empty, list \`.visual-diff/flows/\` and pick the flow covering the screens the
current change touches. If none fits, create one first.

Load the \`${command.invokes}\` skill and follow it. Do not restate its steps from memory.

Two rules that survive without the skill:

- Pass \`--json\` to every \`vdiff\` command whose output you intend to read, and parse the envelope
  rather than scraping the human table.
- \`vdiff diff\` exits 0 even when it finds things. Never gate anything on a findings count.`;

  return {
    path: commandPath(command.id),
    body: withFrontmatter(
      [
        ['description', yamlString(command.description)],
        ['argument-hint', '[flow]'],
        ['allowed-tools', 'Bash(vdiff:*), Read, Glob'],
      ],
      body,
    ),
  };
}

/**
 * Every file this adapter would write, fully rendered. Exported so tests, `--dry-run` and
 * `install --list` can inspect the result without touching a filesystem.
 */
export async function claudeCodeFiles(bundle?: SkillBundle): Promise<ManagedFile[]> {
  const loaded = bundle ?? (await loadSkillBundle());
  return [
    ...loaded.skills.map((source) => composeSkill(source, loaded)),
    ...loaded.manifest.commands.map((command) => composeCommand(command)),
  ];
}

export async function installClaudeCode(
  root: string,
  options: WriteOptions = {},
): Promise<AdapterInstallDetail> {
  const report = await writeManagedFiles(root, await claudeCodeFiles(), options);
  return {
    id: CLAUDE_CODE_ID,
    written: report.written,
    skipped: report.skipped,
    files: report.files,
  };
}

/**
 * Satisfies the shared `Adapter` contract from `src/types.ts`, widened with the two adapter-local
 * extras the registry declares: install options, and `files()` for `--list` and `--dry-run`.
 */
export const claudeCodeAdapter: Adapter & {
  install(root: string, options?: WriteOptions): Promise<AdapterInstallDetail>;
  files(): Promise<ManagedFile[]>;
} = {
  id: CLAUDE_CODE_ID,
  label: CLAUDE_CODE_LABEL,
  install: (root: string, options?: WriteOptions): Promise<AdapterInstallDetail> =>
    installClaudeCode(root, options),
  files: (): Promise<ManagedFile[]> => claudeCodeFiles(),
};
