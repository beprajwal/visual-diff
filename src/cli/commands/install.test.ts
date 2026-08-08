/**
 * `vdiff install <harness>` — the first command an `npx @beprajwal/visual-diff` user ever runs.
 *
 * These tests are wired to the *real* adapter registry rather than to a double, because the whole
 * value of the command is that the files land where the harness looks for them; a fake that
 * returns three plausible paths would pass while the real thing wrote nothing.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../types.js';
import { ADAPTERS, claudeCodeFiles, installAdapter } from '../../adapters/index.js';
import { splitFrontmatter } from '../../adapters/frontmatter.js';
import type { CommandContext } from '../command.js';
import { CliFailure } from '../error.js';
import { createTestPorts } from '../testing.js';
import type { InstallData, InstallListData } from '../shapes.js';
import { install } from './install.js';

let cwd: string;
/** The exact set of project-relative paths a claude-code install writes, in order. */
let paths: string[];

const SKILL = '.claude/skills/visual-diff/SKILL.md';
const RUN_COMMAND = '.claude/commands/vdiff.md';

/** Ports whose adapter edge is the real module — everything else stays an in-memory double. */
function context(): CommandContext {
  return {
    cwd,
    ports: createTestPorts({
      listAdapters: async () => ADAPTERS.map((a) => ({ id: a.id, label: a.label })),
      installAdapter: (id, root, options) => installAdapter(id, root, options),
    }),
    version: '0.1.0',
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
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

function asInstall(data: InstallData | InstallListData): InstallData {
  if (!('harness' in data)) throw new Error('expected an install payload, got a listing');
  return data;
}

function asList(data: InstallData | InstallListData): InstallListData {
  if (!('harnesses' in data)) throw new Error('expected a listing payload, got an install');
  return data;
}

beforeAll(async () => {
  paths = (await claudeCodeFiles()).map((file) => file.path);
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'vdiff-install-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('vdiff install <harness> (spec §9)', () => {
  it('writes three skills and two commands into the working directory', async () => {
    const result = await install(context(), invocation());
    const data = asInstall(result.data);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(data.harness).toBe('claude-code');
    expect(data.label).toBe('Claude Code');
    expect(data.root).toBe(cwd);
    expect(data.dryRun).toBe(false);
    expect(data.written).toEqual(paths);
    expect(data.skipped).toEqual([]);

    expect(data.written).toEqual([
      '.claude/skills/visual-diff/SKILL.md',
      '.claude/skills/visual-diff-flows/SKILL.md',
      '.claude/skills/visual-diff-review/SKILL.md',
      '.claude/commands/vdiff.md',
      '.claude/commands/vdiff-review.md',
    ]);

    for (const path of data.written) {
      const content = await readFile(join(cwd, path), 'utf8');
      expect(content, path).toContain('vdiff:managed');
      expect(content.startsWith('---\n'), path).toBe(true);
    }
  });

  it('gives each installed skill the frontmatter the harness needs', async () => {
    await install(context(), invocation());

    const skill = splitFrontmatter(await readFile(join(cwd, SKILL), 'utf8'));
    expect(skill?.fields.name).toBe('visual-diff');
    expect(skill?.fields.description).toMatch(/^".*"$/);
    expect(skill?.fields.description).toContain('Use after changing');
    expect(skill?.body).toContain('# Visual Diff');

    const flows = splitFrontmatter(
      await readFile(join(cwd, '.claude/skills/visual-diff-flows/SKILL.md'), 'utf8'),
    );
    expect(flows?.fields.name).toBe('visual-diff-flows');

    const command = splitFrontmatter(await readFile(join(cwd, RUN_COMMAND), 'utf8'));
    expect(command?.fields['argument-hint']).toBe('[flow]');
    expect(command?.fields['allowed-tools']).toContain('Bash(vdiff:*)');
    expect(command?.body).toContain('Load the `visual-diff` skill');
  });

  it('installs the skill bodies byte-for-byte from the shipped sources', async () => {
    await install(context(), invocation());
    const composed = await claudeCodeFiles();

    for (const file of composed) {
      const onDisk = await readFile(join(cwd, file.path), 'utf8');
      expect(onDisk.startsWith(file.body.trimEnd()), file.path).toBe(true);
    }
  });

  it('is idempotent: a second install reports the files as current, not rewritten', async () => {
    const ctx = context();
    await install(ctx, invocation());
    const second = asInstall((await install(ctx, invocation())).data);

    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual(paths);
    expect(second.files.every((file) => file.status === 'unchanged')).toBe(true);
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
    expect(data.written).toEqual(paths);
    expect(result.human[0]).toContain('dry run');
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it('--dry-run over an existing install still writes nothing and reports it as current', async () => {
    const ctx = context();
    await install(ctx, invocation());
    const before = await readFile(join(cwd, SKILL), 'utf8');

    const dry = asInstall((await install(ctx, invocation({ dryRun: true }))).data);
    expect(dry.written).toEqual([]);
    expect(dry.skipped).toEqual(paths);
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

  it('rejects an unknown harness with exit 2 and lists the supported ones', async () => {
    await expect(install(context(), invocation({ harness: 'opencode' }))).rejects.toMatchObject({
      code: 'unknown-harness',
      exitCode: EXIT.CONFIG_ERROR,
    });

    try {
      await install(context(), invocation({ harness: 'opencode' }));
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailure);
      const failure = error as CliFailure;
      expect(failure.message).toContain("unknown harness 'opencode'");
      expect(failure.hint).toContain('claude-code');
    }

    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it('lists whatever the registry holds, not a hard-coded name', async () => {
    const ctx: CommandContext = {
      ...context(),
      ports: createTestPorts({
        listAdapters: async () => [
          { id: 'claude-code', label: 'Claude Code' },
          // A second adapter must appear in the message without touching this command.
          { id: 'claude-code' as const, label: 'Imaginary' },
        ],
      }),
    };
    try {
      await install(ctx, invocation({ harness: 'nope' }));
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as CliFailure).hint).toBe('supported harnesses: claude-code, claude-code');
    }
  });
});

describe('vdiff install --list', () => {
  it('names every registered harness and the files it would write', async () => {
    const result = await install(context(), invocation({ harness: undefined, list: true }));
    const data = asList(result.data);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(data.harnesses.map((h) => h.id)).toEqual(['claude-code']);
    expect(data.harnesses[0]?.label).toBe('Claude Code');
    expect(data.harnesses[0]?.files).toEqual(paths);
  });

  it('writes nothing at all', async () => {
    await install(context(), invocation({ harness: undefined, list: true }));
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it('prints the harness, its files, and how to install it', async () => {
    const human = (
      await install(context(), invocation({ harness: undefined, list: true }))
    ).human.join('\n');

    expect(human).toContain('Claude Code (claude-code)');
    for (const path of paths) expect(human).toContain(path);
    expect(human).toContain('vdiff install <harness>');
  });
});
