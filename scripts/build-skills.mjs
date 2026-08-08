#!/usr/bin/env node
/**
 * Copies `skills/` into `dist/skills/` so the skills ship inside the npm package.
 *
 * The skill markdown is the artifact. A harness plugin is only an envelope around it, so the
 * package has to carry the markdown itself rather than point at a repository — an `npx` user with
 * no checkout must still be able to install a skill. `dist/skills/<id>/SKILL.md` is that payload,
 * and `package.json#files` ships it.
 *
 * The copy is the easy half. The half worth writing a script for is the check: `skills/manifest.json`
 * names the skills, and a name in the manifest with nothing behind it produces a package that
 * advertises a skill it cannot install. That failure is invisible in the source tree, silent at
 * publish time, and only shows up on a stranger's machine — so it fails the build here instead.
 *
 * Contract with the skill authors (deliberately narrow, so both sides can move independently):
 *   skills/manifest.json   names every skill id
 *   skills/<id>/SKILL.md   the entry file for that id
 *
 * The manifest's `skills` field may be an array of ids, an array of objects carrying an `id`
 * (or `name`), or an object keyed by id. All three say the same thing; the script reads whichever
 * shape the authors chose rather than forcing a rewrite on them.
 *
 * Usage: `node scripts/build-skills.mjs [--src <path>] [--out <path>]`. The overrides exist so the
 * validation can be tested against fixture trees instead of the real one.
 */

import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** The file every skill directory must contain to be installable. */
export const ENTRY_FILE = 'SKILL.md';
/** The registry the package is built from. */
export const MANIFEST_FILE = 'manifest.json';

function readOption(argv, flag, fallback) {
  const at = argv.indexOf(flag);
  if (at === -1) return fallback;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a path`);
  }
  return resolve(process.cwd(), value);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pull the declared skills out of a parsed manifest as `{ id, entry }` pairs, accepting the three
 * equivalent shapes described above. A skill may name its own `entry` file; `SKILL.md` is the
 * default, and the validation below checks whichever file the manifest actually points at, so the
 * check never drifts into confirming the presence of a file nothing reads.
 *
 * Throws rather than returning an empty list: "no skills" is far more likely to be a manifest this
 * script failed to understand than a manifest that genuinely declares nothing.
 */
export function declaredSkills(manifest) {
  const declared = Array.isArray(manifest) ? manifest : manifest?.skills;

  let skills;
  if (Array.isArray(declared)) {
    skills = declared.map((skill) =>
      typeof skill === 'string'
        ? { id: skill, entry: ENTRY_FILE }
        : { id: skill?.id ?? skill?.name, entry: skill?.entry ?? ENTRY_FILE },
    );
  } else if (declared !== null && typeof declared === 'object') {
    skills = Object.entries(declared).map(([id, skill]) => ({
      id,
      entry: skill?.entry ?? ENTRY_FILE,
    }));
  } else {
    throw new Error(
      `${MANIFEST_FILE} must have a "skills" array or object (or be an array of skills itself)`,
    );
  }

  const bad = skills.findIndex(({ id }) => typeof id !== 'string' || id.trim() === '');
  if (bad !== -1) {
    throw new Error(`${MANIFEST_FILE}: skill at index ${bad} has no usable id`);
  }
  if (skills.length === 0) {
    throw new Error(`${MANIFEST_FILE} declares no skills`);
  }

  const seen = new Set();
  for (const { id, entry } of skills) {
    if (seen.has(id)) throw new Error(`${MANIFEST_FILE}: duplicate skill id '${id}'`);
    seen.add(id);
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${MANIFEST_FILE}: skill '${id}' has an unusable entry`);
    }
  }
  return skills;
}

/**
 * Copy `srcDir` to `outDir`, preserving the directory structure, after checking every id the
 * manifest declares. Returns the ids that shipped.
 *
 * A missing `skills/` directory is reported and skipped: the packaging test is what asserts the
 * skills actually ship, and a build that dies because an unrelated tree is absent teaches nothing.
 * Everything past that point is a hard failure, because it means the tree exists and is wrong.
 */
export async function buildSkills({ srcDir, outDir, log = process.stdout, warn = process.stderr }) {
  if (!(await isDirectory(srcDir))) {
    warn.write(`build-skills: no ${srcDir} directory — dist/skills not produced\n`);
    return [];
  }

  const manifestPath = join(srcDir, MANIFEST_FILE);
  if (!(await exists(manifestPath))) {
    throw new Error(`${srcDir} exists but has no ${MANIFEST_FILE}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    throw new Error(`${manifestPath} is not valid JSON: ${cause.message}`);
  }

  const skills = declaredSkills(manifest);
  const ids = skills.map((skill) => skill.id);

  const missing = [];
  for (const { id, entry } of skills) {
    const dir = join(srcDir, id);
    if (!(await isDirectory(dir))) {
      missing.push(`${id}: no directory at skills/${id}`);
      continue;
    }
    if (!(await exists(join(dir, entry)))) {
      missing.push(`${id}: skills/${id}/${entry} is missing`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${MANIFEST_FILE} declares skills that are not on disk:\n  ${missing.join('\n  ')}`,
    );
  }

  // A skill directory nobody registered would be copied but never found. Not fatal — the manifest
  // is the registry, and the authors may keep shared material alongside it — but worth saying.
  const onDisk = (await readdir(srcDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const dir of onDisk) {
    if (!ids.includes(dir)) {
      warn.write(`build-skills: skills/${dir} is not in ${MANIFEST_FILE} and will not be found\n`);
    }
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(dirname(outDir), { recursive: true });
  await cp(srcDir, outDir, { recursive: true });

  log.write(`skills → ${outDir} (${ids.length}: ${ids.join(', ')})\n`);
  return ids;
}

/** Only run when invoked as a script, so the tests can import the pieces above. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    await buildSkills({
      srcDir: readOption(argv, '--src', resolve(root, 'skills')),
      outDir: readOption(argv, '--out', resolve(root, 'dist/skills')),
    });
  } catch (error) {
    process.stderr.write(`build-skills: ${error.message}\n`);
    process.exit(1);
  }
}
