/**
 * Variant resolution, per-viewport state and run-level aggregation — no browser (variants §7, §8).
 *
 * What a rule does to a page belongs to `variant-apply/`, and it is tested there against a DOM. What
 * is here is everything the *runner* decides: which spec a run uses (D4), what one viewport keeps,
 * and how many captures become one verdict — because the verdict is what the user is told, and §7's
 * warnings are the only thing standing between a variant that silently did nothing and a user who
 * believes the screenshot in front of them is the proposal.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT, type StepId, type ViewportId } from '../types.js';
import type { VariantSpec } from '../variant/index.js';
import {
  VariantError,
  variantWarnings,
  type ApplicableRule,
  type RuleResult,
  type VariantApplyReport,
} from '../variant-apply/index.js';
import { RunnerError } from './errors.js';
import { cloneHarPath, groupCloneRules } from './variant-clone.js';
import {
  aggregateReport,
  buildVariantRuntime,
  isVariantFailure,
  resolveVariant,
  toRunWarning,
  toRunnerError,
  variantFile,
  variantReport,
  type VariantPlan,
} from './variant.js';

const VIEWPORT: ViewportId = '1280x800';
const MOBILE: ViewportId = '390x844';
const STEP: StepId = 'forecast';

const SOURCE = `version: 1
variant: denser-forecast
description: Tighter cards, air quality hidden
rules:
  - id: tighter-cards
    match: "[data-test=forecast-card]"
    style: { padding: 8px }
  - id: hide-air-quality
    match: "[data-test=air-quality]"
    hide: true
`;

function spec(rules: VariantSpec['rules'], name = 'denser-forecast'): VariantSpec {
  return { version: 1, variant: name, rules };
}

function plan(value: VariantSpec, file = `${value.variant}.yaml`): VariantPlan {
  return { name: value.variant, spec: value, file };
}

function ruleResult(overrides: Partial<RuleResult> & { ruleId: string }): RuleResult {
  return { verb: 'style', outcome: 'applied', matched: 1, changed: 1, verified: 1, ...overrides };
}

function report(variant: string, rules: RuleResult[], overrides: Partial<VariantApplyReport> = {}): VariantApplyReport {
  return { variant, rules, attributions: [], stylesInjected: 0, ...overrides };
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vdiff-variant-'));
  await mkdir(join(root, '.visual-diff', 'variants'), { recursive: true });
  return root;
}

/** The error a call threw, or a failure that says what it returned instead. */
async function rejection(run: () => Promise<unknown>): Promise<RunnerError> {
  try {
    await run();
  } catch (error) {
    if (RunnerError.is(error)) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

describe('resolveVariant', () => {
  it('reads and validates the spec from the project', async () => {
    const root = await project();
    await writeFile(variantFile(root, 'denser-forecast'), SOURCE, 'utf8');

    const resolved = await resolveVariant({ name: 'denser-forecast', root, gitRoot: root });

    expect(resolved.name).toBe('denser-forecast');
    expect(resolved.file).toBe(variantFile(root, 'denser-forecast'));
    expect(resolved.spec.rules.map((rule) => rule.id)).toEqual(['tighter-cards', 'hide-air-quality']);
  });

  it('names the file it looked for when the variant does not exist', async () => {
    const root = await project();

    const error = await rejection(() => resolveVariant({ name: 'missing', root, gitRoot: root }));

    expect(error.message).toBe(`no variant spec at ${variantFile(root, 'missing')}`);
    expect(error.hint).toBe('create it with `vdiff variant new missing`');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.kind).toBe('variant-missing');
  });

  it('refuses the reserved name, because meta.json records it for an unvaried run', async () => {
    const root = await project();

    const error = await rejection(() => resolveVariant({ name: 'none', root, gitRoot: root }));

    expect(error.message).toContain("'none' is a reserved variant name");
    expect(error.message).toContain('meta.json');
    expect(error.hint).toBe('pick another name, or drop --variant to run without one');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
  });

  it('reads the variant committed at the target sha on historical replay (D4)', async () => {
    const root = await project();
    // Today's variant is on disk and differs; the run must use the one committed at that sha.
    await writeFile(variantFile(root, 'denser-forecast'), SOURCE, 'utf8');
    const asked: string[] = [];

    const resolved = await resolveVariant({
      name: 'denser-forecast',
      root,
      gitRoot: root,
      sha: 'abc1234567890',
      readAtRev: async (_gitRoot, _sha, repoPath) => {
        asked.push(repoPath);
        return `version: 1\nvariant: denser-forecast\nrules:\n  - id: old-rule\n    match: ".card"\n    hide: true\n`;
      },
    });

    expect(asked).toEqual(['.visual-diff/variants/denser-forecast.yaml']);
    expect(resolved.spec.rules.map((rule) => rule.id)).toEqual(['old-rule']);
    expect(resolved.file).toBe('.visual-diff/variants/denser-forecast.yaml@abc1234');
  });

  it('rejects a variant absent at the target sha cleanly, as a missing flow is', async () => {
    const root = await project();

    const error = await rejection(() =>
      resolveVariant({
        name: 'denser-forecast',
        root,
        gitRoot: root,
        sha: 'abc1234567890',
        readAtRev: async () => null,
      }),
    );

    expect(error.message).toBe(
      'variant "denser-forecast" did not exist at abc1234: .visual-diff/variants/denser-forecast.yaml',
    );
    expect(error.hint).toBe('pick a revision where the variant was committed, or replay HEAD');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
  });

  it('reports an invalid spec with the file and line, at exit 2', async () => {
    const root = await project();
    const file = variantFile(root, 'broken');
    await writeFile(
      file,
      `version: 1\nvariant: broken\nrules:\n  - id: two-verbs\n    match: ".card"\n    hide: true\n    text: "hello"\n`,
      'utf8',
    );

    const error = await rejection(() => resolveVariant({ name: 'broken', root, gitRoot: root }));

    expect(error.message).toContain(file);
    expect(error.message).toMatch(/:\d+: /);
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.kind).toBe('variant-invalid');
  });

  it('refuses a clone source step the flow does not have, before the run starts (§7)', async () => {
    const root = await project();
    await writeFile(
      variantFile(root, 'promote'),
      `version: 1
variant: promote
rules:
  - id: promote-upsell
    clone:
      from: { step: pricing, match: "[data-test=plan-card]" }
      into: "[data-test=sidebar]"
`,
      'utf8',
    );

    const error = await rejection(() =>
      resolveVariant({ name: 'promote', root, gitRoot: root, flowStepIds: ['home', 'forecast'] }),
    );

    expect(error.message).toContain("clones from step 'pricing', which this flow does not have");
    expect(error.message).toContain('home, forecast');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
  });

  it('accepts the same clone source once the flow declares that step', async () => {
    const root = await project();
    await writeFile(
      variantFile(root, 'promote'),
      `version: 1
variant: promote
rules:
  - id: promote-upsell
    clone:
      from: { step: pricing, match: "[data-test=plan-card]" }
      into: "[data-test=sidebar]"
`,
      'utf8',
    );

    const resolved = await resolveVariant({
      name: 'promote',
      root,
      gitRoot: root,
      flowStepIds: ['home', 'pricing'],
    });

    expect(resolved.spec.rules).toHaveLength(1);
  });
});

