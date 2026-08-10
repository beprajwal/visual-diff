import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ValidationIssue, ValidationResult } from '../types.js';
import { isVariantSpecError } from './errors.js';
import {
  loadVariantSource,
  parseVariantFile,
  parseVariantSource,
  variantNameFromFile,
} from './parse.js';

/** The example from variants spec §4, verbatim. */
const SPEC_EXAMPLE = `version: 1
variant: denser-forecast
description: Tighter cards, air quality hidden, upsell promoted
rules:
  - id: tighter-cards
    match: "[data-test=forecast-card]"
    style: { padding: 8px, gap: 4px }

  - id: cta-copy
    match: "[data-test=save-cta]"
    text: "Save this location"

  - id: hide-air-quality
    match: "[data-test=air-quality]"
    hide: true

  - id: chart-first
    match: "[data-test=forecast-chart]"
    order: first                       # first | last | { before: <selector> } | { after: <selector> }

  - id: promote-upsell
    clone:
      from: { step: pricing, match: "[data-test=plan-card]:first-child" }
      into: "[data-test=sidebar]"
      position: prepend                # prepend | append | { before: … } | { after: … }
      times: 1
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
  return parseVariantSource(source, { file: 'denser-forecast.yaml' });
}

/** A minimal valid spec with `rules:` replaced by whatever the test is exercising. */
function withRules(rules: string): string {
  return `version: 1\nvariant: denser-forecast\nrules:\n${rules}`;
}

describe('parseVariantSource — accepted specs', () => {
  it('parses the variants spec §4 example exactly', () => {
    const result = parseVariantSource(SPEC_EXAMPLE, {
      file: 'denser-forecast.yaml',
      expectVariantName: 'denser-forecast',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual({
      version: 1,
      variant: 'denser-forecast',
      description: 'Tighter cards, air quality hidden, upsell promoted',
      rules: [
        {
          id: 'tighter-cards',
          match: '[data-test=forecast-card]',
          style: { padding: '8px', gap: '4px' },
        },
        { id: 'cta-copy', match: '[data-test=save-cta]', text: 'Save this location' },
        { id: 'hide-air-quality', match: '[data-test=air-quality]', hide: true },
        { id: 'chart-first', match: '[data-test=forecast-chart]', order: 'first' },
        {
          id: 'promote-upsell',
          clone: {
            from: { step: 'pricing', match: '[data-test=plan-card]:first-child' },
            into: '[data-test=sidebar]',
            position: 'prepend',
            times: 1,
          },
        },
      ],
    });
    expect(result.warnings).toEqual([]);
  });

  it('normalizes style values to strings, because setProperty takes only strings', () => {
    const result = parse(
      withRules('  - id: a\n    match: ".card"\n    style: { line-height: 1.5, z-index: 3, opacity: 0.25 }\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      rules: [{ style: { 'line-height': '1.5', 'z-index': '3', opacity: '0.25' } }],
    });
  });

  it('materializes the clone defaults: append, once', () => {
    const result = parse(
      withRules(
        '  - id: a\n    clone:\n      from: { url: /pricing, match: ".plan" }\n      into: ".sidebar"\n',
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      rules: [
        {
          clone: {
            from: { url: '/pricing', match: '.plan' },
            into: '.sidebar',
            position: 'append',
            times: 1,
          },
        },
      ],
    });
  });

  it('accepts every shape of order and clone position', () => {
    const result = parse(
      withRules(
        '  - id: a\n    match: ".card"\n    order: last\n' +
          '  - id: b\n    match: ".chart"\n    order: { before: ".card" }\n' +
          '  - id: c\n    match: ".cta"\n    order: { after: ".card" }\n' +
          '  - id: d\n    clone:\n      from: { step: pricing, match: ".plan" }\n' +
          '      into: ".sidebar"\n      position: { after: ".card" }\n      times: 3\n',
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      rules: [
        { order: 'last' },
        { order: { before: '.card' } },
        { order: { after: '.card' } },
        { clone: { position: { after: '.card' }, times: 3 } },
      ],
    });
  });

  it('keeps declaration order inside style, because CSS is order-sensitive', () => {
    const result = parse(
      withRules('  - id: a\n    match: ".card"\n    style: { padding-top: 2px, padding: 8px }\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rule = (result.value as { rules: Array<{ style: Record<string, string> }> }).rules[0];
    expect(Object.keys(rule?.style ?? {})).toEqual(['padding-top', 'padding']);
  });
});

describe('parseVariantSource — the file as a whole', () => {
  it('reports a YAML syntax error with a line', () => {
    const result = parse('version: 1\nvariant: denser-forecast\nrules: [\n');
    const issue = issueWith(result, 'yaml-parse-error');
    expect(issue.at.file).toBe('denser-forecast.yaml');
    expect(issue.at.line).toBeGreaterThan(0);
  });

  it('reports an empty document', () => {
    const issue = issueWith(parse('\n# nothing here\n'), 'empty-spec');
    expect(issue.message).toBe('variant spec is empty');
  });

  it('reports a document that is not a mapping', () => {
    const issue = issueWith(parse('- one\n- two\n'), 'invalid-root');
    expect(issue.message).toBe('a variant spec must be a mapping, got a list');
  });

  it('names an unsupported version', () => {
    const issue = issueWith(
      parse('version: 2\nvariant: denser-forecast\nrules:\n  - id: a\n    match: ".c"\n    hide: true\n'),
      'unsupported-version',
    );
    expect(issue.message).toBe(
      'unsupported variant spec version 2: this build understands version 1',
    );
    expect(issue.at.line).toBe(1);
  });

  it('refuses a variant with no rules', () => {
    const issue = issueWith(parse('version: 1\nvariant: denser-forecast\nrules: []\n'), 'empty-rules');
    expect(issue.message).toBe(
      'a variant needs at least one rule: a variant with none changes nothing, and a run of it ' +
        'would be a second copy of the unmodified page',
    );
  });
});

describe('parseVariantSource — unknown keys (the closed vocabulary of D21)', () => {
  it('refuses an unknown top-level key', () => {
    const issue = issueWith(
      parse('version: 1\nvariant: denser-forecast\nmode: overlay\nrules:\n  - id: a\n    match: ".c"\n    hide: true\n'),
      'unknown-key',
    );
    expect(issue.message).toBe(
      "unknown key 'mode'. A variant is written with: version, variant, description, rules",
    );
    expect(issue.at.line).toBe(3);
  });

  it('refuses an html verb, naming the whole vocabulary and why markup is not in it', () => {
    const issue = issueWith(
      parse(withRules('  - id: a\n    match: ".c"\n    html: "<div>new</div>"\n')),
      'unknown-rule-key',
    );
    expect(issue.message).toBe(
      "unknown key 'html' in a rule. A rule is written with: id, match, style, text, hide, " +
        'order, clone — where exactly one of style, text, hide, order, clone is the verb. There ' +
        'is deliberately no verb that takes markup: a variant rearranges what the application ' +
        'already renders, so every element it shows has to have been rendered by the application ' +
        'first',
    );
    expect(issue.at.key).toBe('rules[0].html');
    expect(issue.at.line).toBe(6);
  });

  it('refuses an unknown key inside clone', () => {
    const issue = issueWith(
      parse(
        withRules(
          '  - id: a\n    clone:\n      from: { step: s, match: ".p" }\n      into: ".x"\n      repeat: 3\n',
        ),
      ),
      'unknown-clone-key',
    );
    expect(issue.message).toBe(
      "unknown key 'repeat' in clone. A clone is written with: from, into, position, times",
    );
  });

  it('refuses an unknown key inside clone.from', () => {
    const issue = issueWith(
      parse(
        withRules(
          '  - id: a\n    clone:\n      from: { run: 42, match: ".p" }\n      into: ".x"\n',
        ),
      ),
      'unknown-clone-key',
    );
    expect(issue.message).toBe(
      "unknown key 'run' in clone.from. A clone source is written with: step, url, match — step " +
        'or url, never both',
    );
  });
});

describe('parseVariantSource — verb shapes zod checks', () => {
  it('names a missing rule id', () => {
    const issue = issueWith(parse(withRules('  - match: ".card"\n    hide: true\n')), 'missing-id');
    expect(issue.message).toBe(
      "missing required key 'id': a rule id is required and stable, because it is what the " +
        'report names when it attributes a modified element and what lets two versions of a ' +
        'variant be compared',
    );
  });

  it('refuses hide: false rather than treating it as an off switch', () => {
    const issue = issueWith(
      parse(withRules('  - id: a\n    match: ".card"\n    hide: false\n')),
      'invalid-hide',
    );
    expect(issue.message).toBe(
      'hide takes only true, got false. There is no way to switch a rule off in place: delete ' +
        'the rule, or comment it out',
    );
  });

  it('refuses a non-string text', () => {
    const issue = issueWith(
      parse(withRules('  - id: a\n    match: ".card"\n    text: 42\n')),
      'invalid-text',
    );
    expect(issue.message).toBe(
      'text takes a string, got number: quote the replacement copy, e.g. text: "Save this location"',
    );
  });

  it('refuses a non-string match', () => {
    const issue = issueWith(
      parse(withRules('  - id: a\n    match: 3\n    hide: true\n')),
      'invalid-match',
    );
    expect(issue.message).toBe(
      'match takes a CSS selector, got number: write it as a string, e.g. match: ' +
        '"[data-test=forecast-card]"',
    );
  });

  it('names a missing clone.from', () => {
    const issue = issueWith(
      parse(withRules('  - id: a\n    clone:\n      into: ".sidebar"\n')),
      'missing-key',
    );
    expect(issue.message).toBe(
      "missing required key 'clone.from': a clone copies an element the application already " +
        'rendered, so it has to say which one — from: { step: <step>, match: <selector> }, or ' +
        'from: { url: <url>, match: <selector> }',
    );
  });

  it('names a missing clone.into', () => {
    const issue = issueWith(
      parse(withRules('  - id: a\n    clone:\n      from: { step: s, match: ".p" }\n')),
      'missing-key',
    );
    expect(issue.message).toBe(
      "missing required key 'clone.into': a clone needs somewhere to go — the selector of the " +
        'element it is placed into',
    );
  });

  it('names a missing clone.from.match', () => {
    const issue = issueWith(
      parse(withRules('  - id: a\n    clone:\n      from: { step: s }\n      into: ".x"\n')),
      'missing-match',
    );
    expect(issue.message).toBe(
      "missing required key 'clone.from.match': a clone source names the page it comes from and " +
        'the selector of the element to copy',
    );
  });
});

describe('parseVariantFile', () => {
  it('derives the expected name from the filename and rejects a disagreement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vdiff-variant-'));
    try {
      const file = join(dir, 'denser-forecast.yaml');
      await writeFile(file, withRules('  - id: a\n    match: ".c"\n    hide: true\n').replace('denser-forecast', 'other'), 'utf8');
      const issue = issueWith(await parseVariantFile(file), 'variant-name-mismatch');
      expect(issue.message).toBe(
        "variant is named 'other' but the file is named 'denser-forecast.yaml': the two must " +
          'agree, because a run records the variant by name and later looks the file up by it',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses a file whose name agrees', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vdiff-variant-'));
    try {
      const file = join(dir, 'denser-forecast.yaml');
      await writeFile(file, SPEC_EXAMPLE, 'utf8');
      const result = await parseVariantFile(file);
      expect(result.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing file as a spec issue rather than throwing', async () => {
    const result = await parseVariantFile(join(tmpdir(), 'vdiff-absent', 'nope.yaml'));
    const issue = issueWith(result, 'variant-missing');
    expect(issue.message).toContain('cannot read variant spec:');
  });

  it("refuses 'none.yaml' outright, before reading it", async () => {
    const result = await parseVariantFile(join(tmpdir(), 'none.yaml'));
    const issue = issueWith(result, 'reserved-variant-name');
    expect(issue.message).toBe(
      "'none.yaml' is a reserved filename: 'none' is what a run captured without a variant " +
        'records in meta.json, so a variant cannot be called that',
    );
  });

  it('strips either yaml extension when deriving the name', () => {
    expect(variantNameFromFile('/a/.visual-diff/variants/denser-forecast.yaml')).toBe(
      'denser-forecast',
    );
    expect(variantNameFromFile('denser-forecast.yml')).toBe('denser-forecast');
  });
});

describe('loadVariantSource', () => {
  it('throws a VariantSpecError carrying exit 2, the file and every issue', () => {
    let thrown: unknown;
    try {
      loadVariantSource(withRules('  - id: a\n    match: ".card"\n'), {
        file: 'denser-forecast.yaml',
      });
    } catch (error) {
      thrown = error;
    }
    expect(isVariantSpecError(thrown)).toBe(true);
    if (!isVariantSpecError(thrown)) return;
    expect(thrown.exitCode).toBe(2);
    expect(thrown.file).toBe('denser-forecast.yaml');
    expect(thrown.code).toBe('no-verb');
    expect(thrown.message).toContain('invalid variant spec: denser-forecast.yaml');
    expect(thrown.message).toContain('denser-forecast.yaml:4:5:');
    expect(thrown.toCliError()).toMatchObject({ code: 'no-verb', exitCode: 2 });
  });

  it('returns the spec when it is valid', () => {
    const spec = loadVariantSource(SPEC_EXAMPLE, { file: 'denser-forecast.yaml' });
    expect(spec.variant).toBe('denser-forecast');
    expect(spec.rules).toHaveLength(5);
  });
});
