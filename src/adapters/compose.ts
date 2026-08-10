/**
 * Composition: one harness table row plus the shipped skill sources, in — the exact list of files
 * to write, out. Pure, and written once for every harness.
 *
 * This is the file that makes "adding a fifth harness is a table entry, not new code" true. Nothing
 * below branches on a harness id; it branches only on whether a `Target` is present, which is data.
 *
 * The shipped `SKILL.md` bodies stay harness-agnostic (a test enforces it). Everything
 * harness-specific is introduced here and only here, in exactly three places:
 *
 *  1. frontmatter, from `Harness#frontmatter`;
 *  2. the "## Also installed" pointer, which names slash commands only when the harness has them;
 *  3. the `AGENTS.md` block, which names the real directory the skills went into.
 */

import { applyBlock, renderBlock } from './blocks.js';
import type { ManagedFile } from './files.js';
import { withFrontmatter, yamlUnquote, splitFrontmatter } from './frontmatter.js';
import {
  HARNESSES,
  METADATA_KEY,
  SOURCE_KEY,
  VDIFF_SOURCE,
  VERSION_KEY,
  targetPath,
  type Harness,
  type InstallScope,
  type SkillMeta,
} from './harnesses.js';
import type { CommandManifestEntry, SkillBundle, SkillSource } from './source.js';

/** Everything composition needs, resolved once per install. */
export interface ComposeContext {
  harness: Harness;
  scope: InstallScope;
  bundle: SkillBundle;
  /** The CLI version that wrote the files; lands in `metadata.x-vdiff-version` (D17). */
  version: string;
}

/** The real directories an install writes for one scope. Install output names these (D18). */
export interface HarnessTargets {
  scope: InstallScope;
  /** e.g. `.agents/skills`, or null when the harness has no skill mechanism for this scope. */
  skills: string | null;
  commands: string | null;
  instructions: string | null;
}

/**
 * True when another registered harness writes its skills to the same directory in this scope —
 * `.agents/skills`, shared by Codex, opencode and pi (D18).
 *
 * A shared directory has to hold *shared* content: if opencode wrote a slash-command pointer into
 * `.agents/skills/visual-diff/SKILL.md` and Codex wrote the same file without one, every install
 * would rewrite the other's copy and D18 would have bought duplication with extra steps. So a
 * harness whose skills directory it shares keeps the harness-specific pointer out of the body and
 * puts it where it belongs: its own `AGENTS.md` block, which is not shared.
 *
 * Derived from the table rather than declared, so a fifth harness that adopts `.agents/skills`
 * inherits the rule with no edit here.
 */
export function sharesSkillsDirectory(harness: Harness, scope: InstallScope): boolean {
  const dir = targetPath(harness.skills, scope);
  if (dir === null) return false;
  return HARNESSES.some(
    (other) => other.id !== harness.id && targetPath(other.skills, scope) === dir,
  );
}

export function harnessTargets(harness: Harness, scope: InstallScope): HarnessTargets {
  return {
    scope,
    skills: targetPath(harness.skills, scope),
    commands: targetPath(harness.commands, scope),
    instructions: targetPath(harness.instructions, scope),
  };
}

/* ------------------------------------------------------------------ validation */

/**
 * The Agent Skills name rule, enforced by opencode and required by the spec the other three follow:
 * 1–64 characters, lowercase letters, digits and single interior hyphens.
 */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The spec's cap on `description`. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Reject a skill that would install but not load. Every rule here is one a harness enforces
 * silently: opencode refuses a `name` that disagrees with its directory, and pi drops a skill with
 * no description without saying so. A loud failure at install time is the only way that surfaces.
 */
export function validateSkillMeta(meta: SkillMeta): void {
  if (meta.kind === 'skill' && meta.name !== meta.id) {
    throw new Error(
      `skill '${meta.id}': frontmatter name '${meta.name}' must equal the skill directory name ` +
        `'${meta.id}' — opencode rejects a skill whose name and directory disagree`,
    );
  }
  if (!SKILL_NAME_RE.test(meta.name)) {
    throw new Error(
      `skill '${meta.id}': name '${meta.name}' must match ${SKILL_NAME_RE.source} — lowercase ` +
        'letters, digits and single interior hyphens only',
    );
  }
  if (meta.name.length > 64) {
    throw new Error(
      `skill '${meta.id}': name is ${meta.name.length} characters; the Agent Skills spec caps it at 64`,
    );
  }
  if (meta.description.trim() === '') {
    throw new Error(
      `skill '${meta.id}': description must not be empty — pi silently drops a skill that has none`,
    );
  }
  if (meta.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `skill '${meta.id}': description is ${meta.description.length} characters; the Agent Skills ` +
        `spec caps it at ${MAX_DESCRIPTION_LENGTH}`,
    );
  }
}

