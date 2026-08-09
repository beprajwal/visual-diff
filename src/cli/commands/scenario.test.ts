/**
 * `vdiff scenario new|check|list` against the real filesystem for `new` (it writes a file) and the
 * in-memory ports for the rest.
 *
 * The validation *messages* are asserted verbatim, not merely the failure: they are the feature's
 * user interface (mocking spec §10.4), and an agent that reads "1 issue" and a file:line is the
 * whole point of `check` existing separately from `run`.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT, type ValidationIssue } from '../../types.js';
import type { CommandContext } from '../command.js';
import { CliFailure } from '../error.js';
import { createTestPorts, fakeScenarioSpec } from '../testing.js';
import { scenarioCheck, scenarioList, scenarioNew, toScenarioSummary } from './scenario.js';

const dirs: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdiff-scenario-'));
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
    file: (name) => join(root, '.visual-diff', 'scenarios', `${name}.yaml`),
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

describe('vdiff scenario new', () => {
  it('writes a scenario that its own validator would accept, and reports a relative path', async () => {
    const { ctx, file } = await onDisk();

    const result = await scenarioNew(ctx, 'empty-forecast');

    expect(result.data).toEqual({
      scenario: 'empty-forecast',
      path: 'scenarios/empty-forecast.yaml',
      mode: 'overlay',
    });

    const yaml = await readFile(file('empty-forecast'), 'utf8');
    expect(yaml).toContain('scenario: empty-forecast');
    expect(yaml).toContain('mode: overlay');
    expect(yaml).toContain('- id: example-empty');
    // The human path is absolute, because that is what a reader pastes into an editor.
    expect(result.human[0]).toBe(`created  ${file('empty-forecast')}`);
    expect(result.human.join('\n')).toContain('vdiff run <flow> --scenario empty-forecast');
  });

  it('refuses to overwrite an existing scenario and points at `check`', async () => {
    const { ctx, file } = await onDisk();
    await mkdir(join(file('x'), '..'), { recursive: true });
    await writeFile(file('x'), 'version: 1\n', 'utf8');

    const error = await failure(scenarioNew(ctx, 'x'));
    expect(error.code).toBe('scenario-exists');
    expect(error.message).toBe(`scenario 'x' already exists at ${file('x')}`);
    expect(error.hint).toBe('vdiff scenario check x');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    // Untouched: the refusal has to be a refusal, not a partial write.
    expect(await readFile(file('x'), 'utf8')).toBe('version: 1\n');
  });
});

/* ------------------------------------------------------------------ check */

describe('vdiff scenario check', () => {
  it('reports a valid scenario with its mode and rule ids', async () => {
    const { ctx, file } = await onDisk();
    await mkdir(join(file('empty-forecast'), '..'), { recursive: true });
    await writeFile(file('empty-forecast'), 'version: 1\n', 'utf8');

    const result = await scenarioCheck(ctx, 'empty-forecast');

    expect(result.data).toEqual({
      scenario: {
        name: 'empty-forecast',
        mode: 'overlay',
        description: 'No forecast data, for checking the empty state',
        ruleCount: 2,
        path: 'scenarios/empty-forecast.yaml',
      },
      warnings: [],
    });
    expect(result.human).toEqual([
      "scenario 'empty-forecast' is valid",
      '  mode: overlay',
      '  2 rules: forecast-empty, no-analytics',
      '  No forecast data, for checking the empty state',
    ]);
  });

  it('exits 2 with file, line and offending key, and the validator message verbatim', async () => {
    const issues: ValidationIssue[] = [
      {
        code: 'two-verbs',
        message: "rule 'forecast-empty' has two response verbs: patch and respond",
        at: {
          file: '/project/.visual-diff/scenarios/empty-forecast.yaml',
          line: 9,
          column: 5,
          key: 'rules[0].respond',
        },
      },
    ];
    const { ctx, file } = await onDisk({ parseScenarioFile: async () => ({ ok: false, issues }) });
    await mkdir(join(file('empty-forecast'), '..'), { recursive: true });
    await writeFile(file('empty-forecast'), 'version: 1\n', 'utf8');

    const error = await failure(scenarioCheck(ctx, 'empty-forecast'));
    expect(error.code).toBe('scenario-invalid');
    expect(error.message).toBe("scenario 'empty-forecast' is invalid: 1 issue");
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.issues).toEqual(issues);
  });

  it('pluralises the issue count', async () => {
    const issues: ValidationIssue[] = [
      { code: 'a', message: 'a', at: { file: 'f' } },
      { code: 'b', message: 'b', at: { file: 'f' } },
    ];
    const { ctx, file } = await onDisk({ parseScenarioFile: async () => ({ ok: false, issues }) });
    await mkdir(join(file('x'), '..'), { recursive: true });
    await writeFile(file('x'), '', 'utf8');

    expect((await failure(scenarioCheck(ctx, 'x'))).message).toBe("scenario 'x' is invalid: 2 issues");
  });

  it('reports a missing scenario as a config error pointing at `new`', async () => {
    const { ctx, file } = await onDisk();

    const error = await failure(scenarioCheck(ctx, 'nope'));
    expect(error.code).toBe('scenario-missing');
    expect(error.message).toBe(`no scenario 'nope' at ${file('nope')}`);
    expect(error.hint).toBe('vdiff scenario new nope');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
  });

  it('surfaces a valid scenario’s warnings without failing it', async () => {
    const warnings: ValidationIssue[] = [
      {
        code: 'shadowed-rule',
        message: "rule 'later' can never match: 'earlier' matches every request it does",
        at: { file: 'scenarios/x.yaml', line: 12, key: 'rules[1]' },
      },
    ];
    const { ctx, file } = await onDisk({
      parseScenarioFile: async () => ({
        ok: true,
        value: fakeScenarioSpec({ scenario: 'x' }),
        warnings,
      }),
    });
    await mkdir(join(file('x'), '..'), { recursive: true });
    await writeFile(file('x'), '', 'utf8');

    const result = await scenarioCheck(ctx, 'x');
    expect(result.data.warnings).toEqual(warnings);
    expect(result.warnings).toEqual([
      "shadowed-rule: rule 'later' can never match: 'earlier' matches every request it does",
    ]);
  });
});

