/**
 * `vdiff variant new|check|list` against the real filesystem for `new` (it writes a file) and the
 * in-memory ports for the rest.
 *
 * The validation *messages* are asserted verbatim, not merely the failure: they are the feature's
 * user interface (variants spec §8.5), and an agent that reads "1 issue" and a file:line is the
 * whole point of `check` existing separately from `run`.
 *
 * The scaffold is asserted to contain the one sentence that cannot be left out — that a variant
 * acts on what the application already rendered — because that constraint is the whole subsystem
 * (§1), and a template that reads like a wireframe format would teach the opposite.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT, type ValidationIssue } from '../../types.js';
import type { CommandContext } from '../command.js';
import { CliFailure } from '../error.js';
import { createTestPorts, fakeVariantSpec } from '../testing.js';
import { toVariantSummary } from '../variant.js';
import { variantCheck, variantList, variantNew } from './variant.js';

const dirs: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdiff-variant-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: '/project',
    ports: createTestPorts(),
    version: '0.1.0',
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
    ...overrides,
  };
}

/** A context rooted at a real temp directory, so `new` and `check` touch disk. */
async function onDisk(ports: Partial<Parameters<typeof createTestPorts>[0]> = {}): Promise<{
  ctx: CommandContext;
  root: string;
  file: (name: string) => string;
}> {
  const root = await tempProject();
  const ctx = context({ cwd: root, ports: createTestPorts(ports) });
  return {
    ctx,
    root,
    file: (name) => join(root, '.visual-diff', 'variants', `${name}.yaml`),
  };
}

async function failure(promise: Promise<unknown>): Promise<CliFailure> {
  try {
    await promise;
  } catch (thrown) {
    if (thrown instanceof CliFailure) return thrown;
    throw thrown;
  }
  throw new Error('expected the command to fail');
}

/* ------------------------------------------------------------------ new */

describe('vdiff variant new', () => {
  it('writes a variant that its own validator would accept, and reports a relative path', async () => {
    const { ctx, file } = await onDisk();

    const result = await variantNew(ctx, 'denser-forecast');

    expect(result.data).toEqual({
      variant: 'denser-forecast',
      path: 'variants/denser-forecast.yaml',
    });

    const yaml = await readFile(file('denser-forecast'), 'utf8');
    expect(yaml).toContain('variant: denser-forecast');
    expect(yaml).toContain('- id: example-tighter');
    // The constraint the whole subsystem rests on has to be in the file the author reads (§1).
    expect(yaml).toContain('A variant cannot invent UI');
    // The human path is absolute, because that is what a reader pastes into an editor.
    expect(result.human[0]).toBe(`created  ${file('denser-forecast')}`);
    expect(result.human.join('\n')).toContain('vdiff run <flow> --variant denser-forecast');
  });

  it('refuses to overwrite an existing variant and points at `check`', async () => {
    const { ctx, file } = await onDisk();
    await mkdir(join(file('x'), '..'), { recursive: true });
    await writeFile(file('x'), 'version: 1\n', 'utf8');

    const error = await failure(variantNew(ctx, 'x'));
    expect(error.code).toBe('variant-exists');
    expect(error.message).toBe(`variant 'x' already exists at ${file('x')}`);
    expect(error.hint).toBe('vdiff variant check x');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    // Untouched: the refusal has to be a refusal, not a partial write.
    expect(await readFile(file('x'), 'utf8')).toBe('version: 1\n');
  });
});

/* ------------------------------------------------------------------ check */

describe('vdiff variant check', () => {
  it('reports a valid variant with its rule ids and the verbs it uses', async () => {
    const { ctx, file } = await onDisk();
    await mkdir(join(file('denser-forecast'), '..'), { recursive: true });
    await writeFile(file('denser-forecast'), 'version: 1\n', 'utf8');

    const result = await variantCheck(ctx, 'denser-forecast');

    expect(result.data).toEqual({
      variant: {
        name: 'denser-forecast',
        description: 'Tighter cards, air quality hidden, upsell promoted',
        ruleCount: 3,
        verbs: ['style', 'hide', 'clone'],
        path: 'variants/denser-forecast.yaml',
      },
      warnings: [],
    });
    expect(result.human).toEqual([
      "variant 'denser-forecast' is valid",
      '  3 rules: tighter-cards, hide-air-quality, promote-upsell',
      '  verbs: style, hide, clone',
      '  Tighter cards, air quality hidden, upsell promoted',
    ]);
  });

  it('exits 2 with file, line and offending key, and the validator message verbatim', async () => {
    const issues: ValidationIssue[] = [
      {
        code: 'two-verbs',
        message: "rule 'tighter-cards' has two verbs: style and hide",
        at: {
          file: '/project/.visual-diff/variants/denser-forecast.yaml',
          line: 9,
          column: 5,
          key: 'rules[0].hide',
        },
      },
    ];
    const { ctx, file } = await onDisk({ parseVariantFile: async () => ({ ok: false, issues }) });
    await mkdir(join(file('denser-forecast'), '..'), { recursive: true });
    await writeFile(file('denser-forecast'), 'version: 1\n', 'utf8');

    const error = await failure(variantCheck(ctx, 'denser-forecast'));
    expect(error.code).toBe('variant-invalid');
    expect(error.message).toBe("variant 'denser-forecast' is invalid: 1 issue");
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.issues).toEqual(issues);
  });

  it('pluralises the issue count', async () => {
    const issues: ValidationIssue[] = [
      { code: 'a', message: 'a', at: { file: 'f' } },
      { code: 'b', message: 'b', at: { file: 'f' } },
    ];
    const { ctx, file } = await onDisk({ parseVariantFile: async () => ({ ok: false, issues }) });
    await mkdir(join(file('x'), '..'), { recursive: true });
    await writeFile(file('x'), '', 'utf8');

    expect((await failure(variantCheck(ctx, 'x'))).message).toBe("variant 'x' is invalid: 2 issues");
  });

  it('reports a missing variant as a config error pointing at `new`', async () => {
    const { ctx, file } = await onDisk();

    const error = await failure(variantCheck(ctx, 'nope'));
    expect(error.code).toBe('variant-missing');
    expect(error.message).toBe(`no variant 'nope' at ${file('nope')}`);
    expect(error.hint).toBe('vdiff variant new nope');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
  });

  it('surfaces a valid variant’s warnings without failing it', async () => {
    const warnings: ValidationIssue[] = [
      {
        code: 'shadowed-rule',
        message: "rule 'later' can never apply: 'earlier' hides every element it matches",
        at: { file: 'variants/x.yaml', line: 12, key: 'rules[1]' },
      },
    ];
    const { ctx, file } = await onDisk({
      parseVariantFile: async () => ({
        ok: true,
        value: fakeVariantSpec({ variant: 'x' }),
        warnings,
      }),
    });
    await mkdir(join(file('x'), '..'), { recursive: true });
    await writeFile(file('x'), '', 'utf8');

    const result = await variantCheck(ctx, 'x');
    expect(result.data.warnings).toEqual(warnings);
    expect(result.warnings).toEqual([
      "shadowed-rule: rule 'later' can never apply: 'earlier' hides every element it matches",
    ]);
  });
});

