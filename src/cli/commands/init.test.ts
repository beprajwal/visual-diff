import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandContext } from '../command.js';
import { createTestPorts } from '../testing.js';
import { init } from './init.js';

let cwd: string;

function context(): CommandContext {
  return {
    cwd,
    ports: createTestPorts(),
    version: '0.1.0',
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
  };
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'vdiff-init-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('vdiff init (spec §6, §9)', () => {
  it('scaffolds config, the example flow and the gitignore rules', async () => {
    const result = await init(context());

    expect(result.data.created).toEqual([
      '.visual-diff/config.yaml',
      '.visual-diff/flows/example.yaml',
    ]);
    expect(result.data.skipped).toEqual([]);
    expect(result.data.gitignore).toBe('created');

    const config = await readFile(join(cwd, '.visual-diff/config.yaml'), 'utf8');
    // Every key the spec's configuration example names.
    for (const key of [
      'install:',
      'dev:',
      'readyOn:',
      'readyTimeout:',
      'minRegionArea: 64',
      'maxRegions: 40',
      'antialiasTolerance: 0.1',
      'ignore:',
      'redact:',
      'keepRuns: 20',
    ]) {
      expect(config, `config.yaml should mention ${key}`).toContain(key);
    }
  });

  it('writes the gitignore block from spec §6 exactly, so flows and config stay committed', async () => {
    await init(context());
    const gitignore = await readFile(join(cwd, '.gitignore'), 'utf8');

    expect(gitignore).toContain('.visual-diff/*');
    expect(gitignore).toContain('!.visual-diff/config.yaml');
    expect(gitignore).toContain('!.visual-diff/flows/');
    // Scenarios are read out of git at the target SHA exactly as flows are (mocking spec §5
    // "Storage"), so an ignored scenario reads as absent at every revision but the working tree.
    expect(gitignore).toContain('!.visual-diff/scenarios/');
  });

  it('scaffolds an example flow that parses as a v1 spec with a stable step id', async () => {
    await init(context());
    const flow = await readFile(join(cwd, '.visual-diff/flows/example.yaml'), 'utf8');

    expect(flow).toContain('version: 1');
    expect(flow).toContain('flow: example');
    expect(flow).toContain('- id: home');
    expect(flow).toContain('viewports: [1280x800, 390x844]');
    // The vocabulary is closed and `sleep` is refused by the validator, so the scaffold must not
    // teach it (spec §6).
    expect(flow).not.toContain('sleep:');
  });

  it('is idempotent: a second run overwrites nothing and appends no second gitignore block', async () => {
    await init(context());
    await writeFile(join(cwd, '.visual-diff/config.yaml'), 'app: { dev: mine }\n', 'utf8');

    const second = await init(context());

    expect(second.data.created).toEqual([]);
    expect(second.data.skipped).toEqual([
      '.visual-diff/config.yaml',
      '.visual-diff/flows/example.yaml',
    ]);
    expect(second.data.gitignore).toBe('unchanged');

    expect(await readFile(join(cwd, '.visual-diff/config.yaml'), 'utf8')).toBe('app: { dev: mine }\n');

    const gitignore = await readFile(join(cwd, '.gitignore'), 'utf8');
    expect(gitignore.split('.visual-diff/*')).toHaveLength(2);
  });

  it('appends to an existing gitignore instead of replacing it', async () => {
    await writeFile(join(cwd, '.gitignore'), 'node_modules/', 'utf8');

    const result = await init(context());

    expect(result.data.gitignore).toBe('updated');
    const gitignore = await readFile(join(cwd, '.gitignore'), 'utf8');
    expect(gitignore.startsWith('node_modules/\n')).toBe(true);
    expect(gitignore).toContain('!.visual-diff/flows/');
  });
});
