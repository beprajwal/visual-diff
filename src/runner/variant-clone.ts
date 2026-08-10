/**
 * Resolving clone sources (variants spec §4, §7; D23).
 *
 * `clone.from` is either a **step** the flow already captures — deterministic, one session,
 * guaranteed the same revision — or a **url** the flow never visits, as the escape hatch. Both are
 * resolved *before the first capture*, so a missing source fails fast rather than half way through a
 * run that has already produced screenshots nobody can trust.
 *
 * What a source page yields is `variant-apply/inpage.ts#extractCloneSourceInPage`'s business, and
 * what a failed extraction says is `plan.ts#cloneSourceFrom`'s. What is here is the part only the
 * runner can do — getting a *browser* to that page under the same conditions as the target:
 *
 *  - **The same knobs.** Extraction goes through `newContext`, so the frozen clock, the seeded
 *    `Math.random`, the locale, the reduced motion and the network mode are identical (§9). A clone
 *    lifted from a page with a live clock would carry a different rendered time into the target and
 *    diff against itself on the next run.
 *  - **The same scenario, but not the same *instance*.** `nth` counts occurrences of a request
 *    within a viewport (mocking §11), so handing the extraction context the target's runtime would
 *    let source traffic consume the target's `nth` rules and make the target page depend on how many
 *    clone sources the variant happened to declare. The caller passes a factory, and each source
 *    gets its own engine over the same spec.
 *  - **The same steps.** A `step:` source replays the flow with the runner's own step verbs, so the
 *    page cloned from is the page that step actually produces.
 *
 * Cloning never reaches across revisions (§2): the source is this run's application at this run's
 * revision, which is what makes a clone a prediction about the app rather than a collage.
 */

import type { Browser, BrowserContext, Page } from 'playwright-core';

import type { FlowSpec, RunFailureKind, Step } from '../types.js';
import type { VariantName } from '../variant/index.js';
import {
  VariantError,
  cloneExtractArgs,
  cloneOrigin,
  cloneSourceFrom,
  extractCloneSourceInPage,
  type ApplicableRule,
  type ExtractedClone,
} from '../variant-apply/index.js';

import { inFlightRequests, newContext, settle, type ContextOptions } from './browser.js';
import { RunnerError, errorMessage } from './errors.js';
import type { ScenarioRuntime } from './scenario.js';
import { toRunnerError } from './variant.js';

export interface ExtractCloneSourcesOptions {
  browser: Browser;
  variant: VariantName;
  /** The clone rules to resolve, in file order. */
  rules: readonly ApplicableRule[];
  /** The flow, so a `step` source can be replayed up to that step. */
  flow: FlowSpec;
  /**
   * The target's context options, minus its scenario runtime. Reused verbatim so the source page
   * gets the same determinism knobs and network mode (§9).
   */
  context: Omit<ContextOptions, 'scenario'>;
  /** A *fresh* scenario runtime per source context; see the header on why it is not shared. */
  newScenarioRuntime?: () => ScenarioRuntime;
  /** Drives one flow step against a page — `replay.ts` owns the verbs, this file owns the session. */
  perform: (page: Page, step: Step) => Promise<void>;
  timeoutMs: number;
}

/** One source page, with every rule that reads from it. */
export interface SourceGroup {
  step?: string;
  url?: string;
  /** `step 'pricing'` or `url '/pricing'` — how this source is named in every message about it. */
  origin: string;
  rules: ApplicableRule[];
}

/**
 * Group clone rules by source page, so two rules cloning from one step replay that step once.
 *
 * Not merely an optimisation: replaying a flow twice to extract two elements from one screen would
 * double that screen's traffic, and under a scenario with `nth` the second replay would see a
 * different response from the first.
 */
