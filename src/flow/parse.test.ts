import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ValidationIssue, ValidationResult } from '../types.js';
import { isSpecError } from './errors.js';
import { loadFlowSource, parseFlowFile, parseFlowSource } from './parse.js';

/** The example from spec §6, verbatim. */
const SPEC_EXAMPLE = `version: 1
flow: checkout
baseUrl: http://localhost:5173
viewports: [1280x800, 390x844]
network: { mode: replay, har: checkout.har }
steps:
  - id: cart
    goto: /cart
    waitFor: "[data-test=cart-list]"
    mask: ["[data-test=order-date]"]
    shoot: true
  - id: pay-form
    click: "[data-test=pay]"
    waitFor: "text=Payment"
    shoot: true
  - id: fill-card
    fill: { "[name=card]": "4242424242424242" }
    shoot: false
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

describe('parseFlowSource — covers (selection spec D59)', () => {
  const base = 'version: 1\nflow: checkout\nnetwork: { mode: off }\nsteps:\n  - id: cart\n    goto: /cart\n';

  it('carries the globs through, and leaves the key absent when unset', () => {
    const with_ = parseFlowSource(`${base}covers:\n  - src/flags/**\n  - src/components/cart/*.tsx\n`);
    expect(with_.ok && with_.value.covers).toEqual(['src/flags/**', 'src/components/cart/*.tsx']);
    const without = parseFlowSource(base);
    expect(without.ok && without.value.covers).toBeUndefined();
  });

  it('refuses a glob that does not compile, naming the entry', () => {
    const result = parseFlowSource(`${base}covers:\n  - src/**\n  - 'src/[a'\n`, { file: 'checkout.yaml' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(['invalid-covers']);
    expect(result.issues[0]?.message).toMatch(/^covers\[1\] 'src\/\[a' is not a glob: /);
    expect(result.issues[0]?.at.line).toBe(9);
  });

  it('refuses an empty covers list: nothing covered is the key absent', () => {
    const result = parseFlowSource(`${base}covers: []\n`);
    expect(result.ok).toBe(false);
  });
});

describe('parseFlowSource — accepted specs', () => {
  it('parses the spec §6 example exactly', () => {
    const result = parseFlowSource(SPEC_EXAMPLE, { file: 'checkout.yaml' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual({
      version: 1,
      flow: 'checkout',
      baseUrl: 'http://localhost:5173',
      viewports: ['1280x800', '390x844'],
      network: { mode: 'replay', har: 'checkout.har' },
      steps: [
        {
          id: 'cart',
          goto: '/cart',
          waitFor: '[data-test=cart-list]',
          mask: ['[data-test=order-date]'],
          shoot: true,
        },
        { id: 'pay-form', click: '[data-test=pay]', waitFor: 'text=Payment', shoot: true },
        { id: 'fill-card', fill: { '[name=card]': '4242424242424242' }, shoot: false },
      ],
    });
    expect(result.warnings).toEqual([]);
  });

  it('accepts every verb in the closed vocabulary', () => {
    const result = parseFlowSource(
      `version: 1
flow: full
viewports: [1280x800]
network: { mode: "off" }
steps:
  - id: all
    goto: /
    click: "#a"
    fill: { "#b": "v" }
    press: Enter
    hover: "#c"
    upload: { "input[type=file]": fixtures/spec.pdf }
    scroll: { to: bottom }
    waitFor: "#d"
    viewport: 390x844
    mask: ["#e"]
    shoot: false
    expect:
      - selector: "#f"
        visible: true
`,
      { file: 'full.yaml' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps[0]).toEqual({
      id: 'all',
      goto: '/',
      click: '#a',
      fill: { '#b': 'v' },
      press: 'Enter',
      hover: '#c',
      upload: { 'input[type=file]': 'fixtures/spec.pdf' },
      scroll: { to: 'bottom' },
      waitFor: '#d',
      viewport: '390x844',
      mask: ['#e'],
      shoot: false,
      expect: [{ selector: '#f', visible: true }],
    });
  });

  it('applies defaults: viewports, network, and shoot', () => {
    const result = parseFlowSource(
      `version: 1
flow: mini
steps:
  - id: home
    goto: /
`,
      { file: 'mini.yaml' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.viewports).toEqual(['1280x800', '390x844']);
    expect(result.value.network).toEqual({ mode: 'replay', har: 'mini.har' });
    expect(result.value.steps[0]?.shoot).toBe(true);
    expect(result.value.baseUrl).toBeUndefined();
  });

  it('carries the scenario, readiness route and discovery opt-out a flow declares', () => {
    const result = parseFlowSource(
      `version: 1
flow: parsing
baseUrl: http://127.0.0.1:3000/
network: { mode: mock }
scenario: parsing-midparse
readyOn: http://127.0.0.1:3000/projects/p1/agent
ci: false
steps:
  - id: home
    goto: /
    shoot: true
`,
      { file: 'parsing.yaml' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenario).toBe('parsing-midparse');
    expect(result.value.readyOn).toBe('http://127.0.0.1:3000/projects/p1/agent');
    expect(result.value.ci).toBe(false);
  });

  it('leaves all three unset when the flow says nothing, so nothing changes for existing specs', () => {
    const result = parseFlowSource(SPEC_EXAMPLE, { file: 'checkout.yaml' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenario).toBeUndefined();
    expect(result.value.readyOn).toBeUndefined();
    expect(result.value.ci).toBeUndefined();
  });

  it('refuses a non-boolean ci, which would otherwise read as opting out', () => {
    const result = parseFlowSource(
      `version: 1
flow: parsing
ci: 'false'
steps:
  - id: home
    goto: /
`,
      { file: 'parsing.yaml' },
    );
    expect(result.ok).toBe(false);
  });

  it('normalizes the singular shorthands for mask, expect and viewports', () => {
    const result = parseFlowSource(
      `version: 1
flow: short
viewports: 1280x800
steps:
  - id: home
    goto: /
    mask: "[data-test=clock]"
    expect: { selector: "#ok", visible: true }
`,
      { file: 'short.yaml' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.viewports).toEqual(['1280x800']);
    expect(result.value.steps[0]?.mask).toEqual(['[data-test=clock]']);
    expect(result.value.steps[0]?.expect).toEqual([{ selector: '#ok', visible: true }]);
  });

  it('warns, but does not fail, when the flow name does not match the file name', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
steps:
  - id: home
    goto: /
`,
      { file: 'cart.yaml', expectFlowName: 'cart' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((w) => w.code)).toEqual(['flow-name-mismatch']);
  });
});

describe('parseFlowSource — rejected specs (spec §10 row 1)', () => {
  it('rejects sleep by name, with file, line, column and offending key', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
steps:
  - id: cart
    goto: /cart
  - id: pay
    sleep: 500
`,
      { file: 'checkout.yaml' },
    );

    const issue = issueWith(result, 'sleep-forbidden');
    expect(issue.at).toEqual({ file: 'checkout.yaml', line: 7, column: 5, key: 'steps[1].sleep' });
    expect(issue.message).toContain('waitFor');
  });

  it('rejects the other timer-shaped verbs as well', () => {
    for (const verb of ['wait', 'waitForTimeout', 'pause', 'delay']) {
      const result = parseFlowSource(
        `version: 1
flow: f
steps:
  - id: a
    ${verb}: 100
`,
        { file: 'f.yaml' },
      );
      expect(codes(result)).toContain('sleep-forbidden');
    }
  });

  it('rejects an unknown verb and names the vocabulary', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
steps:
  - id: cart
    blink: "#logo"
`,
      { file: 'checkout.yaml' },
    );

    const issue = issueWith(result, 'unknown-verb');
    expect(issue.at.line).toBe(5);
    expect(issue.at.column).toBe(5);
    expect(issue.at.key).toBe('steps[0].blink');
    expect(issue.message).toContain('waitFor');
  });

  it('rejects an unknown top-level key', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
timeout: 30
steps:
  - id: cart
    goto: /
`,
      { file: 'checkout.yaml' },
    );

    const issue = issueWith(result, 'unknown-key');
    expect(issue.at.line).toBe(3);
    expect(issue.at.key).toBe('timeout');
  });

  it('rejects a missing step id at the step it belongs to', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
steps:
  - goto: /cart
`,
      { file: 'checkout.yaml' },
    );

    const issue = issueWith(result, 'missing-id');
    expect(issue.at.line).toBe(4);
    expect(issue.at.key).toBe('steps[0].id');
  });

  it('rejects a duplicate step id, pointing at the second occurrence', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
steps:
  - id: cart
    goto: /cart
  - id: cart
    goto: /cart2
`,
      { file: 'checkout.yaml' },
    );

    const issue = issueWith(result, 'duplicate-id');
    expect(issue.at.line).toBe(6);
    expect(issue.at.column).toBe(5);
    expect(issue.at.key).toBe('steps[1].id');
    expect(issue.message).toContain('steps[0]');
  });

  it('rejects an id that would not be a safe directory name', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
steps:
  - id: "pay/form"
    goto: /
`,
      { file: 'checkout.yaml' },
    );
    expect(issueWith(result, 'invalid-id').at.key).toBe('steps[0].id');
  });

  it('rejects an unsupported version', () => {
    const result = parseFlowSource(
      `version: 2
flow: checkout
steps:
  - id: cart
    goto: /
`,
      { file: 'checkout.yaml' },
    );
    const issue = issueWith(result, 'unsupported-version');
    expect(issue.at.line).toBe(1);
    expect(issue.at.key).toBe('version');
  });

  it('rejects a missing version and a missing flow name', () => {
    const result = parseFlowSource(
      `steps:
  - id: cart
    goto: /
`,
      { file: 'checkout.yaml' },
    );
    expect(codes(result).filter((code) => code === 'missing-key')).toHaveLength(2);
  });

  it('rejects a flow with no steps', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
steps: []
`,
      { file: 'checkout.yaml' },
    );
    expect(issueWith(result, 'empty-steps').at.key).toBe('steps');
  });

  it('rejects a malformed viewport', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
viewports: [1280x800, mobile]
steps:
  - id: cart
    goto: /
`,
      { file: 'checkout.yaml' },
    );
    const issue = issueWith(result, 'invalid-viewport');
    expect(issue.at.key).toBe('viewports[1]');
    expect(issue.at.line).toBe(3);
  });

  it('rejects a malformed viewport on the viewport verb', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
steps:
  - id: cart
    viewport: phone
`,
      { file: 'checkout.yaml' },
    );
    expect(issueWith(result, 'invalid-viewport').at.key).toBe('steps[0].viewport');
  });

  it('requires a har when the network is replayed or recorded', () => {
    for (const mode of ['replay', 'record']) {
      const result = parseFlowSource(
        `version: 1
flow: checkout
network: { mode: ${mode} }
steps:
  - id: cart
    goto: /
`,
        { file: 'checkout.yaml' },
      );
      const issue = issueWith(result, 'har-required');
      expect(issue.at.key).toBe('network.har');
      expect(issue.at.line).toBe(3);
    }
  });

  it('rejects an unknown network mode', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
network: { mode: live, har: c.har }
steps:
  - id: cart
    goto: /
`,
      { file: 'checkout.yaml' },
    );
    const issue = issueWith(result, 'invalid-value');
    expect(issue.at.key).toBe('network.mode');
    expect(issue.message).toContain('replay');
  });

  it('rejects wrong value types and says what it expected', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
steps:
  - id: cart
    shoot: maybe
    fill: "#card"
`,
      { file: 'checkout.yaml' },
    );
    const typeIssues = issues(result).filter((issue) => issue.code === 'invalid-type');
    expect(typeIssues.map((issue) => issue.at.key).sort()).toEqual([
      'steps[0].fill',
      'steps[0].shoot',
    ]);
    expect(typeIssues[0]?.message).toMatch(/expected .*, got .*/);
  });

  it('reports a YAML syntax error with a line', () => {
    const result = parseFlowSource('flow: [unclosed\n', { file: 'checkout.yaml' });
    expect(codes(result)).toContain('yaml-parse-error');
    expect(issueWith(result, 'yaml-parse-error').at.line).toBeGreaterThanOrEqual(1);
  });

  it('reports duplicate YAML keys as a parse error', () => {
    const result = parseFlowSource(
      `version: 1
flow: a
flow: b
steps:
  - id: cart
    goto: /
`,
      { file: 'checkout.yaml' },
    );
    expect(codes(result)).toContain('yaml-parse-error');
  });

  it('rejects an empty document and a non-mapping document', () => {
    expect(codes(parseFlowSource('', { file: 'x.yaml' }))).toEqual(['empty-spec']);
    expect(codes(parseFlowSource('- a\n- b\n', { file: 'x.yaml' }))).toEqual(['invalid-root']);
  });

  it('collects every problem in one pass, ordered by line', () => {
    const result = parseFlowSource(
      `version: 1
flow: checkout
steps:
  - id: cart
    blink: "#logo"
  - id: cart
    sleep: 1
`,
      { file: 'checkout.yaml' },
    );
    const lines = issues(result).map((issue) => issue.at.line ?? 0);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    expect(codes(result)).toEqual(expect.arrayContaining(['unknown-verb', 'sleep-forbidden']));
  });
});

