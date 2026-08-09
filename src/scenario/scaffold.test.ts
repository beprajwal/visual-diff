import { describe, expect, it } from 'vitest';
import type { ScenarioSpec } from '../types.js';
import { isScenarioSpecError } from './errors.js';
import {
  assertScenarioName,
  isValidScenarioName,
  scenarioFileName,
  scenarioNameIssue,
  scenarioRelPath,
  scenarioRepoPath,
  scenarioSummary,
} from './name.js';
import { parseScenarioSource } from './parse.js';
import { scaffoldScenarioSource, scaffoldScenarioSpec } from './scaffold.js';
import { canonicalScenario, serializeScenario } from './serialize.js';

describe('scaffoldScenarioSpec', () => {
  it('produces an overlay scenario by default', () => {
    const spec = scaffoldScenarioSpec('empty-forecast');
    expect(spec.version).toBe(1);
    expect(spec.scenario).toBe('empty-forecast');
    expect(spec.mode).toBe('overlay');
    expect(spec.rules).toHaveLength(1);
    expect(spec.rules[0]?.id).toBe('example');
    expect(spec.rules[0]?.patch).toEqual({ items: [] });
  });

  it('scaffolds mock mode with respond, never with the patch mock mode refuses', () => {
    const spec = scaffoldScenarioSpec('wireframe', { mode: 'mock' });
    expect(spec.mode).toBe('mock');
    expect(spec.rules[0]?.patch).toBeUndefined();
    expect(spec.rules[0]?.respond).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { items: [] },
    });
  });

  it('takes a url glob and a description', () => {
    const spec = scaffoldScenarioSpec('slow-api', {
      url: '**/v1/forecast**',
      description: 'Everything slow',
    });
    expect(spec.rules[0]?.match).toEqual({ method: 'GET', url: '**/v1/forecast**' });
    expect(spec.description).toBe('Everything slow');
  });

  it('refuses a name that could not be a filename, at exit code 2', () => {
    try {
      scaffoldScenarioSpec('../escape');
      throw new Error('expected a throw');
    } catch (error) {
      if (!isScenarioSpecError(error)) throw error;
      expect(error.exitCode).toBe(2);
      expect(error.code).toBe('invalid-scenario-name');
      expect(error.message).toContain("invalid scenario name '../escape'");
    }
  });

  it("refuses the reserved name 'none'", () => {
    try {
      scaffoldScenarioSpec('none');
      throw new Error('expected a throw');
    } catch (error) {
      if (!isScenarioSpecError(error)) throw error;
      expect(error.code).toBe('reserved-scenario-name');
      expect(error.message).toContain("'none' is a reserved scenario name");
    }
  });
});