describe('the per-viewport runtime', () => {
  const cloning = spec([
    { id: 'tighter-cards', match: '.card', style: { padding: '8px' } },
    {
      id: 'promote-upsell',
      clone: {
        from: { step: 'pricing', match: '.plan' },
        into: '.sidebar',
        position: 'prepend',
        times: 2,
      },
    },
  ]);

  it('names the rules whose clone source has to be extracted before the first capture', () => {
    const runtime = buildVariantRuntime({ plan: plan(cloning), viewport: VIEWPORT });

    expect(runtime.cloneRules().map((rule) => rule.id)).toEqual(['promote-upsell']);
  });

  it('refuses to build apply args while a clone source is unresolved (D23)', () => {
    const runtime = buildVariantRuntime({ plan: plan(cloning), viewport: VIEWPORT });

    // Reached before any screenshot is taken: a clone with nothing to clone must never be applied
    // half way and photographed.
    expect(() => runtime.applyArgs()).toThrow(/clone source/);
  });

  it('resolves every rule once the source is attached, and caches the result', () => {
    const runtime = buildVariantRuntime({ plan: plan(cloning), viewport: VIEWPORT });
    runtime.attachCloneSource('promote-upsell', {
      origin: "step 'pricing'",
      match: '.plan',
      html: '<div class="plan">Pro</div>',
      styles: ['.plan { color: red }'],
      computed: { color: 'rgb(255, 0, 0)' },
    });

    const args = runtime.applyArgs();

    expect(args.variant).toBe('denser-forecast');
    expect(args.rules.map((rule) => rule.verb)).toEqual(['style', 'clone']);
    expect(runtime.applyArgs()).toBe(args);
  });

  it('keeps every capture, tagged with the step and its own viewport', () => {
    const runtime = buildVariantRuntime({ plan: plan(spec([])), viewport: MOBILE });
    const first = report('denser-forecast', [ruleResult({ ruleId: 'tighter-cards' })]);

    runtime.record(STEP, first);
    runtime.record('pricing', report('denser-forecast', []));

    expect(runtime.reports()).toEqual([
      { step: STEP, viewport: MOBILE, report: first },
      { step: 'pricing', viewport: MOBILE, report: report('denser-forecast', []) },
    ]);
  });
});