/* ------------------------------------------------------------------ list */

describe('vdiff scenario list', () => {
  it('enumerates scenarios with their modes, sorted', async () => {
    const seen: string[] = [];
    const ctx = context({
      ports: createTestPorts({
        listScenarios: async () => ['empty-forecast', 'slow-air'],
        parseScenarioFile: async (file) => {
          seen.push(file);
          const name = file.split('/').pop()?.replace('.yaml', '') ?? '';
          return {
            ok: true,
            value: fakeScenarioSpec({
              scenario: name,
              mode: name === 'slow-air' ? 'mock' : 'overlay',
              rules: [{ id: 'r1', match: { url: '**' }, abort: true }],
            }),
            warnings: [],
          };
        },
      }),
    });

    const result = await scenarioList(ctx);

    expect(result.data.scenarios).toEqual([
      {
        name: 'empty-forecast',
        mode: 'overlay',
        description: 'No forecast data, for checking the empty state',
        ruleCount: 1,
        path: 'scenarios/empty-forecast.yaml',
      },
      {
        name: 'slow-air',
        mode: 'mock',
        description: 'No forecast data, for checking the empty state',
        ruleCount: 1,
        path: 'scenarios/slow-air.yaml',
      },
    ]);
    expect(seen).toEqual([
      '/project/.visual-diff/scenarios/empty-forecast.yaml',
      '/project/.visual-diff/scenarios/slow-air.yaml',
    ]);
    expect(result.human[0]).toContain('SCENARIO');
    expect(result.human.join('\n')).toContain('mock');
  });

  it('warns about an unreadable scenario instead of dropping it silently', async () => {
    const ctx = context({
      ports: createTestPorts({
        listScenarios: async () => ['broken', 'fine'],
        parseScenarioFile: async (file) =>
          file.includes('broken')
            ? {
                ok: false,
                issues: [
                  { code: 'unknown-key', message: "unknown key 'patchOp'", at: { file, line: 6 } },
                  { code: 'missing-id', message: 'rule is missing an id', at: { file, line: 9 } },
                ],
              }
            : { ok: true, value: fakeScenarioSpec({ scenario: 'fine' }), warnings: [] },
      }),
    });

    const result = await scenarioList(ctx);

    expect(result.data.scenarios.map((s) => s.name)).toEqual(['fine']);
    expect(result.warnings).toEqual([
      "scenario 'broken' is invalid: 2 issues — vdiff scenario check broken",
    ]);
  });

  it('says where scenarios would live when there are none', async () => {
    const ctx = context({ ports: createTestPorts({ listScenarios: async () => [] }) });

    const result = await scenarioList(ctx);
    expect(result.data).toEqual({ scenarios: [] });
    expect(result.human).toEqual([
      'no scenarios in /project/.visual-diff/scenarios — `vdiff scenario new <name>`',
    ]);
  });

  it('distinguishes "none written" from "none valid"', async () => {
    const ctx = context({
      ports: createTestPorts({
        listScenarios: async () => ['broken'],
        parseScenarioFile: async (file) => ({
          ok: false,
          issues: [{ code: 'unknown-key', message: 'x', at: { file } }],
        }),
      }),
    });

    const result = await scenarioList(ctx);
    expect(result.human).toEqual(['no valid scenarios in /project/.visual-diff/scenarios']);
  });
});

/* ------------------------------------------------------------------ projection */

describe('toScenarioSummary', () => {
  it('omits an absent description rather than emitting null', () => {
    const summary = toScenarioSummary({ version: 1, scenario: 'x', mode: 'overlay', rules: [] });
    expect(summary).toEqual({ name: 'x', mode: 'overlay', ruleCount: 0, path: 'scenarios/x.yaml' });
    expect('description' in summary).toBe(false);
  });
});
