import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ValidationIssue, ValidationResult } from '../types.js';
import { isScenarioSpecError } from './errors.js';
import {
  loadScenarioSource,
  parseScenarioFile,
  parseScenarioSource,
  scenarioNameFromFile,
} from './parse.js';

/** The example from mocking spec §5, verbatim. */
const SPEC_EXAMPLE = `version: 1
scenario: empty-forecast
description: No forecast data, for checking the empty state
mode: overlay                      # overlay (default) | mock
rules:
  - id: forecast-empty             # stable, required
    match: { method: GET, url: "**/v1/forecast**" }
    patch: { hourly: { temperature_2m: [] } }     # JSON merge patch on the recorded body

  - id: geocode-fails
    match: { method: GET, url: "**/v1/search**" }
    respond:
      status: 500
      headers: { content-type: application/json }
      body: { error: upstream_unavailable }

  - id: slow-air-quality
    match: { url: "**/v1/air-quality**" }
    delay: 3000                                   # modifier, composes with any verb

  - id: no-analytics
    match: { url: "**/analytics/**" }
    abort: true

  - id: first-day-removed
    match: { url: "**/v1/forecast-daily**" }
    patchOps:                                     # RFC 6902
      - { op: remove,  path: /daily/time/0 }
      - { op: replace, path: /daily/weather_code/0, value: 95 }
`;

function issues(result: ValidationResult<unknown>): ValidationIssue[] {
  if (result.ok) throw new Error('expected the spec to be rejected, but it parsed');
  return result.issues;
}

function codes(result: ValidationResult<unknown>): string[] {
  return issues(result).map((issue) => issue.code);
}

function issueWith(result: ValidationResult<unknown>, code: string): ValidationIssue {
  const found = issues(result).find((issue) => issue.code === code);
  if (!found) throw new Error(`no ${code} issue in: ${codes(result).join(', ')}`);
  return found;
}

function parse(source: string): ValidationResult<unknown> {
  return parseScenarioSource(source, { file: 'empty-forecast.yaml' });
}

/** A minimal valid spec with `rules:` replaced by whatever the test is exercising. */
function withRules(rules: string): string {
  return `version: 1\nscenario: empty-forecast\nrules:\n${rules}`;
}

