import { describe, expect, it } from 'vitest';
import { isVariantSpecError } from './errors.js';
import {
  assertVariantName,
  isValidVariantName,
  variantFileName,
  variantNameIssue,
  variantRelPath,
  variantRepoPath,
  variantSummary,
} from './name.js';
import { parseVariantSource } from './parse.js';
import { scaffoldVariantSource, scaffoldVariantSpec } from './scaffold.js';
import { canonicalVariant, serializeVariant } from './serialize.js';
import type { VariantSpec } from './types.js';

describe('scaffoldVariantSpec', () => {
  it('produces a one-rule style variant', () => {
    const spec = scaffoldVariantSpec('denser-forecast');
    expect(spec.version).toBe(1);
    expect(spec.variant).toBe('denser-forecast');
    expect(spec.rules).toHaveLength(1);
    expect(spec.rules[0]?.id).toBe('example');
    expect(spec.rules[0]?.match).toBe('[data-test=example]');
    expect(spec.rules[0]?.style).toEqual({ padding: '8px' });
  });

  it('takes a match and a description', () => {
    const spec = scaffoldVariantSpec('denser-forecast', {
      match: '[data-test=forecast-card]',
      description: 'Tighter cards',
    });
    expect(spec.rules[0]?.match).toBe('[data-test=forecast-card]');
    expect(spec.description).toBe('Tighter cards');
  });

  it('refuses a name that could not be a variant, before writing anything', () => {
    for (const name of ['none', '../escape', 'has space', '']) {
      expect(() => scaffoldVariantSpec(name)).toThrow();
      try {
        scaffoldVariantSpec(name);
      } catch (error) {
        expect(isVariantSpecError(error)).toBe(true);
        if (isVariantSpecError(error)) expect(error.exitCode).toBe(2);
      }
    }
  });
});

