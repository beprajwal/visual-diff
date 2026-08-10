/**
 * Variant execution (variants spec §4, §7, §9; D20–D24).
 *
 * A variant is a declarative set of rules applied to the *rendered* page just before capture, so a
 * proposed change can be looked at without being built (§1). The constraint that makes the feature
 * safe falls out of the mechanism rather than being policed: **a variant cannot invent UI**. Every
 * rule operates on nodes the application produced, and `clone` copies a node it rendered on another
 * page of the same revision. There is no HTML injection verb and there must never be one.
 *
 * The layering is the one the mocking slice established, and this file sits where `scenario.ts`
 * sits:
 *
 *  - the **language** is `src/variant/` — parse, validate, serialize, scaffold — as `src/scenario/`
 *    is for scenarios;
 *  - the **decision** is `src/variant-apply/` — what each rule does to a page, what the verification
 *    pass concludes, and what the warnings say — as `src/mocking/` is for responses;
 *  - the **execution** is here: the only place either of them meets a live browser.
 *
 * Four things belong to this file and to nothing else:
 *
 *  1. **Where the spec comes from.** On historical replay the variant is read out of git history at
 *     the target SHA, exactly as the flow spec and the scenario are under D4 — replaying an old
 *     revision with today's variant would compare a revision against a proposal that never met it.
 *     A variant absent at that SHA is rejected cleanly.
 *  2. **Per-viewport state.** One runtime per viewport, holding that viewport's extracted clone
 *     sources and the report of every capture it made.
 *  3. **Aggregating a run out of captures.** A flow captures many steps in many viewports and each
 *     produces its own report. "This rule changed nothing" is only true when it changed nothing in
 *     *any* of them — the rule the never-matched scenario warning already follows (mocking §8) — so
 *     the run-level view is rolled up here and handed to `variantWarnings` once.
 *  4. **Speaking the runner's error type.** A `VariantError` becomes a `RunnerError` the same way a
 *     `ScenarioError` does, so a variant failure carries an exit code and a `meta.json` failure kind.
 */

import { readFile } from 'node:fs/promises';

import {
  EXIT,
  type RunFailureKind,
  type RunWarning,
  type RunWarningKind,
  type StepId,
  type ViewportId,
} from '../types.js';
import {
  parseVariantSource,
  variantNameIssue,
  variantRepoPath,
  type VariantName,
  type VariantSpec,
} from '../variant/index.js';
import {
  VARIANT_CLONE_ATTR,
  VariantError,
  buildVariantApplyArgs,
  variantFile,
  type ApplicableRule,
  type AttributedElement,
  type ExtractedClone,
  type RuleResult,
  type VariantApplyArgs,
  type VariantApplyReport,
  type VariantWarning,
} from '../variant-apply/index.js';

import { RunnerError } from './errors.js';
import { showFileAtRev } from './git.js';

/**
 * Re-exported, not reimplemented — the arrangement `scenario.ts` uses for `scenarioFile`.
 * `.visual-diff/variants/<name>.yaml` is defined once, in `variant-apply/paths.ts`; a second
 * spelling here is how the runner and `vdiff variant check` would come to disagree about which file
 * a name refers to.
 */
export { variantFile };

/* ------------------------------------------------------------------ names */

/**
 * Reject a variant name that cannot be a filename, and the reserved one, before anything touches
 * the disk — the check `assertRunnableScenarioName` performs for scenarios, and for the same
 * reason: `none` is what `meta.json` records for a run captured without a variant (§5), so a
 * variant of that name would leave `meta.variant` unable to say which of the two it meant.
 *
 * The judgement is the variant layer's `variantNameIssue`; what is decided here is only what a *run*
 * does about it, which is to refuse before the store, the browser or the dev server is touched.
 */
export function assertRunnableVariantName(name: VariantName): VariantName {
  const issue = variantNameIssue(name);
  if (issue === null) return name;
  throw new RunnerError({
    code: issue.code,
    message: issue.message,
    exitCode: EXIT.CONFIG_ERROR,
    kind: VARIANT_INVALID,
    hint: 'pick another name, or drop --variant to run without one',
  });
}

/* ------------------------------------------------------------------ the vocabulary seam */

/**
 * The two closed unions in `src/types.ts` this slice extends, and the one place they are widened.
 *
 * `RunWarningKind` and `RunFailureKind` are the store's on-disk vocabulary. `variant-apply/types.ts`
 * says of its warning kinds that they are "shaped exactly like `RunWarning` … so the runner can push
 * these onto a run's warnings once `RunWarningKind` gains the three members", and
 * `variant-apply/errors.ts` says the same of its failure kinds. The three casts below are that seam
 * and the only ones in this slice: every string written to disk is already its final value, and the
 * day those unions gain the members the casts disappear without a call site changing.
 */