describe('parseScenarioSource — accepted specs', () => {
  it('parses the mocking spec §5 example exactly', () => {
    const result = parseScenarioSource(SPEC_EXAMPLE, {
      file: 'empty-forecast.yaml',
      expectScenarioName: 'empty-forecast',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual({
      version: 1,
      scenario: 'empty-forecast',
      description: 'No forecast data, for checking the empty state',
      mode: 'overlay',
      rules: [
        {
          id: 'forecast-empty',
          match: { method: 'GET', url: '**/v1/forecast**' },
          patch: { hourly: { temperature_2m: [] } },
        },
        {
          id: 'geocode-fails',
          match: { method: 'GET', url: '**/v1/search**' },
          respond: {
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: { error: 'upstream_unavailable' },
          },
        },
        { id: 'slow-air-quality', match: { url: '**/v1/air-quality**' }, delay: 3000 },
        { id: 'no-analytics', match: { url: '**/analytics/**' }, abort: true },
        {
          id: 'first-day-removed',
          match: { url: '**/v1/forecast-daily**' },
          patchOps: [
            { op: 'remove', path: '/daily/time/0' },
            { op: 'replace', path: '/daily/weather_code/0', value: 95 },
          ],
        },
      ],
    });
    expect(result.warnings).toEqual([]);
  });

  it('defaults mode to overlay when the file omits it (mocking spec §5)', () => {
    const result = parse(withRules('  - id: a\n    match: { url: "**" }\n    abort: true\n'));
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { mode: string }).mode).toBe('overlay');
  });

  it('accepts mock mode with respond, abort and delay', () => {
    const result = parse(
      `version: 1
scenario: empty-forecast
mode: mock
rules:
  - id: forecast
    match: { url: "**/v1/forecast**" }
    respond: { status: 200, body: { hourly: {} } }
    delay: 250
  - id: analytics
    match: { url: "**/analytics/**" }
    abort: true
`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { mode: string }).mode).toBe('mock');
  });

  it('keeps delay alongside a response verb, since delay is a modifier', () => {
    const result = parse(
      withRules('  - id: a\n    match: { url: "**" }\n    patch: { a: 1 }\n    delay: 300\n'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { rules: unknown[] }).rules[0]).toEqual({
        id: 'a',
        match: { url: '**' },
        patch: { a: 1 },
        delay: 300,
      });
    }
  });

  it('accepts an object, a string or a base64 blob as respond.body', () => {
    const result = parse(
      withRules(
        `  - id: json
    match: { url: "**/a" }
    respond: { status: 200, body: { ok: true } }
  - id: text
    match: { url: "**/b" }
    respond: { status: 200, headers: { content-type: text/plain }, body: "nope" }
  - id: binary
    match: { url: "**/c" }
    respond: { status: 200, body: { base64: "aGVsbG8=" } }
  - id: bodiless
    match: { url: "**/d" }
    respond: { status: 204 }
`,
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rules = (result.value as { rules: Array<{ respond: { body?: unknown } }> }).rules;
    expect(rules[0]?.respond.body).toEqual({ ok: true });
    expect(rules[1]?.respond.body).toBe('nope');
    expect(rules[2]?.respond.body).toEqual({ base64: 'aGVsbG8=' });
    expect(rules[3]?.respond.body).toBeUndefined();
  });

  it('keeps a merge patch of null at a nested key, which is how RFC 7386 deletes one', () => {
    const result = parse(
      withRules('  - id: a\n    match: { url: "**" }\n    patch: { hourly: { temperature_2m: null } }\n'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { rules: Array<{ patch: unknown }> }).rules[0]?.patch).toEqual({
        hourly: { temperature_2m: null },
      });
    }
  });
});

describe('parseScenarioSource — document-level rejections', () => {
  it('reports a YAML syntax error with its line', () => {
    const result = parse('version: 1\nscenario: [oops\n');
    expect(codes(result)).toEqual(['yaml-parse-error']);
    expect(issues(result)[0]?.at.file).toBe('empty-forecast.yaml');
    expect(issues(result)[0]?.at.line).toBeGreaterThan(0);
  });

  it('rejects an empty document', () => {
    const result = parse('');
    expect(codes(result)).toEqual(['empty-spec']);
    expect(issueWith(result, 'empty-spec').message).toBe('scenario spec is empty');
  });

  it('rejects a document that is not a mapping', () => {
    const result = parse('- forecast-empty\n');
    expect(issueWith(result, 'invalid-root').message).toBe(
      'a scenario spec must be a mapping, got a list',
    );
  });

  it('rejects an unsupported version and reports a missing one', () => {
    expect(issueWith(parse('version: 2\nscenario: empty-forecast\nrules: []\n'), 'unsupported-version').message).toBe(
      'unsupported scenario spec version 2: this build understands version 1',
    );
    expect(issueWith(parse('scenario: empty-forecast\nrules: []\n'), 'missing-key').message).toBe(
      "missing required key 'version'",
    );
  });

  it('rejects a scenario with no rules at all', () => {
    const result = parse('version: 1\nscenario: empty-forecast\nrules: []\n');
    const issue = issueWith(result, 'empty-rules');
    expect(issue.message).toBe(
      'a scenario needs at least one rule: a scenario with none patches nothing, which is what ' +
        'running without --scenario already does',
    );
    expect(issue.at.key).toBe('rules');
  });

  it('names the modes when mode is not one of them', () => {
    const result = parse(
      'version: 1\nscenario: empty-forecast\nmode: stub\nrules:\n  - id: a\n    match: { url: "**" }\n    abort: true\n',
    );
    const issue = issueWith(result, 'invalid-mode');
    expect(issue.message).toBe(
      'unknown scenario mode "stub". The modes are overlay and mock: overlay patches a recording, ' +
        'mock runs with no recording at all and aborts every unmatched request',
    );
    expect(issue.at.key).toBe('mode');
    expect(issue.at.line).toBe(3);
  });
});