/* ------------------------------------------------------------------ paths */

/** `<skills dir>/<id>/SKILL.md`. Throws when the harness has no skills target for this scope. */
export function skillFilePath(harness: Harness, scope: InstallScope, id: string): string {
  const dir = targetPath(harness.skills, scope);
  if (dir === null) {
    throw new Error(
      `${harness.label} has no ${scope} skills directory, so there is no path for skill '${id}'`,
    );
  }
  return `${dir}/${id}/SKILL.md`;
}

/** `<commands dir>/<id>.md`. Throws when the harness has no commands target for this scope. */
export function commandFilePath(harness: Harness, scope: InstallScope, id: string): string {
  const dir = targetPath(harness.commands, scope);
  if (dir === null) {
    throw new Error(
      `${harness.label} has no ${scope} commands directory, so there is no path for command '${id}'`,
    );
  }
  return `${dir}/${id}.md`;
}

/* ------------------------------------------------------------------ skills and commands */

/**
 * The neutral body plus this harness's frontmatter, and — only where there is something to point
 * at — a short "## Also installed" section. The pointer is composed here rather than written into
 * `SKILL.md` because "load this other skill" and "run this slash command" are phrased differently
 * by every harness, and a harness with no commands must not be told about commands that do not
 * exist.
 */
export function composeSkillFile(ctx: ComposeContext, source: SkillSource): ManagedFile {
  const { entry } = source;
  const meta: SkillMeta = {
    kind: 'skill',
    id: entry.id,
    name: entry.name,
    description: entry.description,
  };
  validateSkillMeta(meta);

  const parts = [source.body.trim()];
  const companions = entry.loadWith ?? [];
  const namesCommands =
    targetPath(ctx.harness.commands, ctx.scope) !== null &&
    !sharesSkillsDirectory(ctx.harness, ctx.scope);
  const commands = namesCommands
    ? ctx.bundle.manifest.commands.filter((command) => command.invokes === entry.id)
    : [];

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
    path: skillFilePath(ctx.harness, ctx.scope, entry.id),
    body: withFrontmatter(ctx.harness.frontmatter(meta, ctx.version), parts.join('\n\n')),
  };
}

/**
 * A command file is a dispatcher, not a second copy of the skill: it names the flow argument, hands
 * off to the skill, and restates only the two rules an agent gets wrong when it skips the skill.
 */
export function composeCommandFile(ctx: ComposeContext, command: CommandManifestEntry): ManagedFile {
  const meta: SkillMeta = {
    kind: 'command',
    id: command.id,
    name: command.id,
    description: command.description,
    invokes: command.invokes,
  };
  validateSkillMeta(meta);

  const body = `${command.description}

Flow: **$1** — if empty, list \`.visual-diff/flows/\` and pick the flow covering the screens the
current change touches. If none fits, create one first.

Load the \`${command.invokes}\` skill and follow it. Do not restate its steps from memory.

Two rules that survive without the skill:

- Pass \`--json\` to every \`vdiff\` command whose output you intend to read, and parse the envelope
  rather than scraping the human table.
- \`vdiff diff\` exits 0 even when it finds things. Never gate anything on a findings count.`;

  return {
    path: commandFilePath(ctx.harness, ctx.scope, command.id),
    body: withFrontmatter(ctx.harness.frontmatter(meta, ctx.version), body),
  };
}

/* ------------------------------------------------------------------ AGENTS.md */

/** The machine-readable stamp carried inside the block, so `--check` can read a version back. */
export function blockStampLine(version: string): string {
  return `<!-- vdiff:stamp version=${version} source=${VDIFF_SOURCE} -->`;
}

const BLOCK_STAMP_RE = /<!--\s*vdiff:stamp\s+version=(\S+)\s+source=(\S+)\s*-->/;

/** Read `{ version, source }` back out of an `AGENTS.md` block, or null when it carries none. */
export function readBlockStamp(text: string): { version: string; source: string } | null {
  const match = BLOCK_STAMP_RE.exec(text);
  if (match === null) return null;
  return { version: match[1] as string, source: match[2] as string };
}

/**
 * What goes between the markers. It names the *real* directory the skills were written to, because
 * `vdiff install codex` putting its files in `.agents/skills/` is otherwise baffling (D18) — and
 * because an agent reading `AGENTS.md` needs to know where to look.
 */