describe('aggregating a run out of captures', () => {
  const ruleIds = ['tighter-cards', 'hide-aqi'];

  it('counts a rule as changing nothing only when it changed nothing in any capture', () => {
    const aggregate = aggregateReport('denser-forecast', ruleIds, [
      report('denser-forecast', [
        ruleResult({ ruleId: 'tighter-cards', outcome: 'applied' }),
        ruleResult({ ruleId: 'hide-aqi', verb: 'hide', outcome: 'unmatched', matched: 0, changed: 0, verified: 0 }),
      ]),
      report('denser-forecast', [
        ruleResult({ ruleId: 'tighter-cards', outcome: 'unmatched', matched: 0, changed: 0, verified: 0 }),
        ruleResult({ ruleId: 'hide-aqi', verb: 'hide', outcome: 'applied' }),
      ]),
    ]);

    expect(aggregate.rules.map((rule) => rule.outcome)).toEqual(['applied', 'applied']);
    expect(variantWarnings(aggregate)).toEqual([]);
  });

  it('keeps a revert seen in one viewport even when another viewport was fine (D22)', () => {
    const aggregate = aggregateReport('denser-forecast', ruleIds, [
      report('denser-forecast', [ruleResult({ ruleId: 'tighter-cards', outcome: 'applied' })]),
      report('denser-forecast', [
        ruleResult({
          ruleId: 'tighter-cards',
          outcome: 'reverted',
          verified: 0,
          detail: 'the element was replaced after the variant was applied',
        }),
      ]),
    ]);

    expect(aggregate.rules[0]).toMatchObject({
      outcome: 'reverted',
      detail: 'the element was replaced after the variant was applied',
    });
    const warning = variantWarnings(aggregate).find((entry) => entry.kind === 'variant-rule-reverted');
    expect(warning?.message).toContain("rule 'tighter-cards'");
    expect(warning?.message).toContain('the application re-rendered');
  });

  it('reports a rule no capture mentioned rather than dropping it', () => {
    const aggregate = aggregateReport('denser-forecast', ruleIds, [
      report('denser-forecast', [ruleResult({ ruleId: 'tighter-cards' })]),
    ]);

    expect(aggregate.rules[1]).toMatchObject({
      ruleId: 'hide-aqi',
      outcome: 'unmatched',
      detail: 'no capture reported this rule',
    });
    expect(variantWarnings(aggregate).map((warning) => warning.kind)).toEqual(['variant-rule-unmatched']);
  });

  it('sums the element counts and carries a material clone difference through', () => {
    const drifted = {
      origin: "url '/pricing'",
      compared: 20,
      differences: [{ property: 'color', source: 'rgb(255, 0, 0)', target: 'rgb(0, 128, 0)' }],
      material: true,
    };
    const aggregate = aggregateReport('denser-forecast', ['promote'], [
      report('denser-forecast', [
        ruleResult({ ruleId: 'promote', verb: 'clone', matched: 1, changed: 2, verified: 2 }),
      ]),
      report('denser-forecast', [
        ruleResult({
          ruleId: 'promote',
          verb: 'clone',
          matched: 1,
          changed: 2,
          verified: 2,
          clone: drifted,
        }),
      ]),
    ]);

    expect(aggregate.rules[0]).toMatchObject({ matched: 2, changed: 4, verified: 4, clone: drifted });
    const warning = variantWarnings(aggregate).find((entry) => entry.kind === 'variant-clone-unstyled');
    expect(warning?.message).toContain("rule 'promote'");
    expect(warning?.message).toContain('An unstyled clone is a misleading preview');
  });
});