describe('parseScenarioSource — unknown keys (mocking spec §8)', () => {
  it('names the scenario vocabulary for an unknown top-level key', () => {
    const result = parse(
      'version: 1\nscenario: empty-forecast\nextends: base\nrules:\n  - id: a\n    match: { url: "**" }\n    abort: true\n',
    );
    const issue = issueWith(result, 'unknown-key');
    expect(issue.message).toBe(
      "unknown key 'extends'. A scenario is written with: version, scenario, description, mode, rules",
    );
    expect(issue.at.key).toBe('extends');
    expect(issue.at.line).toBe(3);
  });

  it('names the rule vocabulary, and which of it is the response verb', () => {
    const result = parse(withRules('  - id: a\n    match: { url: "**" }\n    patchOp: []\n'));
    const issue = issueWith(result, 'unknown-rule-key');
    expect(issue.message).toBe(
      "unknown key 'patchOp' in a rule. A rule is written with: id, match, patch, patchOps, " +
        'respond, abort, delay — where exactly one of patch, patchOps, respond, abort is the ' +
        'response verb and delay is a modifier',
    );
    expect(issue.at.key).toBe('rules[0].patchOp');
  });

  it('names the match vocabulary', () => {
    const result = parse(
      withRules('  - id: a\n    match: { url: "**", header: x }\n    abort: true\n'),
    );
    const issue = issueWith(result, 'unknown-key');
    expect(issue.message).toBe(
      "unknown key 'header' in match. A match is written with: method, url, nth",
    );
    expect(issue.at.key).toBe('rules[0].match.header');
  });

  it('names the respond vocabulary', () => {
    const result = parse(
      withRules('  - id: a\n    match: { url: "**" }\n    respond: { status: 200, statusText: OK }\n'),
    );
    const issue = issueWith(result, 'unknown-key');
    expect(issue.message).toBe(
      "unknown key 'statusText' in respond. A respond is written with: status, headers, body",
    );
    expect(issue.at.key).toBe('rules[0].respond.statusText');
  });
});

describe('parseScenarioSource — missing required keys (mocking spec §8)', () => {
  it('explains why a rule id is required', () => {
    const result = parse(withRules('  - match: { url: "**" }\n    abort: true\n'));
    const issue = issueWith(result, 'missing-id');
    expect(issue.message).toBe(
      "missing required key 'id': a rule id is required and stable, because it is what lets two " +
        'versions of a scenario be compared and what the report names when it attributes a ' +
        'changed response',
    );
    expect(issue.at.key).toBe('rules[0].id');
  });

  it('explains that match.url is what a rule is', () => {
    const result = parse(withRules('  - id: a\n    match: { method: GET }\n    abort: true\n'));
    const issue = issueWith(result, 'missing-url');
    expect(issue.message).toBe(
      "missing required key 'match.url': a rule is a URL glob applied to the whole URL including " +
        "the query string, e.g. '**/v1/forecast**'",
    );
    expect(issue.at.key).toBe('rules[0].match.url');
  });

  it('reports a rule with no match at all', () => {
    const result = parse(withRules('  - id: a\n    abort: true\n'));
    const issue = issueWith(result, 'missing-key');
    expect(issue.message).toBe("missing required key 'match'");
    expect(issue.at.key).toBe('rules[0].match');
  });

  it('reports a respond with no status', () => {
    const result = parse(
      withRules('  - id: a\n    match: { url: "**" }\n    respond: { body: {} }\n'),
    );
    expect(issueWith(result, 'missing-key').message).toBe(
      "missing required key 'respond.status': a response needs a status",
    );
  });

  it('refuses abort: false rather than treating it as a switch', () => {
    const result = parse(withRules('  - id: a\n    match: { url: "**" }\n    abort: false\n'));
    const issue = issueWith(result, 'invalid-abort');
    expect(issue.message).toBe(
      'abort takes only true, got false. There is no way to switch a rule off in place: delete ' +
        'the rule, or comment it out',
    );
    expect(issue.at.key).toBe('rules[0].abort');
  });

  it('reports a plain type error with what it expected', () => {
    const result = parse(withRules('  - id: a\n    match: { url: 7 }\n    abort: true\n'));
    expect(issueWith(result, 'invalid-type').message).toBe('expected string, got number');
  });
});

