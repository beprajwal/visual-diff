/**
 * Adapter registry (spec §5).
 *
 * Slice 1 registers exactly one adapter. The registry exists so the Codex, opencode and pi adapters
 * of subsystem 1 drop in without restructuring anything: add a module next to `claude-code/`, add it
 * to `ADAPTERS`, widen `AdapterId` in `src/types.ts`. The prose they install is shared — it lives as
 * real markdown under `skills/` and is loaded by `source.ts` — so a new adapter contributes only
 * frontmatter and file paths.
 *
 * Nothing here imports the CLI, the runner, or the diff engine — installing an adapter must not
 * pull the whole tool into memory.
 */

import type { Adapter, AdapterId } from '../types.js';
import type { ManagedFile, WriteOptions } from './files.js';
import type { AdapterInstallDetail } from './claude-code/index.js';
import { claudeCodeAdapter } from './claude-code/index.js';

/**
 * `Adapter` from `src/types.ts` is the contract the CLI codes against. Registered adapters satisfy
 * it and additionally accept the install options (`force`, `dryRun`), return per-file detail, and
 * can describe what they would write without being given a project root.
 */
export interface HarnessAdapter extends Adapter {
  install(root: string, options?: WriteOptions): Promise<AdapterInstallDetail>;
  /** Every file this adapter would write, fully composed. Touches no project directory. */
  files(): Promise<ManagedFile[]>;
}

export const ADAPTERS: readonly HarnessAdapter[] = [claudeCodeAdapter];

/** Every registered harness id, in registration order. */
export function listAdapters(): AdapterId[] {
  return ADAPTERS.map((adapter) => adapter.id);
}

/** The adapter for an id, or undefined when the id is not registered. */
export function getAdapter(id: string): HarnessAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.id === id);
}

/**
 * Install one harness's files under `root`.
 * Throws on an unknown id — the caller (the CLI) maps that to exit code 2.
 */
export async function installAdapter(
  id: string,
  root: string,
  options: WriteOptions = {},
): Promise<AdapterInstallDetail> {
  const adapter = getAdapter(id);
  if (!adapter) {
    throw new Error(`unknown adapter '${id}'. Available: ${listAdapters().join(', ')}`);
  }
  return adapter.install(root, options);
}

export {
  CLAUDE_CODE_ID,
  CLAUDE_CODE_LABEL,
  CLAUDE_CODE_DIRS,
  claudeCodeAdapter,
  claudeCodeFiles,
  commandPath,
  composeCommand,
  composeSkill,
  installClaudeCode,
  skillPath,
} from './claude-code/index.js';
export type { AdapterInstallDetail } from './claude-code/index.js';
export {
  bodyHash,
  isUnmodifiedManaged,
  normalizeBody,
  parseManaged,
  planFile,
  renderManaged,
  stampLine,
  writeManagedFiles,
  MANAGED_STAMP_VERSION,
} from './files.js';
export type { FileOutcome, FileStatus, ManagedFile, WriteOptions, WriteReport } from './files.js';
export {
  splitFrontmatter,
  withFrontmatter,
  yamlList,
  yamlString,
} from './frontmatter.js';
export type { FrontmatterField } from './frontmatter.js';
export {
  MANIFEST_FILE,
  findSkillsDir,
  loadSkillBundle,
  parseManifest,
  readManifest,
  resolveSkillsDir,
  skillsDirCandidates,
} from './source.js';
export type {
  CommandManifestEntry,
  SkillBundle,
  SkillManifestEntry,
  SkillSource,
  SkillsManifest,
} from './source.js';