const VARIANT_INVALID = 'variant-invalid' as unknown as RunFailureKind;
const VARIANT_MISSING = 'variant-missing' as unknown as RunFailureKind;

/** A `VariantWarning` as the run records it. */
export function toRunWarning(warning: VariantWarning): RunWarning {
  const out: RunWarning = { kind: warning.kind as unknown as RunWarningKind, message: warning.message };
  if (warning.rules !== undefined) out.rules = warning.rules;
  return out;
}

/** Re-throw a variant failure as the runner's error type. The fields line up one-to-one. */
export function toRunnerError(error: VariantError): RunnerError {
  return new RunnerError({
    code: error.code,
    message: error.message,
    exitCode: error.exitCode,
    kind: error.kind as unknown as RunFailureKind,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    cause: error,
  });
}

const VARIANT_FAILURE_KINDS: readonly string[] = ['variant-invalid', 'variant-failed', 'variant-missing'];

/**
 * True for a failure this subsystem raised.
 *
 * `run.ts` re-throws these ahead of its generic "every viewport replay failed" message: a clone
 * source that could not be resolved has one sentence worth reading, and burying it under a summary
 * of the replay costs the user the only fact they can act on.
 */
export function isVariantFailure(error: unknown): error is RunnerError {
  return RunnerError.is(error) && VARIANT_FAILURE_KINDS.includes(error.kind as unknown as string);
}

/* ------------------------------------------------------------------ resolution */

/** A validated variant, with where it was read from, ready to build runtimes from. */
export interface VariantPlan {
  name: VariantName;
  spec: VariantSpec;
  /** Human-readable origin: the file path, or `<repo path>@<sha7>` on historical replay. */
  file: string;
}

export interface ResolveVariantOptions {
  name: VariantName;
  /** Project root — the directory containing `.visual-diff`. */
  root: string;
  /** Repository root, for reading out of history. */
  gitRoot: string;
  /** Set on historical replay: the SHA whose committed specs this run uses (D4). */
  sha?: string;
  /**
   * Step ids of the flow this variant will run against.
   *
   * Passed through to validation, which is where "clone source step not in the flow" becomes exit 2
   * **before the run starts** (§7), with the file, the line and the offending key that section asks
   * for. The runner is what knows the flow; the validator is what knows the line.
   */
  flowStepIds?: readonly string[];
  /** Injectable for tests; defaults to `git show`. */
  readAtRev?: (gitRoot: string, sha: string, path: string) => Promise<string | null>;
}

/**
 * Read and validate the variant this run will use.
 *
 * On the slow path the source comes from `git show <sha>:.visual-diff/variants/<name>.yaml`, the
 * same rule flows and scenarios follow under D4: a variant is a proposal *about a revision*, and
 * applying today's proposal to last week's code compares two things that never met.
 */
export async function resolveVariant(options: ResolveVariantOptions): Promise<VariantPlan> {
  const name = assertRunnableVariantName(options.name);
  const repoPath = variantRepoPath(name);

  let source: string;
  let file: string;
  if (options.sha === undefined) {
    file = variantFile(options.root, name);
    try {
      source = await readFile(file, 'utf8');
    } catch {
      throw new RunnerError({
        code: 'variant-missing',
        message: `no variant spec at ${file}`,
        exitCode: EXIT.CONFIG_ERROR,
        kind: VARIANT_MISSING,
        hint: `create it with \`vdiff variant new ${name}\``,
      });
    }
  } else {
    const sha = options.sha;
    const read = options.readAtRev ?? showFileAtRev;
    const fromHistory = await read(options.gitRoot, sha, repoPath);
    if (fromHistory === null) {
      throw new RunnerError({
        code: 'variant-missing-at-rev',
        message: `variant "${name}" did not exist at ${sha.slice(0, 7)}: ${repoPath}`,
        exitCode: EXIT.CONFIG_ERROR,
        kind: VARIANT_MISSING,
        hint: 'pick a revision where the variant was committed, or replay HEAD',
      });
    }
    source = fromHistory;
    file = `${repoPath}@${sha.slice(0, 7)}`;
  }

  const parsed = parseVariantSource(source, {
    file,
    expectVariantName: name,
    ...(options.flowStepIds === undefined ? {} : { flowStepIds: options.flowStepIds }),
  });
  if (!parsed.ok) {
    // §7 asks for file, line and offending key, which is what the validator's issues already carry.
    const first = parsed.issues[0];
    throw new RunnerError({
      code: first?.code ?? 'variant-invalid',
      message:
        first === undefined
          ? `invalid variant spec: ${file}`
          : `${first.at.file}${first.at.line === undefined ? '' : `:${first.at.line}`}: ${first.message}`,
      exitCode: EXIT.CONFIG_ERROR,
      kind: VARIANT_INVALID,
    });
  }

  return { name, spec: parsed.value, file };
}

