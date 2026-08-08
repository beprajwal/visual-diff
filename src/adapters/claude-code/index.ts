/**
 * Claude Code adapter (spec §9).
 *
 * Writes a `visual-diff` skill plus `/vdiff` and `/vdiff-review` command files into the project's
 * `.claude/` directory. That is the entire adapter: it produces markdown and nothing else. All
 * logic stays in the CLI, which is what keeps the Codex, opencode and pi adapters in subsystem 1
 * near-copies of this file.
 */

import type { Adapter, AdapterId, AdapterInstallResult } from '../../types.js';
import type { FileOutcome, ManagedFile, WriteOptions } from '../files.js';
import { writeManagedFiles } from '../files.js';
import { SKILL_NAME } from '../content.js';
import { reviewCommandDoc, runCommandDoc, skillDoc } from './templates.js';

export const CLAUDE_CODE_ID: AdapterId = 'claude-code';
export const CLAUDE_CODE_LABEL = 'Claude Code';

/** Project-relative paths this adapter owns. Nothing outside `.claude/` is ever touched. */
export const CLAUDE_CODE_PATHS = {
  skill: `.claude/skills/${SKILL_NAME}/SKILL.md`,
  runCommand: '.claude/commands/vdiff.md',
  reviewCommand: '.claude/commands/vdiff-review.md',
} as const;

/** Result of an install, widened with per-file detail so a caller can explain a skip. */
export interface AdapterInstallDetail extends AdapterInstallResult {
  files: FileOutcome[];
}

/**
 * The three documents, fully rendered. Exported so tests and `--dry-run` can inspect the content
 * without touching a filesystem.
 */
export function claudeCodeFiles(): ManagedFile[] {
  return [
    { path: CLAUDE_CODE_PATHS.skill, body: skillDoc() },
    { path: CLAUDE_CODE_PATHS.runCommand, body: runCommandDoc() },
    { path: CLAUDE_CODE_PATHS.reviewCommand, body: reviewCommandDoc() },
  ];
}

export async function installClaudeCode(
  root: string,
  options: WriteOptions = {},
): Promise<AdapterInstallDetail> {
  const report = await writeManagedFiles(root, claudeCodeFiles(), options);
  return {
    id: CLAUDE_CODE_ID,
    written: report.written,
    skipped: report.skipped,
    files: report.files,
  };
}

/** Satisfies the shared `Adapter` contract; the extra optional argument is adapter-local. */
export const claudeCodeAdapter = {
  id: CLAUDE_CODE_ID,
  label: CLAUDE_CODE_LABEL,
  install: (root: string, options?: WriteOptions): Promise<AdapterInstallDetail> =>
    installClaudeCode(root, options),
} satisfies Adapter;
