import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../types.js';
import type { CommandContext } from '../command.js';
import { CliFailure } from '../error.js';
import type { Ports } from '../ports.js';
import { createTestPorts, createTestStore, fakeFlowSpec } from '../testing.js';
import { flowCheck, flowNew } from './flow.js';

let cwd: string;

function context(overrides: Partial<Ports> = {}): CommandContext {
  const store = createTestStore({ root: cwd });
  return {
    cwd,
    ports: createTestPorts({ openStore: async () => store, ...overrides }),
    version: '0.1.0',
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
  };
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'vdiff-flow-'));
  await mkdir(join(cwd, '.visual-diff', 'flows'), { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('vdiff flow new', () => {
  it('writes a spec named after the flow', async () => {
    const result = await flowNew(context(), 'checkout');

    expect(result.data).toEqual({
      flow: 'checkout',
      path: join(cwd, '.visual-diff/flows/checkout.yaml'),
      created: true,
    });

    const written = await readFile(result.data.path, 'utf8');
    expect(written).toContain('flow: checkout');
    expect(written).toContain('version: 1');
  });

  it('refuses to overwrite an existing spec — exit 2, not silent data loss', async () => {
    await writeFile(join(cwd, '.visual-diff/flows/checkout.yaml'), 'version: 1\n', 'utf8');

    await expect(flowNew(context(), 'checkout')).rejects.toMatchObject({
      code: 'flow-exists',
      exitCode: EXIT.CONFIG_ERROR,
    });
    expect(await readFile(join(cwd, '.visual-diff/flows/checkout.yaml'), 'utf8')).toBe('version: 1\n');
  });

  it('rejects a name that would escape the flows directory', async () => {
    for (const name of ['../../etc/passwd', 'a/b', '.hidden', '']) {
      await expect(flowNew(context(), name), name).rejects.toMatchObject({
        code: 'invalid-flow-name',
        exitCode: EXIT.CONFIG_ERROR,
      });
    }
  });
});

describe('vdiff flow check', () => {
  it('summarises a valid spec without running it', async () => {
    const result = await flowCheck(context(), 'checkout');

    expect(result.data).toEqual({
      flow: 'checkout',
      path: join(cwd, '.visual-diff/flows/checkout.yaml'),
      valid: true,
      steps: 2,
      viewports: ['1280x800', '390x844'],
      stepIds: ['cart', 'pay-form'],
      warnings: [],
    });
    expect(result.human[0]).toBe("flow 'checkout' is valid");
  });

  it('surfaces validator warnings without failing', async () => {
    const warnings = [
      {
        code: 'no-shots',
        message: 'no step captures a shot, so this flow produces nothing to diff',
        at: { file: 'checkout.yaml' },
      },
    ];
    const result = await flowCheck(
      context({
        parseFlowFile: async () => ({ ok: true, value: fakeFlowSpec(), warnings }),
      }),
      'checkout',
    );

    expect(result.data.warnings).toEqual(warnings);
    expect(result.warnings).toEqual([
      'no-shots: no step captures a shot, so this flow produces nothing to diff',
    ]);
  });

  it('turns validation issues into an exit-2 failure carrying every issue (spec §10)', async () => {
    const issues = [
      {
        code: 'duplicate-id',
        message: "duplicate step id 'cart'",
        at: { file: 'checkout.yaml', line: 9, key: 'steps[3].id' },
      },
      {
        code: 'unknown-verb',
        message: "unknown verb 'tap'",
        at: { file: 'checkout.yaml', line: 14, key: 'steps[5].tap' },
      },
    ];

    const failure = await flowCheck(
      context({ parseFlowFile: async () => ({ ok: false, issues }) }),
      'checkout',
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CliFailure);
    expect((failure as CliFailure).toCliError()).toEqual({
      code: 'flow-invalid',
      message: "flow 'checkout' is invalid: 2 issues",
      exitCode: EXIT.CONFIG_ERROR,
      issues,
    });
  });
});