describe('loadScenarioSource', () => {
  it('throws a ScenarioSpecError carrying exit code 2 and every issue', () => {
    try {
      loadScenarioSource(withRules('  - id: a\n    match: { url: "**" }\n    nope: 1\n'), {
        file: 'empty-forecast.yaml',
      });
      throw new Error('expected a throw');
    } catch (error) {
      if (!isScenarioSpecError(error)) throw error;
      expect(error.exitCode).toBe(2);
      expect(error.code).toBe('unknown-rule-key');
      expect(error.file).toBe('empty-forecast.yaml');
      expect(error.message).toContain('invalid scenario spec: empty-forecast.yaml');
      expect(error.toCliError().issues).toHaveLength(1);
    }
  });

  it('returns the spec when it is valid', () => {
    const spec = loadScenarioSource(withRules('  - id: a\n    match: { url: "**" }\n    abort: true\n'));
    expect(spec.scenario).toBe('empty-forecast');
  });
});

describe('parseScenarioFile', () => {
  it('derives the expected name from the filename, so a mismatch is caught without being asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vdiff-scenario-'));
    try {
      const file = join(dir, 'empty-forecast.yaml');
      await writeFile(file, withRules('  - id: a\n    match: { url: "**" }\n    abort: true\n'));
      const ok = await parseScenarioFile(file);
      expect(ok.ok).toBe(true);

      const renamed = join(dir, 'slow-api.yaml');
      await writeFile(renamed, withRules('  - id: a\n    match: { url: "**" }\n    abort: true\n'));
      const bad = await parseScenarioFile(renamed);
      expect(issueWith(bad, 'scenario-name-mismatch').message).toBe(
        "scenario is named 'empty-forecast' but the file is named 'slow-api.yaml': the two must " +
          'agree, because a run records the scenario by name and later looks the file up by it',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a missing file as a spec issue rather than an exception', async () => {
    const result = await parseScenarioFile('/nowhere/empty-forecast.yaml');
    expect(codes(result)).toEqual(['scenario-missing']);
    expect(issues(result)[0]?.message).toContain('cannot read scenario spec:');
    expect(issues(result)[0]?.at.file).toBe('/nowhere/empty-forecast.yaml');
  });

  it("refuses none.yaml, because 'none' is what a scenario-less run records (§11)", async () => {
    const result = await parseScenarioFile('/wherever/none.yaml');
    const issue = issueWith(result, 'reserved-scenario-name');
    expect(issue.message).toBe(
      "'none.yaml' is a reserved filename: 'none' is what a run captured without a scenario " +
        'records in meta.json, so a scenario cannot be called that',
    );
  });

  it('lets the caller override the expected name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vdiff-scenario-'));
    try {
      const file = join(dir, 'scenario.snapshot.yaml');
      await writeFile(file, withRules('  - id: a\n    match: { url: "**" }\n    abort: true\n'));
      const result = await parseScenarioFile(file, { expectScenarioName: 'empty-forecast' });
      expect(result.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('scenarioNameFromFile', () => {
  it('takes the stem of either YAML extension', () => {
    expect(scenarioNameFromFile('.visual-diff/scenarios/empty-forecast.yaml')).toBe('empty-forecast');
    expect(scenarioNameFromFile('/a/b/slow-api.yml')).toBe('slow-api');
    expect(scenarioNameFromFile('plain')).toBe('plain');
  });
});