describe('scaffoldVariantSource', () => {
  const source = scaffoldVariantSource('denser-forecast');

  it('parses on the first try, under its own filename', () => {
    const result = parseVariantSource(source, {
      file: 'denser-forecast.yaml',
      expectVariantName: 'denser-forecast',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });

  it('teaches the constraint the whole feature rests on', () => {
    expect(source).toContain('A variant CANNOT INVENT UI');
    expect(source).toContain('There is no verb that takes');
  });

  it('names every verb and the one-verb rule', () => {
    for (const verb of ['style', 'text', 'hide', 'order', 'clone']) {
      expect(source).toContain(`#   ${verb}`);
    }
    expect(source).toContain('exactly ONE verb');
    expect(source).toContain('Two verbs on one rule is an error');
  });

  it('says that a rule matching nothing is a warning, not a failure', () => {
    expect(source).toContain('A rule that matches nothing is a run warning');
  });

  it('shows the command that runs it', () => {
    expect(source).toContain('vdiff run <flow> --variant denser-forecast');
  });
});

describe('serializeVariant', () => {
  const spec: VariantSpec = {
    version: 1,
    variant: 'denser-forecast',
    description: 'Tighter cards',
    rules: [
      { id: 'tighter', match: '.card', style: { padding: '8px', gap: '4px' } },
      { id: 'chart-first', match: '.chart', order: { before: '.card' } },
      {
        id: 'promote',
        clone: {
          from: { step: 'pricing', match: '.plan' },
          into: '.sidebar',
          position: 'prepend',
          times: 2,
        },
      },
    ],
  };

  it('round-trips through the parser unchanged', () => {
    const result = parseVariantSource(serializeVariant(spec), {
      file: 'denser-forecast.yaml',
      expectVariantName: 'denser-forecast',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(spec);
  });

  it('writes style, order and clone.from on one line, as the spec examples do', () => {
    const yaml = serializeVariant(spec);
    expect(yaml).toContain('style: { padding: 8px, gap: 4px }');
    expect(yaml).toContain('order: { before: .card }');
    expect(yaml).toContain('from: { step: pricing, match: .plan }');
    expect(yaml.endsWith('\n')).toBe(true);
  });

  it('fixes key order, so two variants that mean the same thing serialize identically', () => {
    const reordered: VariantSpec = {
      version: 1,
      variant: 'denser-forecast',
      description: 'Tighter cards',
      rules: [
        // Same rules, keys built in a different order.
        { style: { padding: '8px', gap: '4px' }, match: '.card', id: 'tighter' } as VariantSpec['rules'][number],
        { order: { before: '.card' }, id: 'chart-first', match: '.chart' } as VariantSpec['rules'][number],
        {
          clone: {
            times: 2,
            position: 'prepend',
            into: '.sidebar',
            from: { match: '.plan', step: 'pricing' },
          },
          id: 'promote',
        } as VariantSpec['rules'][number],
      ],
    };
    expect(serializeVariant(reordered)).toBe(serializeVariant(spec));
  });

  it('materializes the clone defaults, so writing them out is not a diff', () => {
    const canonical = canonicalVariant(spec) as { rules: Array<Record<string, unknown>> };
    expect(canonical.rules[2]?.clone).toEqual({
      from: { step: 'pricing', match: '.plan' },
      into: '.sidebar',
      position: 'prepend',
      times: 2,
    });
  });
});

describe('variant names and paths', () => {
  it('derives the file, store and repo paths', () => {
    expect(variantFileName('denser-forecast')).toBe('denser-forecast.yaml');
    expect(variantRelPath('denser-forecast')).toBe('variants/denser-forecast.yaml');
    expect(variantRepoPath('denser-forecast')).toBe(
      '.visual-diff/variants/denser-forecast.yaml',
    );
  });

  it("refuses 'none' as a name, with the reason", () => {
    const issue = variantNameIssue('none');
    expect(issue?.code).toBe('reserved-variant-name');
    expect(issue?.message).toBe(
      "'none' is a reserved variant name: it is what a run captured without a variant records in " +
        'meta.json, and what a variant run is diffed against, so no variant file may take it. ' +
        'Pick another name',
    );
    expect(issue?.at.file).toBe('none.yaml');
  });

  it('refuses names that could not be filenames', () => {
    for (const name of ['../escape', 'has space', '.hidden', '', 'a/b']) {
      expect(isValidVariantName(name)).toBe(false);
      expect(variantNameIssue(name)?.code).toBe('invalid-variant-name');
    }
    for (const name of ['denser-forecast', 'a', 'A1._-']) {
      expect(isValidVariantName(name)).toBe(true);
    }
  });

  it('throws exit-2 for a name that cannot be used', () => {
    expect(() => assertVariantName('denser-forecast')).not.toThrow();
    try {
      assertVariantName('none');
      throw new Error('expected assertVariantName to throw');
    } catch (error) {
      expect(isVariantSpecError(error)).toBe(true);
      if (!isVariantSpecError(error)) return;
      expect(error.exitCode).toBe(2);
      expect(error.file).toBe('none.yaml');
    }
  });
});

describe('variantSummary', () => {
  it('lists the verbs a variant uses, in vocabulary order and without repeats', () => {
    const spec = parseVariantSource(
      'version: 1\nvariant: denser-forecast\ndescription: Tighter\nrules:\n' +
        '  - id: a\n    match: ".card"\n    hide: true\n' +
        '  - id: b\n    match: ".chart"\n    style: { padding: 8px }\n' +
        '  - id: c\n    match: ".cta"\n    hide: true\n',
      { file: 'denser-forecast.yaml' },
    );
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;

    expect(variantSummary(spec.value)).toEqual({
      name: 'denser-forecast',
      description: 'Tighter',
      ruleCount: 3,
      verbs: ['style', 'hide'],
      path: 'variants/denser-forecast.yaml',
    });
  });

  it('omits an absent description rather than writing null into --json', () => {
    const summary = variantSummary({
      version: 1,
      variant: 'denser-forecast',
      rules: [{ id: 'a', match: '.card', hide: true }],
    });
    expect(Object.prototype.hasOwnProperty.call(summary, 'description')).toBe(false);
  });
});
