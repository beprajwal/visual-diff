/**
 * The GitHub Actions install target (CI spec §10).
 *
 * The behaviours asserted here are the ones a user notices: their edited workflow survives a
 * re-install, a `--dry-run` writes nothing, the stamp is a `#` comment rather than an HTML one (a
 * workflow carrying `<!-- … -->` is a YAML parse error, not an ignored line), and asking for a
 * user-level install is refused with the reason rather than writing into `$HOME`.
 *
 * The workflow *content* is asserted only where content is load-bearing: `fetch-depth: 0`, because
 * the base side is replayed at the merge-base and a shallow clone does not contain it, and the
 * pinned action version, because an unpinned `uses:` makes a run unreproducible.
 */

import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parse as parseYaml } from 'yaml';

import { isUnmodifiedManaged, parseManaged } from '../files.js';
import {
  BASELINE_WORKFLOW_PATH,
  GITHUB_ACTIONS_SCOPES,
  PR_WORKFLOW_PATH,
  UnsupportedScopeError,
  WORKFLOWS_DIR,
  githubActionsFiles,
  githubActionsTargets,
  installGithubActions,
} from './index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vdiff-gha-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8');

describe('composition', () => {
  it('is two workflow files under .github/workflows', () => {
    expect(githubActionsFiles({ version: '1.2.3' }).map((file) => file.path)).toEqual([
      PR_WORKFLOW_PATH,
      BASELINE_WORKFLOW_PATH,
    ]);
    for (const file of githubActionsFiles()) {
      expect(dirname(file.path)).toBe(WORKFLOWS_DIR);
      expect(file.path.startsWith('/')).toBe(false);
    }
  });

  it('pins the action to the version that composed it', () => {
    const [pr, baseline] = githubActionsFiles({ version: '1.2.3' });
    expect(pr?.body).toContain('uses: beprajwal/visual-diff@v1.2.3');
    expect(baseline?.body).toContain('uses: beprajwal/visual-diff@v1.2.3');
  });

  it('stamps with a YAML comment, because YAML has no HTML comment', async () => {
    await installGithubActions(root, { version: '1.2.3' });
    const content = await read(PR_WORKFLOW_PATH);
    const lastLine = content.trimEnd().split('\n').at(-1) ?? '';
    expect(lastLine).toMatch(/^# vdiff:managed v1 sha256:[0-9a-f]{64}$/);
    expect(content).not.toContain('<!--');
    // And it round-trips: the stamp is how a re-install knows the file is still ours.
    expect(isUnmodifiedManaged(content)).toBe(true);
    expect(parseManaged(content)?.hash).toHaveLength(64);
  });

  it('emits YAML both files can be parsed as, stamp included', async () => {
    await installGithubActions(root, { version: '1.2.3' });
    for (const path of [PR_WORKFLOW_PATH, BASELINE_WORKFLOW_PATH]) {
      const parsed = parseYaml(await read(path)) as { on?: unknown; jobs?: unknown };
      expect(parsed.jobs, path).toBeDefined();
      expect(parsed.on, path).toBeDefined();
    }
  });

  it('checks out full history, because the base side is replayed at the merge-base', async () => {
    await installGithubActions(root);
    expect(await read(PR_WORKFLOW_PATH)).toContain('fetch-depth: 0');
  });

  it('requests the permission the comment needs, and no more', async () => {
    await installGithubActions(root);
    const parsed = parseYaml(await read(PR_WORKFLOW_PATH)) as {
      permissions?: Record<string, string>;
    };
    expect(parsed.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
  });

  it('defaults the gate to none — findings are reported, the check stays green (D30)', async () => {
    await installGithubActions(root);
    expect(await read(PR_WORKFLOW_PATH)).toContain('fail-on: none');
  });

  it('watches the branch it was told about', async () => {
    await installGithubActions(root, { defaultBranch: 'trunk' });
    const parsed = parseYaml(await read(BASELINE_WORKFLOW_PATH)) as {
      on?: { push?: { branches?: string[] } };
    };
    expect(parsed.on?.push?.branches).toEqual(['trunk']);
  });
});

describe('targets', () => {
  it('names the directory it writes, and nothing agent-facing', () => {
    expect(githubActionsTargets('project')).toEqual({
      scope: 'project',
      skills: null,
      commands: null,
      instructions: null,
      workflows: '.github/workflows',
    });
  });

  it('claims no directory in a scope it does not have', () => {
    expect(githubActionsTargets('global').workflows).toBeNull();
    expect(GITHUB_ACTIONS_SCOPES).toEqual(['project']);
  });
});

describe('installing', () => {
  it('creates both files', async () => {
    const report = await installGithubActions(root);
    expect(report.written).toEqual([PR_WORKFLOW_PATH, BASELINE_WORKFLOW_PATH]);
    expect((await readdir(join(root, WORKFLOWS_DIR))).sort()).toEqual([
      'visual-diff-baseline.yml',
      'visual-diff.yml',
    ]);
  });

  it('is idempotent: a second install reports both files as current', async () => {
    await installGithubActions(root, { version: '1.2.3' });
    const again = await installGithubActions(root, { version: '1.2.3' });
    expect(again.written).toEqual([]);
    expect(again.files.map((file) => file.status)).toEqual(['unchanged', 'unchanged']);
  });

  it('refreshes its own file when the version moves', async () => {
    await installGithubActions(root, { version: '1.2.3' });
    const bumped = await installGithubActions(root, { version: '1.3.0' });
    expect(bumped.written).toEqual([PR_WORKFLOW_PATH, BASELINE_WORKFLOW_PATH]);
    expect(await read(PR_WORKFLOW_PATH)).toContain('@v1.3.0');
  });

  it('preserves a workflow a human has edited, and names it', async () => {
    await installGithubActions(root, { version: '1.2.3' });
    const edited = `${await read(PR_WORKFLOW_PATH)}\n# our own extra step\n`;
    await writeFile(join(root, PR_WORKFLOW_PATH), edited, 'utf8');

    const report = await installGithubActions(root, { version: '1.3.0' });
    expect(report.skipped).toContain(PR_WORKFLOW_PATH);
    expect(await read(PR_WORKFLOW_PATH)).toBe(edited);
    // The other file is still refreshed: preserving one edit must not freeze the whole install.
    expect(report.written).toEqual([BASELINE_WORKFLOW_PATH]);
  });

  it('--force overwrites an edited workflow', async () => {
    await installGithubActions(root, { version: '1.2.3' });
    await writeFile(join(root, PR_WORKFLOW_PATH), '# mine now\n', 'utf8');
    const report = await installGithubActions(root, { version: '1.2.3', force: true });
    expect(report.written).toContain(PR_WORKFLOW_PATH);
    expect(await read(PR_WORKFLOW_PATH)).toContain('uses: beprajwal/visual-diff@v1.2.3');
  });

  it('--dry-run reports what it would do and touches nothing', async () => {
    const report = await installGithubActions(root, { dryRun: true });
    expect(report.files.map((file) => file.status)).toEqual(['created', 'created']);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('leaves an unrelated workflow alone', async () => {
    await mkdir(join(root, WORKFLOWS_DIR), { recursive: true });
    await writeFile(join(root, WORKFLOWS_DIR, 'ci.yml'), 'name: CI\n', 'utf8');
    await installGithubActions(root);
    expect(await read(`${WORKFLOWS_DIR}/ci.yml`)).toBe('name: CI\n');
  });

  it('refuses a user-level install with the reason, rather than writing into $HOME', async () => {
    await expect(installGithubActions(root, { scope: 'global' })).rejects.toBeInstanceOf(
      UnsupportedScopeError,
    );
    await expect(installGithubActions(root, { scope: 'global' })).rejects.toThrow(
      /no global target/,
    );
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