/* ------------------------------------------------------------------ repeated captures */

/**
 * Remove the clones a previous capture inserted into *this* page, and say how many there were.
 *
 * Rules are applied once per **capture** (§9, D22), and a flow captures several steps against one
 * page without navigating between them. Four of the five verbs are idempotent under that — the
 * second pass sets the same declaration on the same node — but `clone` is not: it inserts again, so
 * `times: 2` would silently become `times: 4` by the second step and the screenshot would show a
 * proposal nobody wrote. Worse, the count would depend on how many steps preceded it, which is the
 * kind of order-dependence the determinism guarantee exists to rule out.
 *
 * Written as a self-contained in-page function, like every other one the runner evaluates: it takes
 * the attribute name as its only argument and closes over nothing.
 */
export function clearVariantClonesInPage(cloneAttr: string): number {
  const stale = Array.prototype.slice.call(
    document.querySelectorAll('[' + cloneAttr + ']'),
  ) as Element[];
  for (const element of stale) element.remove();
  return stale.length;
}

/** The attribute the application layer marks inserted clones with. */
export const CLONE_ATTR = VARIANT_CLONE_ATTR;

/* ------------------------------------------------------------------ the per-viewport runtime */

/** One capture's report, with where it was taken. */
export interface VariantCapture {
  step: StepId;
  viewport: ViewportId;
  report: VariantApplyReport;
}

export interface VariantRuntimeOptions {
  plan: VariantPlan;
  viewport: ViewportId;
}

/**
 * One viewport's variant state.
 *
 * **One runtime per viewport, never one per run**, for the reason `ScenarioRuntime` is per viewport:
 * viewports replay concurrently in separate contexts, and both the extracted clone material and the
 * reports describe *that* viewport's DOM. A shared runtime would let the desktop layout's clone be
 * verified against the mobile page. The run-level view — which rules changed nothing anywhere, which
 * reverted somewhere — is assembled by {@link aggregateReport}.
 */
export class VariantRuntime {
  readonly variant: VariantName;
  readonly spec: VariantSpec;
  readonly viewport: ViewportId;

  private readonly sources = new Map<string, ExtractedClone>();
  private readonly captures: VariantCapture[] = [];
  private args: VariantApplyArgs | undefined;

  constructor(options: VariantRuntimeOptions) {
    this.variant = options.plan.name;
    this.spec = options.plan.spec;
    this.viewport = options.viewport;
  }

  /** The rules, in the structural shape the application layer resolves. */
  rules(): readonly ApplicableRule[] {
    return this.spec.rules as readonly ApplicableRule[];
  }

  /** Rules whose clone source must be extracted before this viewport's first capture (D23). */
  cloneRules(): ApplicableRule[] {
    return this.rules().filter((rule) => rule.clone !== undefined);
  }

  attachCloneSource(ruleId: string, source: ExtractedClone): void {
    this.sources.set(ruleId, source);
    this.args = undefined;
  }

  /**
   * Resolve every rule into the single JSON argument the page is handed, once per viewport.
   *
   * Built here rather than at each capture so a rule the application layer refuses — two verbs, no
   * verb, `times` below 1, a clone whose source was never extracted — fails the viewport *before*
   * any screenshot is taken, rather than becoming a per-step failure half way down a filmstrip.
   */
  applyArgs(): VariantApplyArgs {
    if (this.args !== undefined) return this.args;
    try {
      this.args = buildVariantApplyArgs({
        variant: this.variant,
        rules: this.rules(),
        cloneSources: this.sources,
      });
    } catch (error) {
      if (VariantError.is(error)) throw toRunnerError(error);
      throw error;
    }
    return this.args;
  }

  /** Fold one capture's report in. */
  record(step: StepId, report: VariantApplyReport): void {
    this.captures.push({ step, viewport: this.viewport, report });
  }

  reports(): readonly VariantCapture[] {
    return this.captures;
  }
}

export function buildVariantRuntime(options: VariantRuntimeOptions): VariantRuntime {
  return new VariantRuntime(options);
}

/* ------------------------------------------------------------------ run-level aggregation */