export function instructionsContent(ctx: ComposeContext): string {
  const { harness, scope, bundle, version } = ctx;
  const skillsDir = targetPath(harness.skills, scope);
  const commandsDir = targetPath(harness.commands, scope);
  const installCommand = `vdiff install ${harness.id}${scope === 'global' ? ' --global' : ''}`;

  const lines: string[] = [
    '## visual-diff',
    '',
    blockStampLine(version),
    `<!-- Written by \`${installCommand}\`. Everything between the vdiff markers is replaced on`,
    '     reinstall; edit outside them and your changes survive. -->',
    '',
    '`vdiff` replays an authored UI workflow across revisions and diffs the results — pixels, DOM,',
    'accessibility tree, console and network — then serves a live report you can annotate.',
    '',
  ];

  if (skillsDir === null) {
    // D15's fallback: no skill mechanism is not an error, but the instructions have to carry the
    // whole pointer themselves rather than deferring to a skill that was never installed.
    lines.push(
      `${harness.label} has no skill mechanism, so no skills were installed. Drive the tool from`,
      'the CLI directly:',
      '',
      '- `vdiff run <flow>` captures the current UI.',
      '- `vdiff diff <flow>` compares it against the previous run.',
      '- `vdiff serve` opens the report; `vdiff feedback` pulls back human comments.',
    );
  } else {
    lines.push(`Skills are installed in \`${skillsDir}/\`:`, '');
    for (const skill of bundle.manifest.skills) {
      lines.push(`- \`${skill.id}\` — ${firstSentence(skill.description)}`);
    }
    lines.push(
      '',
      `Load \`${bundle.manifest.skills[0]?.id ?? 'visual-diff'}\` after changing any user-visible ` +
        'component, layout, style, route or copy, and before claiming a UI change works.',
    );
  }

  if (commandsDir !== null && bundle.manifest.commands.length > 0) {
    lines.push(
      '',
      `Slash commands (${commandsDir}/): ` +
        bundle.manifest.commands.map((command) => `\`/${command.id}\``).join(', ') +
        '.',
    );
  }

  lines.push(
    '',
    'Two rules that survive without the skills:',
    '',
    '- Pass `--json` to every `vdiff` command whose output you intend to read, and parse the',
    '  envelope rather than scraping the human table.',
    '- `vdiff diff` exits 0 even when it finds things. Never gate anything on a findings count.',
  );

  return lines.join('\n');
}

function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(\s|$)/.exec(text.trim());
  return (match?.[1] ?? text.trim()).trim();
}

/** The `AGENTS.md` entry, or null when this harness has no instructions target for this scope. */
export function composeInstructionsFile(ctx: ComposeContext): ManagedFile | null {
  const path = targetPath(ctx.harness.instructions, ctx.scope);
  if (path === null) return null;
  return { path, body: instructionsContent(ctx), mode: 'block' };
}

/* ------------------------------------------------------------------ the whole install */

/**
 * Every file this harness would write for this scope, in install order: skills, then commands, then
 * the instructions block. Touches no filesystem, so `--list` and `--dry-run` show exactly what an
 * install would do.
 */
export function composeFiles(ctx: ComposeContext): ManagedFile[] {
  const files: ManagedFile[] = [];

  if (targetPath(ctx.harness.skills, ctx.scope) !== null) {
    for (const source of ctx.bundle.skills) files.push(composeSkillFile(ctx, source));
  }
  if (targetPath(ctx.harness.commands, ctx.scope) !== null) {
    for (const command of ctx.bundle.manifest.commands) files.push(composeCommandFile(ctx, command));
  }
  const instructions = composeInstructionsFile(ctx);
  if (instructions !== null) files.push(instructions);

  return files;
}

/* ------------------------------------------------------------------ reading the stamp back */

/** The version and source a composed file claims, from its frontmatter. Null when it carries none. */
export function readFrontmatterStamp(doc: string): { version?: string; source?: string } | null {
  const split = splitFrontmatter(doc);
  if (split === null) return null;
  const version = split.fields[`${METADATA_KEY}.${VERSION_KEY}`];
  const source = split.fields[`${METADATA_KEY}.${SOURCE_KEY}`];
  if (version === undefined && source === undefined) return null;
  const stamp: { version?: string; source?: string } = {};
  if (version !== undefined) stamp.version = yamlUnquote(version);
  if (source !== undefined) stamp.source = yamlUnquote(source);
  return stamp;
}

/**
 * The version stamp of an installed file, whichever mechanism carries it: frontmatter for a
 * whole-file install, the block comment for `AGENTS.md`. One entry point so `--check` does not have
 * to know which kind of file it is holding.
 */
export function readInstalledVersion(content: string): string | null {
  const frontmatter = readFrontmatterStamp(content);
  if (frontmatter?.version !== undefined) return frontmatter.version;
  return readBlockStamp(content)?.version ?? null;
}

/** Re-exported so a caller composing an `AGENTS.md` preview needs one import, not three. */
export { applyBlock, renderBlock };
