/**
 * `vdiff install` — the first command an `npx @beprajwal/visual-diff` user ever runs.
 *
 * These tests are wired to the *real* adapter registry rather than to a double, because the whole
 * value of the command is that the files land where the harness looks for them: a fake that
 * returned three plausible paths would pass while the real thing wrote nothing. The bindings below
 * are the same ones `deps.ts` makes, so a signature drift in `src/adapters/` fails here.
 *
 * Every scope-crossing test names its own home directory. Nothing in this file may resolve the
 * real `os.homedir()`: a `--global` install that did would write into the machine running the
 * suite.
 */

import { chmod, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../types.js';
import {
  ADAPTERS,
  BLOCK_END,
  BLOCK_START,
  HARNESS_NOTES,
  getAdapter,
  installAdapter,
  readInstalledVersion,
  type HarnessId,
  type InstallScope,
} from '../../adapters/index.js';
import type { CommandContext } from '../command.js';
import { CliFailure } from '../error.js';
import type { Ports } from '../ports.js';
import { createTestPorts } from '../testing.js';
import type { InstallCheckData, InstallData, InstallListData } from '../shapes.js';
import { install } from './install.js';

const VERSION = '9.9.9';
const SKILL = '.claude/skills/visual-diff/SKILL.md';
const RUN_COMMAND = '.claude/commands/vdiff.md';

let cwd: string;
let home: string;

/** Exactly the bindings `deps.ts` makes, so these tests exercise the real module edge. */
function adapterPorts(): Partial<Ports> {
  return {
    listAdapters: async () =>
      ADAPTERS.map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        notes: HARNESS_NOTES[adapter.id],
      })),
    adapterFiles: async (id: string, scope: InstallScope) => {
      const adapter = getAdapter(id);
      if (adapter === undefined) throw new Error(`no adapter '${id}'`);
      return adapter.files(scope);
    },
    adapterTargets: async (id: string, scope: InstallScope) => {
      const adapter = getAdapter(id);
      if (adapter === undefined) throw new Error(`no adapter '${id}'`);
      return adapter.targets(scope);
    },
    installAdapter: (id, root, options) => installAdapter(id, root, options),
    readInstalledVersion: async (content: string) => readInstalledVersion(content),
  };
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd,
    home,
    ports: createTestPorts(adapterPorts()),
    version: VERSION,
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
    ...overrides,
  };
}

function invocation(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'install' as const,
    harness: 'claude-code',
    force: false,
    dryRun: false,
    json: false,
    ...overrides,
  };
}

type AnyInstall = InstallData | InstallListData | InstallCheckData;

function asInstall(data: AnyInstall): InstallData {
  if (!('harness' in data)) throw new Error('expected an install payload');
  return data;
}

function asList(data: AnyInstall): InstallListData {
  if (!('harnesses' in data) || 'drift' in data) throw new Error('expected a listing payload');
  return data;
}

function asCheck(data: AnyInstall): InstallCheckData {
  if (!('drift' in data)) throw new Error('expected a check payload');
  return data;
}

async function pathsFor(id: HarnessId, scope: InstallScope = 'project'): Promise<string[]> {
  const adapter = getAdapter(id);
  if (adapter === undefined) throw new Error(`no adapter '${id}'`);
  return (await adapter.files(scope)).map((file) => file.path);
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'vdiff-install-cwd-'));
  home = await mkdtemp(join(tmpdir(), 'vdiff-install-home-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
});

/* ------------------------------------------------------------------ project install */