const OUTCOME_RANK: Record<RuleResult['outcome'], number> = { reverted: 0, applied: 1, unmatched: 2 };

/**
 * Roll every capture's report up into the one report the run's warnings are built from.
 *
 * A flow captures many steps in many viewports and each produces its own report, so a rule can
 * legitimately change nothing in one of them — a sidebar rule on a step with no sidebar, a mobile
 * layout that never renders the element. Warning per report would fire on all of those and quickly
 * teach the reader to ignore the one that matters, so the run-level verdict per rule is:
 *
 *  - **reverted** if it was reverted in *any* capture. That capture's screenshot is wrong in a way
 *    nobody can see, which is exactly what D22's warning exists to say, and a good capture elsewhere
 *    does not make it right.
 *  - **applied** if it changed something and held, anywhere.
 *  - **unmatched** only when it changed nothing anywhere — the "matched in no viewport" rule the
 *    never-matched scenario warning already follows (mocking §8).
 */
export function aggregateReport(
  variant: VariantName,
  ruleIds: readonly string[],
  reports: ReadonlyArray<VariantApplyReport>,
): VariantApplyReport {
  const byRule = new Map<string, RuleResult>();
  const attributions: AttributedElement[] = [];
  let stylesInjected = 0;

  for (const report of reports) {
    stylesInjected += report.stylesInjected;
    attributions.push(...report.attributions);
    for (const rule of report.rules) {
      const existing = byRule.get(rule.ruleId);
      if (existing === undefined) {
        byRule.set(rule.ruleId, { ...rule });
        continue;
      }
      // The detail belongs to whichever capture decided the outcome, so a warning quotes the reason
      // for the verdict it reports rather than a reason from a capture that was fine.
      const decisive = OUTCOME_RANK[rule.outcome] < OUTCOME_RANK[existing.outcome] ? rule : existing;
      const merged: RuleResult = {
        ruleId: rule.ruleId,
        verb: rule.verb,
        outcome: decisive.outcome,
        matched: existing.matched + rule.matched,
        changed: existing.changed + rule.changed,
        verified: existing.verified + rule.verified,
      };
      if (decisive.detail !== undefined) merged.detail = decisive.detail;
      // A clone that renders wrong in one viewport renders wrong: the material check wins.
      const clone = existing.clone?.material === true ? existing.clone : (rule.clone ?? existing.clone);
      if (clone !== undefined) merged.clone = clone;
      byRule.set(rule.ruleId, merged);
    }
  }

  // File order, and every rule present: a rule no capture reported on still has to appear, or a run
  // that never reached the step a rule applies to would report nothing wrong at all.
  const rules: RuleResult[] = ruleIds.map(
    (ruleId) =>
      byRule.get(ruleId) ?? {
        ruleId,
        verb: 'style',
        outcome: 'unmatched',
        matched: 0,
        changed: 0,
        verified: 0,
        detail: 'no capture reported this rule',
      },
  );
  return { variant, rules, attributions, stylesInjected };
}

/** One modified element, with the capture it was modified in (§7). */
export type VariantElement = AttributedElement & { step: StepId; viewport: ViewportId };

/** What `variant.json` holds next to the run: the proposal, and every element it changed (§7). */
export interface VariantReport {
  variant: VariantName;
  /** Where the spec was read from — the path, or `<repo path>@<sha7>` on historical replay. */
  file: string;
  rules: RuleResult[];
  /** `<style>` elements carried over from clone sources and injected into the captured pages. */
  stylesInjected: number;
  elements: VariantElement[];
}

/**
 * Assemble `variant.json` from every capture of the run.
 *
 * This is the attribution §7 asks for — "each modified element records `{ variant, ruleId, verb }`"
 * — written next to the run so the report can annotate a step with "element modified by
 * `denser-forecast` rule `tighter-cards`" without instrumenting anything at view time. It is D11's
 * "a rule id is attribution for free", one subsystem over.
 */
export function variantReport(
  plan: VariantPlan,
  captures: ReadonlyArray<VariantCapture>,
): VariantReport {
  const aggregate = aggregateReport(
    plan.name,
    plan.spec.rules.map((rule) => rule.id),
    captures.map((capture) => capture.report),
  );
  const elements: VariantElement[] = [];
  for (const capture of captures) {
    for (const attribution of capture.report.attributions) {
      elements.push({ ...attribution, step: capture.step, viewport: capture.viewport });
    }
  }
  return {
    variant: plan.name,
    file: plan.file,
    rules: aggregate.rules,
    stylesInjected: aggregate.stylesInjected,
    elements,
  };
}
