/**
 * The harness registry, expressed as data (harness-packaging spec §4).
 *
 * Every harness is one entry in {@link HARNESSES}: an id, a label, three optional targets, and a
 * function that returns its frontmatter. Nothing here reads a file, composes markdown, or knows the
 * order of an install — that is `compose.ts` and `registry.ts`, and both are written once for all
 * harnesses. Adding a fifth agent is a row in this table.
 *
 * ## Where the paths come from
 *
 * Every path is relative: to the project root for `project`, and to the user's home directory for
 * `global`. That is what lets one `writeManagedFiles` serve both scopes — it refuses an absolute
 * path or one containing `..`, and a "global" install is simply the same relative paths under a
 * different root.
 *
 * `.agents/skills/` is read natively by Codex, opencode and pi, so all three share it (D18). Claude
 * Code does not read it — its own documentation never mentions the directory — so it keeps its
 * native `.claude/skills/`, which is the whole reason D18 says "shared where the harness reads it,
 * native where it does not" rather than "always shared".
 *
 * ## Precedence, and why D16's original rationale was wrong
 *
 * D16 said project-local wins "matching how every one of these harnesses resolves its own config".
 * That is false for all three harnesses whose resolution order is documented:
 *
 *  - Claude Code: "enterprise overrides personal, and personal overrides project" — the *personal*
 *    `~/.claude/skills` copy wins.
 *  - pi: scans global locations first and keeps the first skill found for a name, so a stale global
 *    copy shadows the project one.
 *  - Codex: does not resolve the collision at all — both copies stay visible in the selector.
 *
 * Project-local remains the right default for `vdiff install` (a team commits its skills beside
 * `.visual-diff/flows/`), but the tool must not claim the project copy wins. {@link HARNESS_NOTES}
 * carries the per-harness caveat so install output can say what actually happens.
 */

import { yamlString, type FrontmatterField } from './frontmatter.js';

/* ------------------------------------------------------------------ identity */

/** Every harness this build can install, in registration order. */
export const HARNESS_IDS = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/** Project-local by default; `--global` writes the user-level target (D16). */
export const INSTALL_SCOPES = ['project', 'global'] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ version stamp (D17) */

/** The package that wrote an installed file. Pinned to `package.json#name` by a test. */
export const VDIFF_SOURCE = '@beprajwal/visual-diff';

/**
 * The stamp lives under `metadata:`, not as a top-level `x-vdiff-version` key.
 *
 * D17 assumed "an unknown key is ignored by every harness that reads this format". Only opencode
 * documents that, and it also says only a fixed field set is recognized. The Agent Skills spec
 * designates exactly one home for client-specific data — `metadata`, a map of string keys to
 * *string* values — and all four harnesses accept it. The values are therefore quoted: unquoted,
 * a YAML parser reads `1.0` as a float and `0.2.0` as something else again.
 */
export const METADATA_KEY = 'metadata';
export const VERSION_KEY = 'x-vdiff-version';
export const SOURCE_KEY = 'x-vdiff-source';

/** The `metadata:` field every composed file carries. */
export function versionStamp(version: string): FrontmatterField {
  return [
    METADATA_KEY,
    { [VERSION_KEY]: yamlString(version), [SOURCE_KEY]: yamlString(VDIFF_SOURCE) },
  ];
}

/* ------------------------------------------------------------------ the table's shape */

/**
 * Where one kind of artifact lands, per scope. Either side may be null: pi documents no user-level
 * `AGENTS.md`, and writing one to `~/AGENTS.md` on a guess would be worse than writing nothing.
 * A `Target` with both sides null is meaningless and rejected by the registry's own tests.
 */
export interface Target {
  /** Path relative to the project root, or null when the harness has no project-level location. */
  project: string | null;
  /** Path relative to the user's home directory, or null when there is no user-level location. */
  global: string | null;
}

/** One artifact awaiting frontmatter: a skill, or the command that hands off to one. */
export interface SkillMeta {
  kind: 'skill' | 'command';
  /** Directory name for a skill, filename stem for a command. Must equal `name` for a skill. */
  id: string;
  name: string;
  description: string;
  /** For a command only: the skill it dispatches to. */
  invokes?: string;
}