describe('variant.json', () => {
  it('records where the spec came from, each rule, and every element it changed', () => {
    const value = spec([{ id: 'tighter-cards', match: '.card', style: { padding: '8px' } }]);
    const attribution = {
      variant: 'denser-forecast',
      ruleId: 'tighter-cards',
      verb: 'style' as const,
      target: '[data-test="forecast-card"]',
    };

    const json = variantReport(plan(value, '.visual-diff/variants/denser-forecast.yaml@abc1234'), [
      {
        step: STEP,
        viewport: VIEWPORT,
        report: report('denser-forecast', [ruleResult({ ruleId: 'tighter-cards' })], {
          attributions: [attribution],
          stylesInjected: 1,
        }),
      },
      {
        step: STEP,
        viewport: MOBILE,
        report: report('denser-forecast', [ruleResult({ ruleId: 'tighter-cards' })], {
          attributions: [attribution],
        }),
      },
    ]);

    expect(json.variant).toBe('denser-forecast');
    expect(json.file).toBe('.visual-diff/variants/denser-forecast.yaml@abc1234');
    expect(json.rules).toEqual([
      { ruleId: 'tighter-cards', verb: 'style', outcome: 'applied', matched: 2, changed: 2, verified: 2 },
    ]);
    expect(json.stylesInjected).toBe(1);
    expect(json.elements).toEqual([
      { ...attribution, step: STEP, viewport: VIEWPORT },
      { ...attribution, step: STEP, viewport: MOBILE },
    ]);
  });
});

describe('clone source grouping', () => {
  const rules: ApplicableRule[] = [
    { id: 'from-step', clone: { from: { step: 'pricing', match: '.plan' }, into: '.sidebar' } },
    { id: 'from-url', clone: { from: { url: '/pricing', match: '.plan' }, into: '.aside' } },
    { id: 'also-from-step', clone: { from: { step: 'pricing', match: '.other' }, into: '.sidebar' } },
  ];

  it('visits each source page once, however many rules read from it', () => {
    const groups = groupCloneRules(rules);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ step: 'pricing', origin: "step 'pricing'" });
    expect(groups[0]?.rules.map((rule) => rule.id)).toEqual(['from-step', 'also-from-step']);
    expect(groups[1]).toMatchObject({ url: '/pricing', origin: "url '/pricing'" });
  });

  it('gives a recording clone context its own HAR path, never the one being committed', () => {
    expect(cloneHarPath('/tmp/scratch/1280x800.har', 0)).toBe('/tmp/scratch/1280x800.clone-0.har');
    expect(cloneHarPath('/tmp/scratch/1280x800', 2)).toBe('/tmp/scratch/1280x800.clone-2.har');
  });
});

describe('the vocabulary seam', () => {
  it('carries a variant warning onto the run with its rule ids intact', () => {
    expect(
      toRunWarning({ kind: 'variant-rule-reverted', message: 'reverted', rules: ['tighter-cards'] }),
    ).toEqual({ kind: 'variant-rule-reverted', message: 'reverted', rules: ['tighter-cards'] });
  });

  it('re-throws a variant failure as the runner error type, field for field', () => {
    const failure = toRunnerError(
      new VariantError({
        code: 'variant-clone-source-empty',
        variant: 'denser-forecast',
        ruleId: 'promote',
        message: 'could not extract its clone source',
        hint: 'check the source selector',
      }),
    );

    expect(failure.code).toBe('variant-clone-source-empty');
    expect(failure.message).toBe('could not extract its clone source');
    expect(failure.hint).toBe('check the source selector');
    expect(failure.kind).toBe('variant-failed');
    expect(isVariantFailure(failure)).toBe(true);
  });

  it('does not claim someone else’s failure', () => {
    expect(isVariantFailure(new RunnerError({ code: 'other', message: 'other' }))).toBe(false);
    expect(isVariantFailure(new Error('plain'))).toBe(false);
  });
});
