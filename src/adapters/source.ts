/**
 * The shipped skill sources: `skills/manifest.json` plus one `SKILL.md` per skill.
 *
 * These are real files, not TypeScript string builders. The build copies `skills/` to `dist/skills`,
 * and `package.json#files` ships it, so the markdown an author edits is byte-for-byte the markdown a
 * harness reads. Nothing here composes frontmatter: the bodies are deliberately harness-agnostic and
 * every per-harness field is assembled at install time from the manifest (see `frontmatter.ts` and
 * `claude-code/`). That separation is what keeps a second harness a near-copy of one small file.
 *
 * Resolution is relative to `import.meta.url` rather than `process.cwd()`, because the common case
 * is `npx @beprajwal/visual-diff install …` from an arbitrary directory inside an installed package
 * layout — a `cwd`-relative lookup would find the sources only in a source checkout.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One skill as the manifest declares it; `entry` is a filename inside `skills/<id>/`. */
export interface SkillManifestEntry {
  id: string;
  name: string;
  description: string;
  /** Companion skills a harness may surface alongside this one. */
  loadWith?: string[];
  entry: string;
}

/** One harness command. `invokes` names the skill the command hands off to. */
export interface CommandManifestEntry {
  id: string;
  description: string;
  invokes: string;
}

export interface SkillsManifest {
  skills: SkillManifestEntry[];
  commands: CommandManifestEntry[];
}

/** A manifest entry paired with the markdown body read off disk. */
export interface SkillSource {
  entry: SkillManifestEntry;
  /** The SKILL.md contents, verbatim apart from line-ending normalisation. */
  body: string;
}

/** Everything an adapter needs to compose its files, loaded once. */
export interface SkillBundle {
  /** Absolute path of the directory the sources were read from. */
  dir: string;
  manifest: SkillsManifest;
  skills: SkillSource[];
}

export const MANIFEST_FILE = 'manifest.json';

/**
 * Candidate locations of the shipped `skills/` tree, in order:
 *  - `../skills` relative to this file compiled to `dist/adapters/` → `dist/skills` (installed)
 *  - `../../skills` relative to this file in `src/adapters/` → `<repo>/skills` (source checkout)
 *  - `../../dist/skills`, for a source checkout that prefers built output
 *
 * The two layouts cannot collide: `src/skills` does not exist, and an installed package has no
 * `<pkg>/skills`. Ordering is therefore about which exists, never about which wins.
 */
export function skillsDirCandidates(moduleUrl: string): string[] {
  const here = dirname(fileURLToPath(moduleUrl));
  return [
    resolve(here, '../skills'),
    resolve(here, '../../skills'),
    resolve(here, '../../dist/skills'),
  ];
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, MANIFEST_FILE))).isFile();
  } catch {
    return false;
  }
}

/**
 * First candidate directory that actually carries a manifest, or null.
 * A directory without `manifest.json` is not the skills tree, so an empty `dist/skills` left behind
 * by a half-finished build never shadows the real sources.
 */
export async function findSkillsDir(
  explicit?: string,
  moduleUrl: string = import.meta.url,
): Promise<string | null> {
  const candidates = explicit === undefined ? skillsDirCandidates(moduleUrl) : [resolve(explicit)];
  for (const candidate of candidates) {
    if (await hasManifest(candidate)) return candidate;
  }
  return null;
}

/** As `findSkillsDir`, but throws with every path it looked at — a missing build must be loud. */
export async function resolveSkillsDir(
  explicit?: string,
  moduleUrl: string = import.meta.url,
): Promise<string> {
  const found = await findSkillsDir(explicit, moduleUrl);
  if (found !== null) return found;
  const looked = (explicit === undefined ? skillsDirCandidates(moduleUrl) : [resolve(explicit)]).join(
    ', ',
  );
  throw new Error(
    `visual-diff skill sources not found: no ${MANIFEST_FILE} under any of ${looked}. ` +
      'Reinstall @beprajwal/visual-diff, or run `npm run build` in a source checkout.',
  );
}

function fail(message: string): never {
  throw new Error(`invalid skills ${MANIFEST_FILE}: ${message}`);
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalStringList(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    fail(`${where}.${key} must be an array of non-empty strings`);
  }
  return value as string[];
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validate a parsed manifest. Hand-rolled rather than zod: this runs on every `vdiff install`, the
 * shape is four fields deep, and the error an author needs names the offending key directly.
 */
export function parseManifest(value: unknown): SkillsManifest {
  const root = asRecord(value, 'manifest');

  const rawSkills = root['skills'];
  if (!Array.isArray(rawSkills) || rawSkills.length === 0) fail('skills must be a non-empty array');

  const skills: SkillManifestEntry[] = rawSkills.map((raw, index) => {
    const where = `skills[${index}]`;
    const record = asRecord(raw, where);
    const entry: SkillManifestEntry = {
      id: requireString(record, 'id', where),
      name: requireString(record, 'name', where),
      description: requireString(record, 'description', where),
      entry: requireString(record, 'entry', where),
    };
    const loadWith = optionalStringList(record, 'loadWith', where);
    if (loadWith !== undefined) entry.loadWith = loadWith;
    if (entry.entry.includes('/') || entry.entry.includes('\\') || entry.entry.includes('..')) {
      fail(`${where}.entry must be a plain filename inside the skill directory`);
    }
    return entry;
  });

  const ids = new Set<string>();
  for (const skill of skills) {
    if (ids.has(skill.id)) fail(`duplicate skill id '${skill.id}'`);
    ids.add(skill.id);
  }

  const rawCommands = root['commands'] ?? [];
  if (!Array.isArray(rawCommands)) fail('commands must be an array');

  const commands: CommandManifestEntry[] = rawCommands.map((raw, index) => {
    const where = `commands[${index}]`;
    const record = asRecord(raw, where);
    const command: CommandManifestEntry = {
      id: requireString(record, 'id', where),
      description: requireString(record, 'description', where),
      invokes: requireString(record, 'invokes', where),
    };
    if (!ids.has(command.invokes)) {
      fail(`${where}.invokes names '${command.invokes}', which is not a declared skill`);
    }
    return command;
  });

  return { skills, commands };
}

export async function readManifest(dir: string): Promise<SkillsManifest> {
  const file = join(dir, MANIFEST_FILE);
  const raw = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`invalid skills ${MANIFEST_FILE}: ${file} is not valid JSON`, { cause });
  }
  return parseManifest(parsed);
}

/** Read the manifest and every declared `SKILL.md`. The only filesystem read an install performs. */
export async function loadSkillBundle(
  explicitDir?: string,
  moduleUrl: string = import.meta.url,
): Promise<SkillBundle> {
  const dir = await resolveSkillsDir(explicitDir, moduleUrl);
  const manifest = await readManifest(dir);

  const skills: SkillSource[] = [];
  for (const entry of manifest.skills) {
    const file = join(dir, entry.id, entry.entry);
    let body: string;
    try {
      body = await readFile(file, 'utf8');
    } catch (cause) {
      throw new Error(
        `skill '${entry.id}' declares ${entry.entry} but ${file} could not be read`,
        { cause },
      );
    }
    skills.push({ entry, body: body.replace(/\r\n/g, '\n') });
  }

  return { dir, manifest, skills };
}