export function groupCloneRules(rules: readonly ApplicableRule[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const rule of rules) {
    const from = rule.clone?.from;
    if (from === undefined) continue;
    const key = from.step !== undefined ? `step:${from.step}` : `url:${from.url ?? ''}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.rules.push(rule);
      continue;
    }
    const group: SourceGroup = { origin: cloneOrigin(from), rules: [rule] };
    if (from.step !== undefined) group.step = from.step;
    if (from.url !== undefined) group.url = from.url;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * The HAR a clone-source context records into, when the run is recording.
 *
 * `run.ts` hands every recording context a path inside the run's scratch directory and publishes
 * only the first viewport's file, so a sibling name there is written, never read, and removed with
 * the rest of the scratch when the run ends. Sharing the target's path would have the second
 * context's `close()` overwrite the recording the run is about to commit.
 */
export function cloneHarPath(har: string, index: number): string {
  const base = har.endsWith('.har') ? har.slice(0, -'.har'.length) : har;
  return `${base}.clone-${index}.har`;
}

async function openSourceContext(
  options: ExtractCloneSourcesOptions,
  index: number,
): Promise<BrowserContext> {
  const runtime = options.newScenarioRuntime?.();
  const base: ContextOptions = {
    ...options.context,
    ...(runtime === undefined ? {} : { scenario: runtime }),
  };
  if (base.network === 'record' && base.har !== undefined) base.har = cloneHarPath(base.har, index);
  return await newContext(options.browser, base);
}

function failure(
  options: ExtractCloneSourcesOptions,
  group: SourceGroup,
  init: { code: string; message: string; hint?: string; cause?: unknown },
): RunnerError {
  const ruleId = group.rules[0]?.id ?? '';
  return new RunnerError({
    code: init.code,
    message: `variant '${options.variant}' rule '${ruleId}': ${init.message}`,
    // The same widening seam `variant.ts` documents: `RunFailureKind` does not yet carry the two
    // buckets `variant-apply/errors.ts` defines, and this is the string that goes to disk.
    kind: 'variant-failed' as unknown as RunFailureKind,
    ...(init.hint === undefined ? {} : { hint: init.hint }),
    ...(init.cause === undefined ? {} : { cause: init.cause }),
  });
}

/** Replay the flow up to and including `stepId`, so the source page is the one that step captures. */
async function driveToStep(
  page: Page,
  options: ExtractCloneSourcesOptions,
  stepId: string,
  group: SourceGroup,
): Promise<void> {
  const index = options.flow.steps.findIndex((step) => step.id === stepId);
  if (index === -1) {
    // Validation refuses this before the run starts, given the flow's step ids (§7). Reaching it
    // here would mean the flow being replayed is not the flow that was validated, so it is refused
    // rather than skipped: a clone that quietly did not happen is a preview of the wrong thing.
    throw failure(options, group, {
      code: 'variant-clone-step-unknown',
      message: `clone source ${group.origin} is not a step of flow '${options.flow.flow}'`,
    });
  }
  for (let i = 0; i <= index; i += 1) {
    const step = options.flow.steps[i] as Step;
    try {
      await options.perform(page, step);
    } catch (cause) {
      throw failure(options, group, {
        code: 'variant-clone-source-failed',
        message:
          `replaying flow '${options.flow.flow}' to clone source ${group.origin} failed at step ` +
          `'${step.id}': ${errorMessage(cause)}`,
        hint: 'the clone source is a step of this flow, so it must replay before the variant can be applied',
        cause,
      });
    }
  }
}

async function openSourceUrl(
  page: Page,
  options: ExtractCloneSourcesOptions,
  url: string,
  group: SourceGroup,
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  } catch (cause) {
    // §7: "clone source URL unreachable under the active network mode — run fails, naming the rule
    // and URL". The mode is named too, because under `off`, `replay` and `mock` the runner is what
    // refused the request, and a bare "navigation failed" would send the user hunting a network
    // problem that does not exist.
    throw failure(options, group, {
      code: 'variant-clone-url-unreachable',
      message:
        `clone source url '${url}' could not be loaded under network mode ` +
        `'${options.context.network}': ${errorMessage(cause)}`,
      hint:
        options.context.network === 'off' || options.context.network === 'mock'
          ? 'this network mode serves only the application origin and what the scenario supplies; clone from a step, or a url the run can reach'
          : 'check the url, or clone from a step the flow already visits',
      cause,
    });
  }
}

/**
 * Resolve every clone source for one viewport, before its first capture (D23).
 *
 * Returns one {@link ExtractedClone} per clone rule id. Any source that cannot be resolved fails the
 * run naming the rule and the source: a variant that quietly dropped a clone would show a sidebar
 * without the promoted card and call it the proposal.
 */
export async function extractCloneSources(
  options: ExtractCloneSourcesOptions,
): Promise<Map<string, ExtractedClone>> {
  const sources = new Map<string, ExtractedClone>();
  const groups = groupCloneRules(options.rules);
  if (groups.length === 0) return sources;

  for (const [index, group] of groups.entries()) {
    const context = await openSourceContext(options, index);
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(options.timeoutMs);

      if (group.step !== undefined) await driveToStep(page, options, group.step, group);
      else await openSourceUrl(page, options, group.url ?? '', group);

      // The gate the target capture waits on — in-flight requests, `document.fonts.ready`, two idle
      // frames — so a clone descends from a settled page rather than a half-rendered one. An element
      // extracted mid-render is an element whose styles have not arrived.
      await settle(page, () => inFlightRequests(page).length);

      for (const rule of group.rules) {
        try {
          const extracted = await page.evaluate(
            extractCloneSourceInPage,
            cloneExtractArgs(options.variant, rule),
          );
          sources.set(rule.id, cloneSourceFrom(options.variant, extracted));
        } catch (error) {
          // "A source that matched nothing is a *run* failure rather than a warning": the sentence
          // is `cloneSourceFrom`'s, and it is re-thrown in the runner's error type so it carries an
          // exit code and a `meta.json` failure kind.
          if (VariantError.is(error)) throw toRunnerError(error);
          throw error;
        }
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  }
  return sources;
}
