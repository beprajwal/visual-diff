/**
 * `vdiff install <harness>` — the first command an `npx visual-diff` user ever runs.
 *
 * These tests are wired to the *real* adapter registry rather than to a double, because the whole
 * value of the command is that the files land where the harness looks for them; a fake that
 * returns three plausible paths would pass while the real thing wrote nothing.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../types.js';
import { ADAPTERS, CLAUDE_CODE_PATHS, installAdapter } from '../../adapters/index.js';
import type { CommandContext } from '../command.js';
import { CliFailure } from '../error.js';
import { createTestPorts } from '../testing.js';
import { install } from './install.js';

let cwd: string;

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

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'vdiff-install-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('vdiff install <harness> (spec §9)', () => {
  it('writes the skill and both command files into the working directory', async () => {
    const result = await install(context(), invocation());

    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.data.harness).toBe('claude-code');
    expect(result.data.label).toBe('Claude Code');
    expect(result.data.root).toBe(cwd);
    expect(result.data.dryRun).toBe(false);
    expect(result.data.written).toEqual(Object.values(CLAUDE_CODE_PATHS));
    expect(result.data.skipped).toEqual([]);

    const skill = await readFile(join(cwd, CLAUDE_CODE_PATHS.skill), 'utf8');
    expect(skill).toContain('vdiff');
    expect(skill).toContain('vdiff:managed');
  });

  it('is idempotent: a second install reports the files as current, not rewritten', async () => {
    const ctx = context();
    await install(ctx, invocation());
    const second = await install(ctx, invocation());

    expect(second.data.written).toEqual([]);
    expect(second.data.skipped).toEqual(Object.values(CLAUDE_CODE_PATHS));
    expect(second.data.files.every((file) => file.status === 'unchanged')).toBe(true);
  });

  it('preserves a human-edited file, says so, and points at --force', async () => {
    const ctx = context();
    await install(ctx, invocation());
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cwd, CLAUDE_CODE_PATHS.runCommand), 'my own notes\n', 'utf8');

    const preserved = await install(ctx, invocation());
    expect(preserved.data.written).not.toContain(CLAUDE_CODE_PATHS.runCommand);
    expect(preserved.data.skipped).toContain(CLAUDE_CODE_PATHS.runCommand);
    expect(preserved.human.join('\n')).toContain('--force');
    await expect(readFile(join(cwd, CLAUDE_CODE_PATHS.runCommand), 'utf8')).resolves.toBe(
      'my own notes\n',
    );

    const forced = await install(ctx, invocation({ force: true }));
    expect(forced.data.written).toContain(CLAUDE_CODE_PATHS.runCommand);
    await expect(readFile(join(cwd, CLAUDE_CODE_PATHS.runCommand), 'utf8')).resolves.toContain(
      'vdiff:managed',
    );
  });

  it('--dry-run reports what would be written and touches nothing', async () => {
    const result = await install(context(), invocation({ dryRun: true }));

    expect(result.data.dryRun).toBe(true);
    expect(result.data.written).toEqual(Object.values(CLAUDE_CODE_PATHS));
    expect(result.human[0]).toContain('dry run');
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it('--dir retargets the install, relative to the invocation directory', async () => {
    const result = await install(context(), invocation({ dir: 'packages/web' }));

    expect(result.data.root).toBe(resolve(cwd, 'packages/web'));
    await expect(
      readFile(join(cwd, 'packages/web', CLAUDE_CODE_PATHS.skill), 'utf8'),
    ).resolves.toContain('vdiff');
    await expect(readdir(join(cwd, '.claude'))).rejects.toThrow();
  });

  it('takes an absolute --dir as given', async () => {
    const other = await mkdtemp(join(tmpdir(), 'vdiff-install-abs-'));
    try {
      const result = await install(context(), invocation({ dir: other }));
      expect(result.data.root).toBe(resolve(other));
      await expect(readFile(join(other, CLAUDE_CODE_PATHS.skill), 'utf8')).resolves.toContain(
        'vdiff',
      );
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