describe('parseFlowFile / loadFlowSource', () => {
  it('reads and parses a file, defaulting the location label to the path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vdiff-flow-'));
    try {
      const file = join(dir, 'checkout.yaml');
      await writeFile(file, SPEC_EXAMPLE, 'utf8');
      const result = await parseFlowFile(file);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.flow).toBe('checkout');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('turns a missing file into a spec issue rather than a throw', async () => {
    const result = await parseFlowFile(join(tmpdir(), 'vdiff-does-not-exist', 'nope.yaml'));
    expect(codes(result)).toEqual(['flow-not-found']);
  });

  it('loadFlowSource throws a SpecError carrying exit code 2 and the issues', () => {
    let thrown: unknown;
    try {
      loadFlowSource('version: 1\nflow: c\nsteps:\n  - id: a\n    sleep: 1\n', {
        file: 'checkout.yaml',
      });
    } catch (error) {
      thrown = error;
    }
    expect(isSpecError(thrown)).toBe(true);
    if (!isSpecError(thrown)) return;
    expect(thrown.exitCode).toBe(2);
    expect(thrown.code).toBe('sleep-forbidden');
    expect(thrown.file).toBe('checkout.yaml');
    expect(thrown.message).toContain('checkout.yaml:5:5');
    expect(thrown.message).toContain('steps[0].sleep');
  });
});