/**
 * One harness. Six fields, exactly as spec §4 names them.
 *
 * `frontmatter` returns an ordered field list rather than the spec's `Record<string, unknown>`:
 * YAML key order is part of the bytes written, and a record makes the output depend on insertion
 * order that TypeScript does not model. Values are pre-rendered — quote through `yamlString`.
 */
export interface Harness {
  id: HarnessId;
  label: string;
  /** `SKILL.md` directories. Null when the harness has no skill mechanism (D15 fallback). */
  skills: Target | null;
  /** Slash-command directories. Null when the harness has no command concept worth writing. */
  commands: Target | null;
  /** `AGENTS.md`-style instruction *files*, managed as a delimited block (D19). */
  instructions: Target | null;
  frontmatter(skill: SkillMeta, version: string): FrontmatterField[];
}

/** The one path a target resolves to for a scope, or null when that scope has none. */
export function targetPath(target: Target | null, scope: InstallScope): string | null {
  if (target === null) return null;
  return scope === 'project' ? target.project : target.global;
}

/* ------------------------------------------------------------------ shared frontmatter shapes */

/**
 * `name` + `description` + the metadata stamp: the intersection of what all four harnesses
 * document, and the whole of what Codex documents. `description` is not merely recommended — pi
 * silently drops a skill that has none, so `compose.ts` rejects an empty one outright.
 */
function skillFrontmatter(skill: SkillMeta, version: string): FrontmatterField[] {
  return [
    ['name', skill.name],
    ['description', yamlString(skill.description)],
    versionStamp(version),
  ];
}

/* ------------------------------------------------------------------ the table */

/**
 * Claude Code. The only harness we can verify end to end here, and the only one that does not read
 * `.agents/skills/`.
 *
 * Its commands and skills have been merged upstream — `.claude/commands/vdiff.md` and
 * `.claude/skills/vdiff/SKILL.md` would both create `/vdiff`, and the skill would win. That is not
 * a collision here: the command ids (`vdiff`, `vdiff-review`) and the skill ids (`visual-diff`,
 * `visual-diff-flows`, `visual-diff-review`) are disjoint, so both mechanisms stay live and the
 * command file remains a real dispatcher rather than dead weight.
 */
export const CLAUDE_CODE: Harness & { id: 'claude-code' } = {
  id: 'claude-code',
  label: 'Claude Code',
  skills: { project: '.claude/skills', global: '.claude/skills' },
  commands: { project: '.claude/commands', global: '.claude/commands' },
  // Claude Code reads CLAUDE.md, not AGENTS.md, and the skills already say everything the block
  // would. Nothing outside `.claude/` is ever touched.
  instructions: null,
  frontmatter(skill: SkillMeta, version: string): FrontmatterField[] {
    if (skill.kind === 'skill') return skillFrontmatter(skill, version);
    return [
      ['description', yamlString(skill.description)],
      ['argument-hint', '[flow]'],
      ['allowed-tools', 'Bash(vdiff:*), Read, Glob'],
      versionStamp(version),
    ];
  },
};

/**
 * Codex. Reads `.agents/skills` from the working directory upward, then the repo root, then
 * `$HOME/.agents/skills`, then `/etc/codex/skills` — "files closer to the working directory take
 * precedence", but duplicates are *not* hidden: both copies appear in the selector.
 *
 * No commands target. `~/.codex/prompts` is documented as deprecated in favour of skills, has no
 * project-level equivalent, and cannot be invoked implicitly; writing it would be an investment in
 * a mechanism its own vendor is retiring.
 */
export const CODEX: Harness & { id: 'codex' } = {
  id: 'codex',
  label: 'Codex',
  skills: { project: '.agents/skills', global: '.agents/skills' },
  commands: null,
  instructions: { project: 'AGENTS.md', global: '.codex/AGENTS.md' },
  frontmatter: skillFrontmatter,
};