describe('scaffoldScenarioSource', () => {
  it('parses cleanly, with no warnings, in both modes', () => {
    for (const mode of ['overlay', 'mock'] as const) {
      const source = scaffoldScenarioSource('empty-forecast', { mode });
      const result = parseScenarioSource(source, {
        file: 'empty-forecast.yaml',
        expectScenarioName: 'empty-forecast',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([]);
      expect(result.value.mode).toBe(mode);
    }
  });

  it('teaches the rules an author cannot guess from an empty file', () => {
    const source = scaffoldScenarioSource('empty-forecast');
    expect(source).toContain('exactly ONE response verb');
    expect(source).toContain('Two verbs on one rule is an error');
    expect(source).toContain('delay     milliseconds, composes with any verb');
    expect(source).toContain('First match wins in file order');
    expect(source).toContain('Rule ids are stable and load-bearing');
    expect(source).toContain('* stops at /, ** crosses it');
    expect(source).toContain('vdiff run <flow> --scenario empty-forecast');
  });

  it('explains, in a mock scaffold, why patch is refused there', () => {
    const source = scaffoldScenarioSource('wireframe', { mode: 'mock' });
    expect(source).toContain('patch and patchOps are rejected here');
    expect(source).toContain('reported as misses');
  });

  it('ends with a newline and starts with its own path', () => {
    const source = scaffoldScenarioSource('empty-forecast');
    expect(source.startsWith('# .visual-diff/scenarios/empty-forecast.yaml — scenario spec v1')).toBe(
      true,
    );
    expect(source.endsWith('\n')).toBe(true);
  });
});

describe('serializeScenario', () => {
  const spec: ScenarioSpec = {
    version: 1,
    scenario: 'empty-forecast',
    description: 'No forecast data',
    mode: 'overlay',
    rules: [
      {
        id: 'forecast-empty',
        match: { method: 'GET', url: '**/v1/forecast**', nth: 2 },
        patch: { hourly: { temperature_2m: [] } },
        delay: 250,
      },
      {
        id: 'first-day-removed',
        match: { url: '**/v1/daily**' },
        patchOps: [
          { op: 'remove', path: '/daily/time/0' },
          { op: 'move', path: '/daily/b', from: '/daily/a' },
        ],
      },
    ],
  };

  it('round-trips through the parser unchanged', () => {
    const result = parseScenarioSource(serializeScenario(spec), {
      file: 'empty-forecast.yaml',
      expectScenarioName: 'empty-forecast',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(spec);
  });

  it('fixes key order, so re-authoring the same scenario serializes identically', () => {
    const reordered: ScenarioSpec = {
      ...spec,
      rules: [
        {
          delay: 250,
          patch: { hourly: { temperature_2m: [] } },
          match: { url: '**/v1/forecast**', nth: 2, method: 'GET' },
          id: 'forecast-empty',
        },
        spec.rules[1] as ScenarioSpec['rules'][number],
      ],
    };
    expect(serializeScenario(reordered)).toBe(serializeScenario(spec));
  });

  it('materializes the mode default, so overlay written and overlay omitted are one scenario', () => {
    expect(canonicalScenario({ ...spec, mode: 'overlay' }).mode).toBe('overlay');
    expect(serializeScenario(spec)).toContain('mode: overlay');
  });

  it('puts delay last, because it modifies whatever verb precedes it', () => {
    const yaml = serializeScenario(spec);
    expect(yaml.indexOf('patch:')).toBeLessThan(yaml.indexOf('delay:'));
  });
});

describe('scenario names and paths (mocking spec §5 Storage, §11)', () => {
  it('builds the file, store-relative and repository paths', () => {
    expect(scenarioFileName('empty-forecast')).toBe('empty-forecast.yaml');
    expect(scenarioRelPath('empty-forecast')).toBe('scenarios/empty-forecast.yaml');
    expect(scenarioRepoPath('empty-forecast')).toBe(
      '.visual-diff/scenarios/empty-forecast.yaml',
    );
  });

  it('accepts the names a flow name would accept', () => {
    for (const name of ['empty-forecast', 'a', 'v1.2_x', 'A9']) {
      expect(isValidScenarioName(name)).toBe(true);
      expect(scenarioNameIssue(name)).toBeNull();
      expect(() => assertScenarioName(name)).not.toThrow();
    }
  });

  it('refuses names that are not usable, pointing at the file they would produce', () => {
    for (const name of ['none', '../escape', 'has space', '.hidden', '']) {
      expect(isValidScenarioName(name)).toBe(false);
    }
    expect(scenarioNameIssue('none')?.at.file).toBe('none.yaml');
    expect(scenarioNameIssue('none')?.at.key).toBe('scenario');
  });
});

describe('scenarioSummary', () => {
  it('is the row vdiff scenario list prints', () => {
    const spec = scaffoldScenarioSpec('empty-forecast');
    expect(scenarioSummary(spec)).toEqual({
      name: 'empty-forecast',
      mode: 'overlay',
      description: spec.description,
      ruleCount: 1,
      path: 'scenarios/empty-forecast.yaml',
    });
  });

  it('omits an absent description rather than carrying an empty one', () => {
    const summary = scenarioSummary({
      version: 1,
      scenario: 'slow-api',
      mode: 'mock',
      rules: [{ id: 'a', match: { url: '**' }, abort: true }],
    });
    expect(summary).toEqual({
      name: 'slow-api',
      mode: 'mock',
      ruleCount: 1,
      path: 'scenarios/slow-api.yaml',
    });
    expect('description' in summary).toBe(false);
  });
});