/* ------------------------------------------------------------------ list */

describe('vdiff variant list', () => {
  it('enumerates variants with their rule counts and verbs, sorted', async () => {
    const seen: string[] = [];
    const ctx = context({
      ports: createTestPorts({
        listVariants: async () => ['denser-forecast', 'sidebar-upsell'],
        parseVariantFile: async (file) => {
          seen.push(file);
          const name = file.split('/').pop()?.replace('.yaml', '') ?? '';
          return {
            ok: true,
            value: fakeVariantSpec({
              variant: name,
              rules: [{ id: 'r1', match: '[data-test=card]', text: 'Save this location' }],
            }),
            warnings: [],
          };
        },
      }),
    });

    const result = await variantList(ctx);

    expect(result.data.variants.map((variant) => variant.name)).toEqual([
      'denser-forecast',
      'sidebar-upsell',
    ]);
    expect(result.data.variants[0]).toEqual({
      name: 'denser-forecast',
      description: 'Tighter cards, air quality hidden, upsell promoted',
      ruleCount: 1,
      verbs: ['text'],
      path: 'variants/denser-forecast.yaml',
    });
    expect(seen).toEqual([
      '/project/.visual-diff/variants/denser-forecast.yaml',
      '/project/.visual-diff/variants/sidebar-upsell.yaml',
    ]);
    expect(result.human[0]).toContain('VARIANT');
    expect(result.human[0]).toContain('VERBS');
  });

  it('warns about an unreadable variant instead of dropping it silently', async () => {
    const ctx = context({
      ports: createTestPorts({
        listVariants: async () => ['broken', 'fine'],
        parseVariantFile: async (file) =>
          file.includes('broken')
            ? {
                ok: false,
                issues: [
                  { code: 'unknown-key', message: "unknown key 'html'", at: { file, line: 6 } },
                  { code: 'missing-id', message: 'rule is missing an id', at: { file, line: 9 } },
                ],
              }
            : { ok: true, value: fakeVariantSpec({ variant: 'fine' }), warnings: [] },
      }),
    });

    const result = await variantList(ctx);

    expect(result.data.variants.map((v) => v.name)).toEqual(['fine']);
    expect(result.warnings).toEqual([
      "variant 'broken' is invalid: 2 issues — vdiff variant check broken",
    ]);
  });

  it('says where variants would live when there are none', async () => {
    const ctx = context({ ports: createTestPorts({ listVariants: async () => [] }) });

    const result = await variantList(ctx);
    expect(result.data).toEqual({ variants: [] });
    expect(result.human).toEqual([
      'no variants in /project/.visual-diff/variants — `vdiff variant new <name>`',
    ]);
  });

  it('distinguishes "none written" from "none valid"', async () => {
    const ctx = context({
      ports: createTestPorts({
        listVariants: async () => ['broken'],
        parseVariantFile: async (file) => ({
          ok: false,
          issues: [{ code: 'unknown-key', message: 'x', at: { file } }],
        }),
      }),
    });

    const result = await variantList(ctx);
    expect(result.human).toEqual(['no valid variants in /project/.visual-diff/variants']);
  });
});

/* ------------------------------------------------------------------ projection */

describe('toVariantSummary', () => {
  it('omits an absent description rather than emitting null', () => {
    const summary = toVariantSummary({ version: 1, variant: 'x', rules: [] });
    expect(summary).toEqual({ name: 'x', ruleCount: 0, verbs: [], path: 'variants/x.yaml' });
    expect('description' in summary).toBe(false);
  });

  it('reports verbs in vocabulary order, deduplicated, not in the order they were written', () => {
    const summary = toVariantSummary({
      version: 1,
      variant: 'x',
      rules: [
        { id: 'a', match: '.a', hide: true },
        { id: 'b', match: '.b', style: { padding: '8px' } },
        { id: 'c', match: '.c', hide: true },
      ],
    });
    expect(summary.verbs).toEqual(['style', 'hide']);
    expect(summary.ruleCount).toBe(3);
  });
});