/**
 * opencode. Searches `.opencode/skills`, `.claude/skills` and `.agents/skills` from the working
 * directory up to the git worktree root, and the same three names globally; we write the shared
 * one. Its frontmatter is the strictest of the four — `name`, `description`, `license`,
 * `compatibility`, `metadata` and nothing else is recognized — which is exactly the field set
 * `skillFrontmatter` emits.
 *
 * Its global directory is `~/.agents/skills`, shared with Codex and pi, not
 * `~/.config/opencode/skills`: one global install then serves three harnesses.
 */
export const OPENCODE: Harness & { id: 'opencode' } = {
  id: 'opencode',
  label: 'opencode',
  skills: { project: '.agents/skills', global: '.agents/skills' },
  commands: { project: '.opencode/commands', global: '.config/opencode/commands' },
  instructions: { project: 'AGENTS.md', global: '.config/opencode/AGENTS.md' },
  frontmatter(skill: SkillMeta, version: string): FrontmatterField[] {
    if (skill.kind === 'skill') return skillFrontmatter(skill, version);
    // opencode command frontmatter recognizes `description`, `agent`, `model` and `subtask`. Only
    // `description` is ours to set; the stamp rides along in `metadata`, which opencode ignores on
    // a command and which `vdiff install --check` reads back off disk.
    return [['description', yamlString(skill.description)], versionStamp(version)];
  },
};

/**
 * pi. Discovers `~/.pi/agent/skills`, `~/.agents/skills`, `.pi/skills` and `.agents/skills`; only
 * the two `pi`-native directories accept a bare `.md` file as a skill, and `.agents/skills`
 * ignores root `.md` files entirely — every skill we write is a directory containing `SKILL.md`,
 * so the shared path is safe.
 *
 * No commands target: pi invokes a skill directly as `/skill:<name>`, which needs no file.
 * No global instructions target: pi auto-loads `AGENTS.md` and `CLAUDE.md` as *project* context and
 * documents no user-level equivalent.
 */
export const PI: Harness & { id: 'pi' } = {
  id: 'pi',
  label: 'pi',
  skills: { project: '.agents/skills', global: '.agents/skills' },
  commands: null,
  instructions: { project: 'AGENTS.md', global: null },
  frontmatter: skillFrontmatter,
};

/** The registry. Order is registration order, and is what `vdiff install --list` prints. */
export const HARNESSES: readonly Harness[] = [CLAUDE_CODE, CODEX, OPENCODE, PI];

export function getHarness(id: string): Harness | undefined {
  return HARNESSES.find((harness) => harness.id === id);
}

/* ------------------------------------------------------------------ install-output caveats */

/**
 * What "installed" does not guarantee, per harness. These are printed by install output rather
 * than buried here, because in every case a correctly written file can still fail to be read:
 *
 *  - a personal copy can override the project one (Claude Code) or shadow it (pi);
 *  - a duplicate can stay visible instead of being resolved (Codex);
 *  - the mechanism can be switched off entirely by configuration (opencode).
 */
export const HARNESS_NOTES: Readonly<Record<HarnessId, readonly string[]>> = {
  'claude-code': [
    'Claude Code resolves a name collision as enterprise > personal > project, so a copy in ' +
      '~/.claude/skills overrides this project one. `vdiff install --check` reports both.',
  ],
  codex: [
    'Codex does not hide duplicates: a global and a project skill of the same name both stay ' +
      'visible in the skill selector, so a stale global copy is a choice the user sees, not a ' +
      'silent override.',
    'The global path ~/.agents/skills is what Codex documents. It is written on that basis and ' +
      'has not been verified against a live Codex install.',
  ],
  opencode: [
    'opencode can gate skills per agent through opencode.json permissions, and `tools: { skill: ' +
      'false }` omits the skill section altogether. An installed skill is not necessarily an ' +
      'active one.',
  ],
  pi: [
    'pi scans global locations before project ones and keeps the first skill found for a name, so ' +
      'a stale copy in ~/.agents/skills or ~/.pi/agent/skills shadows this project one.',
  ],
};
