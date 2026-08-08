/**
 * The skill sources ship as files, so the only way they can go missing is a resolution bug in a
 * layout nobody ran locally. These tests therefore build both real layouts on disk — an installed
 * package (`<pkg>/dist/adapters` + `<pkg>/dist/skills`) and a source checkout (`<repo>/src/adapters`
 * + `<repo>/skills`) — and resolve against a synthesized module URL rather than trusting the one
 * this test file happens to have.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MANIFEST_FILE,
  findSkillsDir,
  loadSkillBundle,
  parseManifest,
  readManifest,
  resolveSkillsDir,
  skillsDirCandidates,
} from './source.js';

let box: string;

/** Write a minimal but valid skills tree at `dir`. */
async function writeSkillsTree(dir: string, ids: string[] = ['alpha']): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, MANIFEST_FILE),
    JSON.stringify({
      skills: ids.map((id) => ({
        id,
        name: id,
        description: `describes ${id}`,
        entry: 'SKILL.md',
      })),
      commands: [{ id: 'go', description: 'do it', invokes: ids[0] }],
    }),
    'utf8',
  );
  for (const id of ids) {
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, 'SKILL.md'), `# ${id}\n\nbody of ${id}\n`, 'utf8');
  }
}

/** A file URL for a module that would live at `<dir>/<name>.js`. */
function moduleUrlIn(dir: string): string {
  return pathToFileURL(join(dir, 'source.js')).href;
}

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), 'vdiff-skills-'));
});

afterEach(async () => {
  await rm(box, { recursive: true, force: true });
});

describe('skillsDirCandidates', () => {
  it('offers dist/skills first, then the source checkout, all absolute', () => {
    const candidates = skillsDirCandidates(moduleUrlIn('/pkg/dist/adapters'));
    expect(candidates[0]).toBe('/pkg/dist/skills');
    expect(candidates.every((c) => c.startsWith('/'))).toBe(true);
    expect(candidates).toContain('/pkg/skills');
  });

  it('reaches the repo root from src/adapters', () => {
    const candidates = skillsDirCandidates(moduleUrlIn('/repo/src/adapters'));
    expect(candidates).toContain('/repo/skills');
    expect(candidates).toContain('/repo/dist/skills');
  });
});

describe('resolving the sources in a real layout', () => {
  it('resolves an installed package layout: dist/adapters -> dist/skills', async () => {
    const pkg = join(box, 'node_modules', '@beprajwal', 'visual-diff');
    const adapters = join(pkg, 'dist', 'adapters');
    await mkdir(adapters, { recursive: true });
    await writeSkillsTree(join(pkg, 'dist', 'skills'));

    await expect(resolveSkillsDir(undefined, moduleUrlIn(adapters))).resolves.toBe(
      join(pkg, 'dist', 'skills'),
    );
  });

  it('resolves a source checkout: src/adapters -> <repo>/skills', async () => {
    const repo = join(box, 'checkout');
    const adapters = join(repo, 'src', 'adapters');
    await mkdir(adapters, { recursive: true });
    await writeSkillsTree(join(repo, 'skills'));

    await expect(resolveSkillsDir(undefined, moduleUrlIn(adapters))).resolves.toBe(
      join(repo, 'skills'),
    );
  });

  it('ignores a directory that carries no manifest, rather than claiming it', async () => {
    const repo = join(box, 'halfbuilt');
    const adapters = join(repo, 'src', 'adapters');
    await mkdir(adapters, { recursive: true });
    // A build that created the directory and then died.
    await mkdir(join(repo, 'dist', 'skills'), { recursive: true });
    await writeSkillsTree(join(repo, 'skills'));

    await expect(resolveSkillsDir(undefined, moduleUrlIn(adapters))).resolves.toBe(
      join(repo, 'skills'),
    );
  });

  it('returns null rather than throwing when nothing is found', async () => {
    const adapters = join(box, 'empty', 'dist', 'adapters');
    await mkdir(adapters, { recursive: true });
    await expect(findSkillsDir(undefined, moduleUrlIn(adapters))).resolves.toBeNull();
  });

  it('throws naming every path it looked at', async () => {
    const adapters = join(box, 'empty2', 'dist', 'adapters');
    await mkdir(adapters, { recursive: true });
    await expect(resolveSkillsDir(undefined, moduleUrlIn(adapters))).rejects.toThrow(
      /skill sources not found[\s\S]*dist[\/\\]skills/,
    );
  });

  it('honours an explicit directory and ignores the candidates', async () => {
    const explicit = join(box, 'elsewhere');
    await writeSkillsTree(explicit);
    await expect(resolveSkillsDir(explicit, moduleUrlIn('/nowhere/dist/adapters'))).resolves.toBe(
      explicit,
    );
  });
});

