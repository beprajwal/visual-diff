/**
 * The two build steps that decide what ends up in `dist/`, and therefore what ends up in the
 * tarball: `scripts/clean.mjs` and `scripts/build-skills.mjs`.
 *
 * Both are exercised the way `npm run build` exercises them — as a child process, through argv,
 * checked on exit code and stderr — because that is the whole of their contract. A build step that
 * "works" but exits 0 on failure stops being a build step.
 *
 * `tests/packaging/pack.test.ts` covers the end state (what the tarball contains). This file covers
 * the failure modes, which are the ones a green build would otherwise hide: a manifest naming a
 * skill nobody wrote, a stale directory surviving a rebuild, a mistyped path pointed at the repo.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cleanScript = join(repoRoot, 'scripts/clean.mjs');
const buildSkills = join(repoRoot, 'scripts/build-skills.mjs');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a build script to completion, capturing the exit code instead of throwing on failure. */
async function run(script: string, args: readonly string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { cwd: repoRoot });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir`, relative and `/`-separated, so structure is comparable. */
async function tree(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tree(full, base)));
    else out.push(full.slice(base.length + 1).split(sep).join('/'));
  }
  return out.sort();
}

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'vdiff-build-scripts-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** Write a skills tree: a manifest plus whichever `<id>/<file>` entries are asked for. */
async function writeSkills(
  root: string,
  manifest: unknown,
  files: Record<string, string> = {},
): Promise<string> {
  await mkdir(root, { recursive: true });
  if (manifest !== undefined) {
    const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2);
    await writeFile(join(root, 'manifest.json'), body);
  }
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

describe('scripts/clean.mjs', () => {
  it('empties the directory it is pointed at, including nested stale output', async () => {
    const dist = join(work, 'dist');
    await mkdir(join(dist, 'diff'), { recursive: true });
    await writeFile(join(dist, 'diff', 'flowDiff.js'), 'the compiled corpse of a deleted module');
    await writeFile(join(dist, 'index.js'), '');

    const result = await run(cleanScript, ['--dir', dist]);

    expect(result.code).toBe(0);
    expect(await exists(dist)).toBe(false);
  });

  it('succeeds when there is nothing to remove, so a first build is not a special case', async () => {
    const result = await run(cleanScript, ['--dir', join(work, 'never-existed')]);
    expect(result.code).toBe(0);
  });

  it('refuses to delete a directory that contains the repository', async () => {
    const result = await run(cleanScript, ['--dir', repoRoot]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('contains the repository');
    // The guard has to actually hold, not merely report: package.json is still here.
    expect(await exists(join(repoRoot, 'package.json'))).toBe(true);
  });

  it('refuses an ancestor of the repository, which is what a mistyped path reaches', async () => {
    const result = await run(cleanScript, ['--dir', join(repoRoot, '..')]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('contains the repository');
    expect(await exists(join(repoRoot, 'package.json'))).toBe(true);
  });

  it('rejects --dir with no path rather than falling back to a default', async () => {
    const result = await run(cleanScript, ['--dir']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--dir');
  });
});

describe('scripts/build-skills.mjs', () => {
  const MANIFEST = {
    skills: [
      { id: 'visual-diff', entry: 'SKILL.md' },
      { id: 'visual-diff-review', entry: 'SKILL.md' },
    ],
  };

  it('copies the tree to the output, preserving nested directory structure', async () => {
    const src = await writeSkills(join(work, 'skills'), MANIFEST, {
      'visual-diff/SKILL.md': '# visual-diff',
      'visual-diff/reference/steps.md': '# steps',
      'visual-diff-review/SKILL.md': '# review',
    });
    const out = join(work, 'dist', 'skills');

    const result = await run(buildSkills, ['--src', src, '--out', out]);

    expect(result.code).toBe(0);
    expect(await tree(out)).toEqual([
      'manifest.json',
      'visual-diff-review/SKILL.md',
      'visual-diff/SKILL.md',
      'visual-diff/reference/steps.md',
    ]);
    // The markdown is the artifact, so it must arrive byte-for-byte, not merely exist.
    expect(await readFile(join(out, 'visual-diff/SKILL.md'), 'utf8')).toBe('# visual-diff');
  });

  it('ships the manifest alongside the skills, since it is the registry', async () => {
    const src = await writeSkills(join(work, 'skills'), MANIFEST, {
      'visual-diff/SKILL.md': '#',
      'visual-diff-review/SKILL.md': '#',
    });
    const out = join(work, 'dist', 'skills');

    await run(buildSkills, ['--src', src, '--out', out]);

    const shipped = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(shipped.skills.map((skill: { id: string }) => skill.id)).toEqual([
      'visual-diff',
      'visual-diff-review',
    ]);
  });

  it('fails when the manifest names a skill with no directory', async () => {
    const src = await writeSkills(join(work, 'skills'), MANIFEST, {
      'visual-diff/SKILL.md': '#',
    });

    const result = await run(buildSkills, ['--src', src, '--out', join(work, 'out')]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('visual-diff-review');
    expect(result.stderr).toContain('no directory');
    expect(await exists(join(work, 'out'))).toBe(false);
  });

  it('fails when a declared skill directory exists but has no entry file', async () => {
    const src = await writeSkills(join(work, 'skills'), MANIFEST, {
      'visual-diff/SKILL.md': '#',
      'visual-diff-review/notes.md': 'not the entry file',
    });

    const result = await run(buildSkills, ['--src', src, '--out', join(work, 'out')]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('visual-diff-review/SKILL.md is missing');
  });

  it('checks the entry file the manifest names, not a hardcoded SKILL.md', async () => {
    const src = await writeSkills(
      join(work, 'skills'),
      { skills: [{ id: 'visual-diff', entry: 'INDEX.md' }] },
      { 'visual-diff/SKILL.md': 'the wrong file' },
    );

    const result = await run(buildSkills, ['--src', src, '--out', join(work, 'out')]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('visual-diff/INDEX.md is missing');
  });

  it('fails on a manifest that is not valid JSON', async () => {
    const src = await writeSkills(join(work, 'skills'), '{ "skills": [', {});

    const result = await run(buildSkills, ['--src', src, '--out', join(work, 'out')]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not valid JSON');
  });

  it('fails when the skills directory exists without a manifest', async () => {
    const src = join(work, 'skills');
    await mkdir(join(src, 'visual-diff'), { recursive: true });
    await writeFile(join(src, 'visual-diff', 'SKILL.md'), '#');

    const result = await run(buildSkills, ['--src', src, '--out', join(work, 'out')]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('manifest.json');
  });

  it('fails on a manifest whose skills field it cannot read', async () => {
    const src = await writeSkills(join(work, 'skills'), { commands: [] }, {});

    const result = await run(buildSkills, ['--src', src, '--out', join(work, 'out')]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"skills"');
  });

  it('fails on a duplicate skill id, which would silently drop one skill', async () => {
    const src = await writeSkills(
      join(work, 'skills'),
      { skills: [{ id: 'visual-diff' }, { id: 'visual-diff' }] },
      { 'visual-diff/SKILL.md': '#' },
    );

    const result = await run(buildSkills, ['--src', src, '--out', join(work, 'out')]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('duplicate skill id');
  });

  it('accepts a plain array of ids and an object keyed by id, which say the same thing', async () => {
    const files = { 'visual-diff/SKILL.md': '#', 'visual-diff-review/SKILL.md': '#' };

    const asArray = await writeSkills(
      join(work, 'array'),
      { skills: ['visual-diff', 'visual-diff-review'] },
      files,
    );
    const asObject = await writeSkills(
      join(work, 'object'),
      { skills: { 'visual-diff': {}, 'visual-diff-review': {} } },
      files,
    );

    expect((await run(buildSkills, ['--src', asArray, '--out', join(work, 'a')])).code).toBe(0);
    expect((await run(buildSkills, ['--src', asObject, '--out', join(work, 'b')])).code).toBe(0);
    expect(await tree(join(work, 'a'))).toEqual(await tree(join(work, 'b')));
  });

  it('warns about a skill directory the manifest does not register, without failing', async () => {
    const src = await writeSkills(join(work, 'skills'), { skills: ['visual-diff'] }, {
      'visual-diff/SKILL.md': '#',
      'visual-diff-orphan/SKILL.md': 'never registered, never found',
    });

    const result = await run(buildSkills, ['--src', src, '--out', join(work, 'out')]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('visual-diff-orphan');
  });

  it('replaces the output, so a removed skill does not survive a rebuild', async () => {
    const out = join(work, 'dist', 'skills');
    await mkdir(join(out, 'deleted-skill'), { recursive: true });
    await writeFile(join(out, 'deleted-skill', 'SKILL.md'), 'from a previous build');

    const src = await writeSkills(join(work, 'skills'), { skills: ['visual-diff'] }, {
      'visual-diff/SKILL.md': '#',
    });
    const result = await run(buildSkills, ['--src', src, '--out', out]);

    expect(result.code).toBe(0);
    expect(await tree(out)).toEqual(['manifest.json', 'visual-diff/SKILL.md']);
  });

  it('skips quietly when there is no skills directory at all', async () => {
    const result = await run(buildSkills, [
      '--src',
      join(work, 'absent'),
      '--out',
      join(work, 'out'),
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('dist/skills not produced');
    expect(await exists(join(work, 'out'))).toBe(false);
  });
});
