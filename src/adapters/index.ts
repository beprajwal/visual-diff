/**
 * Adapter registry (spec §5; harness-packaging spec §4).
 *
 * The registry is data. `harnesses.ts` holds one row per agent — id, label, three optional targets
 * and a frontmatter function — `compose.ts` turns a row plus the shipped `skills/` sources into a
 * file list, and `registry.ts` wraps that in an adapter. Adding a fifth harness is a row in the
 * table; there is no per-harness code left to write.
 *
 * The prose is shared: it lives as real markdown under `skills/`, is loaded by `source.ts`, and is
 * copied verbatim. Everything harness-specific is introduced at install time, in three places and
 * no others — frontmatter, the composed "## Also installed" pointer, and the `AGENTS.md` block.
 * The shipped SKILL.md bodies staying neutral is what makes that possible, and a test enforces it.
 *
 * Nothing here imports the CLI, the runner, or the diff engine — installing an adapter must not
 * pull the whole tool into memory.
 */

export {
  ADAPTERS,
  createAdapter,
  getAdapter,
  harnessFiles,
  installAdapter,
  installHarness,
  listAdapters,
} from './registry.js';
export type {
  HarnessAdapter,
  HarnessInstallDetail,
  InstallOptions,
} from './registry.js';

export {
  CLAUDE_CODE,
  CODEX,
  HARNESSES,
  HARNESS_IDS,
  HARNESS_NOTES,
  INSTALL_SCOPES,
  METADATA_KEY,
  OPENCODE,
  PI,
  SOURCE_KEY,
  VDIFF_SOURCE,
  VERSION_KEY,
  getHarness,
  isHarnessId,
  targetPath,
  versionStamp,
} from './harnesses.js';
export type { Harness, HarnessId, InstallScope, SkillMeta, Target } from './harnesses.js';

export {
  MAX_DESCRIPTION_LENGTH,
  SKILL_NAME_RE,
  blockStampLine,
  commandFilePath,
  composeCommandFile,
  composeFiles,
  composeInstructionsFile,
  composeSkillFile,
  harnessTargets,
  instructionsContent,
  readBlockStamp,
  readFrontmatterStamp,
  readInstalledVersion,
  sharesSkillsDirectory,
  skillFilePath,
  validateSkillMeta,
} from './compose.js';
export type { ComposeContext, HarnessTargets } from './compose.js';

export {
  BLOCK_END,
  BLOCK_START,
  MalformedBlockError,
  applyBlock,
  findBlock,
  readBlock,
  renderBlock,
} from './blocks.js';
export type { BlockSpan } from './blocks.js';

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
  planBlock,
  planFile,
  renderManaged,
  stampLine,
  writeManagedFiles,
  MANAGED_STAMP_VERSION,
} from './files.js';
export type {
  FileOutcome,
  FileStatus,
  ManagedFile,
  ManagedMode,
  WriteOptions,
  WriteReport,
} from './files.js';

export {
  splitFrontmatter,
  withFrontmatter,
  yamlList,
  yamlString,
  yamlUnquote,
} from './frontmatter.js';
export type { FrontmatterField, FrontmatterMap, FrontmatterValue } from './frontmatter.js';

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