describe('parseManifest', () => {
  const valid = {
    skills: [{ id: 'a', name: 'a', description: 'd', entry: 'SKILL.md' }],
    commands: [{ id: 'c', description: 'd', invokes: 'a' }],
  };

  it('accepts a valid manifest and keeps declaration order', () => {
    const manifest = parseManifest({
      skills: [
        { id: 'a', name: 'a', description: 'd', entry: 'SKILL.md', loadWith: ['b'] },
        { id: 'b', name: 'b', description: 'd', entry: 'SKILL.md' },
      ],
      commands: [{ id: 'c', description: 'd', invokes: 'b' }],
    });
    expect(manifest.skills.map((s) => s.id)).toEqual(['a', 'b']);
    expect(manifest.skills[0]?.loadWith).toEqual(['b']);
    expect(manifest.skills[1]?.loadWith).toBeUndefined();
  });

  it('defaults commands to empty', () => {
    expect(parseManifest({ skills: valid.skills }).commands).toEqual([]);
  });

  it('rejects a missing or empty skills list', () => {
    expect(() => parseManifest({})).toThrow(/skills must be a non-empty array/);
    expect(() => parseManifest({ skills: [] })).toThrow(/skills must be a non-empty array/);
  });

  it('names the offending key when a field is missing', () => {
    expect(() => parseManifest({ skills: [{ id: 'a', name: 'a', entry: 'SKILL.md' }] })).toThrow(
      /skills\[0\]\.description must be a non-empty string/,
    );
  });

  it('rejects a duplicate skill id', () => {
    expect(() => parseManifest({ skills: [valid.skills[0], valid.skills[0]] })).toThrow(
      /duplicate skill id 'a'/,
    );
  });

  it('rejects a command that invokes a skill nobody declared', () => {
    expect(() =>
      parseManifest({ skills: valid.skills, commands: [{ id: 'c', description: 'd', invokes: 'z' }] }),
    ).toThrow(/invokes names 'z', which is not a declared skill/);
  });

  it('refuses an entry that escapes the skill directory', () => {
    expect(() =>
      parseManifest({ skills: [{ ...valid.skills[0], entry: '../../etc/passwd' }] }),
    ).toThrow(/plain filename/);
  });

  it('rejects a non-object manifest', () => {
    expect(() => parseManifest([])).toThrow(/manifest must be an object/);
  });
});

describe('readManifest and loadSkillBundle', () => {
  it('reads every declared SKILL.md and normalises line endings', async () => {
    const dir = join(box, 'tree');
    await writeSkillsTree(dir, ['alpha', 'beta']);
    await writeFile(join(dir, 'beta', 'SKILL.md'), '# beta\r\n\r\ncrlf body\r\n', 'utf8');

    const bundle = await loadSkillBundle(dir, moduleUrlIn('/nowhere/dist/adapters'));

    expect(bundle.dir).toBe(dir);
    expect(bundle.skills.map((s) => s.entry.id)).toEqual(['alpha', 'beta']);
    expect(bundle.skills[1]?.body).toBe('# beta\n\ncrlf body\n');
    expect(bundle.skills[1]?.body).not.toContain('\r');
  });

  it('fails loudly when a declared SKILL.md is missing', async () => {
    const dir = join(box, 'gap');
    await writeSkillsTree(dir, ['alpha']);
    await rm(join(dir, 'alpha', 'SKILL.md'));

    await expect(loadSkillBundle(dir, moduleUrlIn('/nowhere'))).rejects.toThrow(
      /skill 'alpha' declares SKILL\.md/,
    );
  });

  it('reports malformed JSON against the file, not as a parse stack', async () => {
    const dir = join(box, 'broken');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, MANIFEST_FILE), '{ not json', 'utf8');
    await expect(readManifest(dir)).rejects.toThrow(/is not valid JSON/);
  });
});

describe('the manifest this package actually ships', () => {
  it('loads from the repository with no explicit directory', async () => {
    const bundle = await loadSkillBundle();
    expect(bundle.manifest.skills.map((s) => s.id)).toEqual([
      'visual-diff',
      'visual-diff-flows',
      'visual-diff-review',
    ]);
    expect(bundle.manifest.commands.map((c) => c.id)).toEqual(['vdiff', 'vdiff-review']);
  });

  it('gives every skill a non-trivial body', async () => {
    const bundle = await loadSkillBundle();
    for (const skill of bundle.skills) {
      expect(skill.body.length, skill.entry.id).toBeGreaterThan(500);
      expect(skill.body, skill.entry.id).toContain('vdiff');
    }
  });
});