describe('vdiff install <harness>', () => {
  it('writes every file the adapter composes into the working directory', async () => {
    const result = await install(context(), invocation());
    const data = asInstall(result.data);
    const paths = await pathsFor('claude-code');

    expect(result.exitCode).toBe(EXIT.OK);
    expect(data.harness).toBe('claude-code');
    expect(data.label).toBe('Claude Code');
    expect(data.scope).toBe('project');
    expect(data.root).toBe(cwd);
    expect(data.version).toBe(VERSION);
    expect(data.dryRun).toBe(false);
    expect(data.written).toEqual(paths);
    expect(data.skipped).toEqual([]);

    for (const path of data.written) {
      const content = await readFile(join(cwd, path), 'utf8');
      expect(content, path).toContain('vdiff:managed');
      expect(content.startsWith('---\n'), path).toBe(true);
    }
    await expect(readdir(home)).resolves.toEqual([]);
  });

  it('stamps the running version into every installed file (D17)', async () => {
    await install(context(), invocation());

    for (const path of await pathsFor('claude-code')) {
      const content = await readFile(join(cwd, path), 'utf8');
      expect(content, path).toContain('x-vdiff-version: "9.9.9"');
      expect(content, path).toContain('x-vdiff-source: "@beprajwal/visual-diff"');
      expect(readInstalledVersion(content), path).toBe(VERSION);
    }
  });

  it('names the real directories it wrote, not just the harness id (D18)', async () => {
    const result = await install(context(), invocation({ harness: 'codex' }));
    const data = asInstall(result.data);

    expect(data.targets).toEqual({
      scope: 'project',
      skills: '.agents/skills',
      commands: null,
      instructions: 'AGENTS.md',
    });
    const human = result.human.join('\n');
    expect(human).toContain('.agents/skills');
    expect(human, 'a mechanism the harness lacks is stated, not silently skipped (D15)').toContain(
      'Codex has none',
    );
  });

  it('prints what "installed" does not guarantee for that harness', async () => {
    const human = (await install(context(), invocation({ harness: 'pi' }))).human.join('\n');
    expect(human).toContain('note: ');
    expect(human).toContain('shadows this project one');
  });

  it('is idempotent: a second install reports the files as current, not rewritten', async () => {
    const ctx = context();
    await install(ctx, invocation());
    const before = await readFile(join(cwd, SKILL), 'utf8');

    const second = asInstall((await install(ctx, invocation())).data);
    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual(await pathsFor('claude-code'));
    expect(second.files.every((file) => file.status === 'unchanged')).toBe(true);
    await expect(readFile(join(cwd, SKILL), 'utf8')).resolves.toBe(before);
  });

  it('is idempotent for a harness with an AGENTS.md block, too (D19)', async () => {
    const ctx = context();
    await install(ctx, invocation({ harness: 'codex' }));
    const before = await readFile(join(cwd, 'AGENTS.md'), 'utf8');

    const second = asInstall((await install(ctx, invocation({ harness: 'codex' }))).data);
    expect(second.written).toEqual([]);
    expect(second.files.find((file) => file.path === 'AGENTS.md')?.status).toBe('unchanged');
    await expect(readFile(join(cwd, 'AGENTS.md'), 'utf8')).resolves.toBe(before);
  });

  it('edits AGENTS.md within its block and leaves every other byte alone (D19)', async () => {
    await writeFile(join(cwd, 'AGENTS.md'), '# House rules\n\nRun `make test`.\n', 'utf8');
    await install(context(), invocation({ harness: 'codex' }));

    const content = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
    expect(content.startsWith('# House rules\n\nRun `make test`.\n')).toBe(true);
    expect(content).toContain(BLOCK_START);
    expect(content).toContain(BLOCK_END);
    expect(content).toContain('.agents/skills');
  });

  it('preserves a human-edited file, names it, and points at --force', async () => {
    const ctx = context();
    await install(ctx, invocation());
    await writeFile(join(cwd, RUN_COMMAND), 'my own notes\n', 'utf8');

    const preserved = asInstall((await install(ctx, invocation())).data);
    expect(preserved.written).not.toContain(RUN_COMMAND);
    expect(preserved.skipped).toContain(RUN_COMMAND);
    expect(preserved.files).toContainEqual({ path: RUN_COMMAND, status: 'preserved' });
    await expect(readFile(join(cwd, RUN_COMMAND), 'utf8')).resolves.toBe('my own notes\n');

    const human = (await install(ctx, invocation())).human.join('\n');
    expect(human).toContain('--force');
    expect(human, 'the refusal must name the file it refused').toContain(RUN_COMMAND);

    const forced = asInstall((await install(ctx, invocation({ force: true }))).data);
    expect(forced.written).toContain(RUN_COMMAND);
    await expect(readFile(join(cwd, RUN_COMMAND), 'utf8')).resolves.toContain('vdiff:managed');
  });

  it('--dry-run reports what would be written and touches nothing', async () => {
    const result = await install(context(), invocation({ dryRun: true }));
    const data = asInstall(result.data);

    expect(data.dryRun).toBe(true);
    expect(data.written).toEqual(await pathsFor('claude-code'));
    expect(result.human[0]).toContain('dry run');
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it('--dry-run over an existing install still writes nothing and reports it as current', async () => {
    const ctx = context();
    await install(ctx, invocation());
    const before = await readFile(join(cwd, SKILL), 'utf8');

    const dry = asInstall((await install(ctx, invocation({ dryRun: true }))).data);
    expect(dry.written).toEqual([]);
    expect(dry.skipped).toEqual(await pathsFor('claude-code'));
    await expect(readFile(join(cwd, SKILL), 'utf8')).resolves.toBe(before);
  });

  it('--dir retargets the install, relative to the invocation directory', async () => {
    const result = await install(context(), invocation({ dir: 'packages/web' }));

    expect(asInstall(result.data).root).toBe(resolve(cwd, 'packages/web'));
    await expect(
      readFile(join(cwd, 'packages/web', SKILL), 'utf8'),
    ).resolves.toContain('# Visual Diff');
    await expect(readdir(join(cwd, '.claude'))).rejects.toThrow();
  });

  it('takes an absolute --dir as given', async () => {
    const other = await mkdtemp(join(tmpdir(), 'vdiff-install-abs-'));
    try {
      const result = await install(context(), invocation({ dir: other }));
      expect(asInstall(result.data).root).toBe(resolve(other));
      await expect(readFile(join(other, SKILL), 'utf8')).resolves.toContain('# Visual Diff');
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ scopes and precedence */

describe('vdiff install --global (D16)', () => {
  it('writes the user-level root and leaves the project untouched', async () => {
    const result = await install(context(), invocation({ global: true }));
    const data = asInstall(result.data);

    expect(data.scope).toBe('global');
    expect(data.root).toBe(home);
    await expect(readFile(join(home, SKILL), 'utf8')).resolves.toContain('# Visual Diff');
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it('resolves the global layout for a harness whose two scopes differ', async () => {
    const result = await install(context(), invocation({ harness: 'opencode', global: true }));
    const data = asInstall(result.data);

    expect(data.targets.commands).toBe('.config/opencode/commands');
    expect(data.written).toContain('.config/opencode/commands/vdiff.md');
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it('installing into one scope reports the copy in the other rather than touching it (D17)', async () => {
    const ctx = context();
    await install(ctx, invocation({ global: true }));

    const project = await install(ctx, invocation());
    expect(project.warnings?.join('\n')).toContain('global scope');
    expect(project.warnings?.join('\n')).toContain('vdiff install --check');
    // The global copy must be byte-identical: noticing is not fixing.
    await expect(readFile(join(home, SKILL), 'utf8')).resolves.toContain('x-vdiff-version: "9.9.9"');
  });

  it('calls a drifted copy in the other scope stale, and still writes nothing there', async () => {
    await install(context({ version: '0.1.0' }), invocation({ global: true }));
    const stampedBefore = await readFile(join(home, SKILL), 'utf8');

    const project = await install(context(), invocation());
    expect(project.warnings?.join('\n')).toContain('the global install of Claude Code is stale');
    await expect(readFile(join(home, SKILL), 'utf8')).resolves.toBe(stampedBefore);
  });

  it('says nothing about the other scope when --dir named the directory outright', async () => {
    const ctx = context();
    await install(ctx, invocation({ global: true }));
    const result = await install(ctx, invocation({ dir: 'packages/web' }));
    expect(result.warnings).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ errors (§6) */

describe('vdiff install — errors', () => {
  it('rejects an unknown harness with exit 2 and lists the supported ones', async () => {
    await expect(install(context(), invocation({ harness: 'aider' }))).rejects.toMatchObject({
      code: 'unknown-harness',
      exitCode: EXIT.CONFIG_ERROR,
    });

    try {
      await install(context(), invocation({ harness: 'aider' }));
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailure);
      const failure = error as CliFailure;
      expect(failure.message).toBe("unknown harness 'aider'");
      expect(failure.hint).toBe('supported harnesses: claude-code, codex, opencode, pi');
    }

    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it('lists whatever the registry holds, not a hard-coded name', async () => {
    const ctx = context({
      ports: createTestPorts({
        listAdapters: async () => [{ id: 'codex', label: 'Imaginary', notes: [] }],
      }),
    });
    try {
      await install(ctx, invocation({ harness: 'claude-code' }));
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as CliFailure).hint).toBe('supported harnesses: codex');
    }
  });

  it('refuses a malformed AGENTS.md rather than guessing where the block ends (§6, D19)', async () => {
    await writeFile(join(cwd, 'AGENTS.md'), `# Rules\n\n${BLOCK_START}\nstuff\n`, 'utf8');

    try {
      await install(context(), invocation({ harness: 'codex' }));
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailure);
      const failure = error as CliFailure;
      expect(failure.exitCode).toBe(EXIT.CONFIG_ERROR);
      expect(failure.code).toBe('malformed-agents-block');
      expect(failure.message).toContain('AGENTS.md');
      expect(failure.message).toContain('no matching');
      expect(failure.message).toContain('refusing to guess');
    }

    await expect(readFile(join(cwd, 'AGENTS.md'), 'utf8')).resolves.toBe(
      `# Rules\n\n${BLOCK_START}\nstuff\n`,
    );
  });

  it('refuses a malformed AGENTS.md under --dry-run too: the point of a dry run is to find out', async () => {
    await writeFile(join(cwd, 'AGENTS.md'), `${BLOCK_END}\nstuff\n`, 'utf8');
    await expect(
      install(context(), invocation({ harness: 'codex', dryRun: true })),
    ).rejects.toMatchObject({ code: 'malformed-agents-block', exitCode: EXIT.CONFIG_ERROR });
  });

  it('exits 2 naming the path and the underlying error when the target is not writable (§6)', async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits this test relies on
    const locked = join(cwd, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);

    try {
      await install(context(), invocation({ dir: locked }));
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailure);
      const failure = error as CliFailure;
      expect(failure.code).toBe('target-not-writable');
      expect(failure.exitCode).toBe(EXIT.CONFIG_ERROR);
      expect(failure.message).toContain(locked);
      expect(failure.message, 'the underlying error must survive').toMatch(/EACCES|permission/i);
      expect(failure.hint).toContain('--dir');
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

/* ------------------------------------------------------------------ --list */

describe('vdiff install --list', () => {
  it('names every registered harness, both scopes and the files each would write', async () => {
    const result = await install(context(), invocation({ harness: undefined, list: true }));
    const data = asList(result.data);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(data.harnesses.map((harness) => harness.id)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'pi',
    ]);
    for (const harness of data.harnesses) {
      expect(harness.scopes.map((scope) => scope.scope)).toEqual(['project', 'global']);
      expect(harness.scopes[0]?.root).toBe(cwd);
      expect(harness.scopes[1]?.root).toBe(home);
      expect(harness.notes.length).toBeGreaterThan(0);
    }

    const claude = data.harnesses[0];
    expect(claude?.scopes[0]?.files).toEqual(await pathsFor('claude-code', 'project'));
    expect(claude?.scopes[0]?.targets.skills).toBe('.claude/skills');
  });

  it('writes nothing at all', async () => {
    await install(context(), invocation({ harness: undefined, list: true }));
    await expect(readdir(cwd)).resolves.toEqual([]);
    await expect(readdir(home)).resolves.toEqual([]);
  });

  it('prints each harness, its targets, its files and how to install it', async () => {
    const human = (
      await install(context(), invocation({ harness: undefined, list: true }))
    ).human.join('\n');

    expect(human).toContain('Claude Code (claude-code)');
    expect(human).toContain('pi (pi)');
    for (const path of await pathsFor('claude-code')) expect(human).toContain(path);
    expect(human).toContain('vdiff install <harness>');
    expect(human).toContain('--global');
  });

  it('names the --dir root for both scopes when one was given', async () => {
    const result = await install(
      context(),
      invocation({ harness: undefined, list: true, dir: 'packages/web' }),
    );
    const target = resolve(cwd, 'packages/web');

    for (const harness of asList(result.data).harnesses) {
      expect(harness.scopes.map((scope) => scope.root)).toEqual([target, target]);
    }
    await expect(readdir(cwd), '--list still writes nothing under --dir').resolves.toEqual([]);
  });
});

/* ------------------------------------------------------------------ --check */

describe('vdiff install --check (§5, "Drift")', () => {
  const check = (over: Record<string, unknown> = {}) =>
    invocation({ harness: undefined, check: true, ...over });

  it('reports a fresh machine as not installed, without calling that drift, and exits 0', async () => {
    const result = await install(context(), check());
    const data = asCheck(result.data);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(data.version).toBe(VERSION);
    expect(data.drift).toBe(false);
    for (const harness of data.harnesses) {
      expect(harness.scopes.map((scope) => scope.status)).toEqual(['missing', 'missing']);
      expect(harness.scopes.every((scope) => scope.duplicate)).toBe(false);
    }
    expect(result.human.join('\n')).toContain('Nothing has drifted.');
  });

  it('reports a fresh install as current, per file', async () => {
    const ctx = context();
    await install(ctx, invocation());

    const data = asCheck((await install(ctx, check({ harness: 'claude-code' }))).data);
    const scope = data.harnesses[0]?.scopes[0];
    expect(data.harnesses).toHaveLength(1);
    expect(scope?.status).toBe('current');
    expect(scope?.files.map((file) => file.status)).toEqual(
      (await pathsFor('claude-code')).map(() => 'current'),
    );
    expect(scope?.files[0]?.installedVersion).toBe(VERSION);
    expect(data.drift).toBe(false);
  });

  it('names both versions when the installed copy is stale', async () => {
    await install(context({ version: '0.1.0' }), invocation());

    const result = await install(context(), check({ harness: 'claude-code' }));
    const data = asCheck(result.data);
    const scope = data.harnesses[0]?.scopes[0];

    expect(data.drift).toBe(true);
    expect(scope?.status).toBe('stale');
    expect(scope?.files.every((file) => file.status === 'stale')).toBe(true);
    expect(scope?.files[0]?.installedVersion).toBe('0.1.0');
    expect(result.human.join('\n')).toContain('(0.1.0 → 9.9.9)');
    expect(result.exitCode, 'drift is information, not a gate').toBe(EXIT.OK);
  });

  it('reports a hand-edited file as modified locally, not as stale', async () => {
    const ctx = context();
    await install(ctx, invocation());
    await writeFile(join(cwd, RUN_COMMAND), 'mine now\n', 'utf8');

    const data = asCheck((await install(ctx, check({ harness: 'claude-code' }))).data);
    const scope = data.harnesses[0]?.scopes[0];
    expect(scope?.status).toBe('modified-locally');
    expect(scope?.files.find((file) => file.path === RUN_COMMAND)?.status).toBe('modified-locally');
    expect(data.drift).toBe(true);
  });

  it('reports a partially deleted install as missing files rather than as current', async () => {
    const ctx = context();
    await install(ctx, invocation());
    await rm(join(cwd, RUN_COMMAND));

    const data = asCheck((await install(ctx, check({ harness: 'claude-code' }))).data);
    const scope = data.harnesses[0]?.scopes[0];
    expect(scope?.files.find((file) => file.path === RUN_COMMAND)?.status).toBe('missing');
    expect(scope?.status).toBe('missing');
  });

  it('does not call an untouched AGENTS.md an install of ours', async () => {
    await writeFile(join(cwd, 'AGENTS.md'), '# House rules\n', 'utf8');

    const data = asCheck((await install(context(), check({ harness: 'codex' }))).data);
    const agents = data.harnesses[0]?.scopes[0]?.files.find((file) => file.path === 'AGENTS.md');
    expect(agents?.status).toBe('missing');
    expect(agents?.installedVersion).toBeNull();
  });

  it('reads the version back out of an AGENTS.md block', async () => {
    await install(context({ version: '0.1.0' }), invocation({ harness: 'codex' }));

    const data = asCheck((await install(context(), check({ harness: 'codex' }))).data);
    const agents = data.harnesses[0]?.scopes[0]?.files.find((file) => file.path === 'AGENTS.md');
    expect(agents?.status).toBe('stale');
    expect(agents?.installedVersion).toBe('0.1.0');
  });

  it('reports both scopes, flags the duplication, and prints what the harness does about it', async () => {
    const ctx = context();
    await install(ctx, invocation());
    await install(ctx, invocation({ global: true }));

    const result = await install(ctx, check({ harness: 'claude-code' }));
    const data = asCheck(result.data);
    const [project, global] = data.harnesses[0]?.scopes ?? [];

    expect(project?.scope).toBe('project');
    expect(project?.root).toBe(cwd);
    expect(global?.scope).toBe('global');
    expect(global?.root).toBe(home);
    expect(project?.duplicate).toBe(true);
    expect(global?.duplicate).toBe(true);

    const human = result.human.join('\n');
    expect(human).toContain('installed in both scopes');
    expect(human).toContain('~/.claude/skills');
  });

  it('keeps a shadowed global copy visible even when it is the stale one', async () => {
    await install(context({ version: '0.1.0' }), invocation({ global: true }));
    await install(context(), invocation());

    const data = asCheck((await install(context(), check({ harness: 'claude-code' }))).data);
    const [project, global] = data.harnesses[0]?.scopes ?? [];
    expect(project?.status).toBe('current');
    expect(global?.status).toBe('stale');
    expect(data.drift).toBe(true);
  });

  it('reports a malformed AGENTS.md as an unreadable scope instead of failing (exit 0 always)', async () => {
    await writeFile(join(cwd, 'AGENTS.md'), `${BLOCK_START}\nhalf a block\n`, 'utf8');

    const result = await install(context(), check({ harness: 'codex' }));
    const scope = asCheck(result.data).harnesses[0]?.scopes[0];

    expect(result.exitCode).toBe(EXIT.OK);
    expect(scope?.status).toBe('unreadable');
    expect(scope?.error).toContain('malformed visual-diff block');
    expect(scope?.files).toEqual([]);
  });

  it('never writes anything, whatever it finds', async () => {
    await install(context(), check());
    await expect(readdir(cwd)).resolves.toEqual([]);
    await expect(readdir(home)).resolves.toEqual([]);
    expect((await install(context(), check())).human.join('\n')).toContain('never rewrites');
  });

  it('rejects an unknown harness the same way an install does', async () => {
    await expect(install(context(), check({ harness: 'aider' }))).rejects.toMatchObject({
      code: 'unknown-harness',
      exitCode: EXIT.CONFIG_ERROR,
    });
  });

  it('looks in the directory --dir named, so a --dir install can be checked at all', async () => {
    const ctx = context();
    await install(ctx, invocation({ harness: 'codex', dir: 'packages/web' }));

    const data = asCheck((await install(ctx, check({ harness: 'codex', dir: 'packages/web' }))).data);
    const scope = data.harnesses[0]?.scopes[0];

    expect(scope?.root).toBe(resolve(cwd, 'packages/web'));
    expect(scope?.status).toBe('current');
    expect(scope?.files.every((file) => file.status === 'current')).toBe(true);
    expect(data.drift).toBe(false);
  });

  it('roots both scopes at --dir, rather than reporting a home directory nobody named', async () => {
    const data = asCheck(
      (await install(context(), check({ harness: 'claude-code', dir: 'packages/web' }))).data,
    );
    const roots = data.harnesses[0]?.scopes.map((scope) => scope.root);
    expect(roots).toEqual([resolve(cwd, 'packages/web'), resolve(cwd, 'packages/web')]);
    expect(roots).not.toContain(home);
  });

  it('without --dir it still reports the real project and home roots', async () => {
    const data = asCheck((await install(context(), check({ harness: 'claude-code' }))).data);
    expect(data.harnesses[0]?.scopes.map((scope) => scope.root)).toEqual([cwd, home]);
  });

  it('does not call one --dir install a duplicate just because both scopes read that directory', async () => {
    const ctx = context();
    await install(ctx, invocation({ harness: 'claude-code', dir: 'packages/web' }));

    const result = await install(ctx, check({ harness: 'claude-code', dir: 'packages/web' }));
    const data = asCheck(result.data);

    expect(data.harnesses[0]?.scopes.every((scope) => scope.duplicate)).toBe(false);
    expect(
      result.human.join('\n'),
      'one directory described twice is not a second copy to go looking for',
    ).not.toContain('installed in both scopes');
  });
});

/* ------------------------------------------------------------------ the --json payloads */

/**
 * These are the agent-facing API (§5: "`--json` on every subcommand, snapshot-tested"). Roots are
 * substituted so the snapshot pins the shape rather than a temp directory.
 */
describe('vdiff install — the --json payloads', () => {
  const normalize = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value)
        .split(JSON.stringify(cwd).slice(1, -1))
        .join('<cwd>')
        .split(JSON.stringify(home).slice(1, -1))
        .join('<home>'),
    );

  it('install', async () => {
    const data = asInstall((await install(context(), invocation({ harness: 'codex' }))).data);
    expect(normalize(data)).toMatchInlineSnapshot(`
      {
        "dryRun": false,
        "files": [
          {
            "path": ".agents/skills/visual-diff/SKILL.md",
            "status": "created",
          },
          {
            "path": ".agents/skills/visual-diff-flows/SKILL.md",
            "status": "created",
          },
          {
            "path": ".agents/skills/visual-diff-review/SKILL.md",
            "status": "created",
          },
          {
            "path": "AGENTS.md",
            "status": "created",
          },
        ],
        "harness": "codex",
        "label": "Codex",
        "notes": [
          "Codex does not hide duplicates: a global and a project skill of the same name both stay visible in the skill selector, so a stale global copy is a choice the user sees, not a silent override.",
          "The global path ~/.agents/skills is what Codex documents. It is written on that basis and has not been verified against a live Codex install.",
        ],
        "root": "<cwd>",
        "scope": "project",
        "skipped": [],
        "targets": {
          "commands": null,
          "instructions": "AGENTS.md",
          "scope": "project",
          "skills": ".agents/skills",
        },
        "version": "9.9.9",
        "written": [
          ".agents/skills/visual-diff/SKILL.md",
          ".agents/skills/visual-diff-flows/SKILL.md",
          ".agents/skills/visual-diff-review/SKILL.md",
          "AGENTS.md",
        ],
      }
    `);
  });

  it('--list, for one harness', async () => {
    const data = asList((await install(context(), invocation({ harness: undefined, list: true }))).data);
    expect(normalize(data.harnesses.find((harness) => harness.id === 'pi'))).toMatchInlineSnapshot(`
      {
        "id": "pi",
        "label": "pi",
        "notes": [
          "pi scans global locations before project ones and keeps the first skill found for a name, so a stale copy in ~/.agents/skills or ~/.pi/agent/skills shadows this project one.",
        ],
        "scopes": [
          {
            "files": [
              ".agents/skills/visual-diff/SKILL.md",
              ".agents/skills/visual-diff-flows/SKILL.md",
              ".agents/skills/visual-diff-review/SKILL.md",
              "AGENTS.md",
            ],
            "root": "<cwd>",
            "scope": "project",
            "targets": {
              "commands": null,
              "instructions": "AGENTS.md",
              "scope": "project",
              "skills": ".agents/skills",
            },
          },
          {
            "files": [
              ".agents/skills/visual-diff/SKILL.md",
              ".agents/skills/visual-diff-flows/SKILL.md",
              ".agents/skills/visual-diff-review/SKILL.md",
            ],
            "root": "<home>",
            "scope": "global",
            "targets": {
              "commands": null,
              "instructions": null,
              "scope": "global",
              "skills": ".agents/skills",
            },
          },
        ],
      }
    `);
  });

  it('--check', async () => {
    const ctx = context();
    await install(ctx, invocation({ harness: 'claude-code' }));
    const data = asCheck(
      (await install(ctx, invocation({ harness: 'claude-code', check: true }))).data,
    );
    expect(normalize(data)).toMatchInlineSnapshot(`
      {
        "drift": false,
        "harnesses": [
          {
            "id": "claude-code",
            "label": "Claude Code",
            "notes": [
              "Claude Code resolves a name collision as enterprise > personal > project, so a copy in ~/.claude/skills overrides this project one. \`vdiff install --check\` reports both.",
            ],
            "scopes": [
              {
                "duplicate": false,
                "error": null,
                "files": [
                  {
                    "installedVersion": "9.9.9",
                    "path": ".claude/skills/visual-diff/SKILL.md",
                    "status": "current",
                  },
                  {
                    "installedVersion": "9.9.9",
                    "path": ".claude/skills/visual-diff-flows/SKILL.md",
                    "status": "current",
                  },
                  {
                    "installedVersion": "9.9.9",
                    "path": ".claude/skills/visual-diff-review/SKILL.md",
                    "status": "current",
                  },
                  {
                    "installedVersion": "9.9.9",
                    "path": ".claude/commands/vdiff.md",
                    "status": "current",
                  },
                  {
                    "installedVersion": "9.9.9",
                    "path": ".claude/commands/vdiff-review.md",
                    "status": "current",
                  },
                ],
                "root": "<cwd>",
                "scope": "project",
                "status": "current",
              },
              {
                "duplicate": false,
                "error": null,
                "files": [
                  {
                    "installedVersion": null,
                    "path": ".claude/skills/visual-diff/SKILL.md",
                    "status": "missing",
                  },
                  {
                    "installedVersion": null,
                    "path": ".claude/skills/visual-diff-flows/SKILL.md",
                    "status": "missing",
                  },
                  {
                    "installedVersion": null,
                    "path": ".claude/skills/visual-diff-review/SKILL.md",
                    "status": "missing",
                  },
                  {
                    "installedVersion": null,
                    "path": ".claude/commands/vdiff.md",
                    "status": "missing",
                  },
                  {
                    "installedVersion": null,
                    "path": ".claude/commands/vdiff-review.md",
                    "status": "missing",
                  },
                ],
                "root": "<home>",
                "scope": "global",
                "status": "missing",
              },
            ],
          },
        ],
        "version": "9.9.9",
      }
    `);
  });
});
