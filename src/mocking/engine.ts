/**
 * The overlay engine (mocking spec §5, §8).
 *
 * Pure logic: no browser, no network, no clock. Given a scenario, a request and — when the verb
 * needs one — the recorded response, it returns a typed {@link MockAction} for the runner to
 * execute plus the {@link ScenarioAttribution} that goes into `network.json`. The runner decides
 * *how* to abort or fulfil; it never decides *what*, which is what makes §10.3's golden tests
 * possible at all and keeps `delay` a deferred fulfilment rather than a sleeping runner (§11).
 *
 * The split is deliberate:
 *
 * - {@link ScenarioEngine.select} is stateful, because `nth` counts occurrences per `(method, url)`
 *   across the run and because "which rules never matched" (§8) is run-scoped bookkeeping.
 * - {@link resolveDecision} is a pure function of `(scenario, mode, rule, request, recorded)`.
 *
 * Two rules of thumb decide the failure/warning boundary throughout, both from §8:
 *
 * - a rule that *cannot* do what it says **fails the run naming the rule** (patch against a
 *   non-JSON body, patch with nothing recorded to patch);
 * - a rule that *did nothing* **warns**, because the user is looking at a screen they believe is
 *   patched and the tool must say it is not.
 */

import type {
  RunWarning,
  ScenarioAction,
  ScenarioAttribution,
  ScenarioMode,
  ScenarioRule,
  ScenarioSpec,
} from '../types.js';
import { ScenarioError, ruleLabel } from './errors.js';
import { compileGlob, globErrorMessage } from './glob.js';
import { applyJsonPatch } from './json-patch.js';
import { RequestCounter, selectRule, type MockRequest, type SelectedRule } from './match.js';
import { applyMergePatch, jsonEquals } from './merge-patch.js';
import {
  bodyChangedFrom,
  isJsonMediaType,
  jsonBody,
  responseFromSpec,
  withJsonBody,
  type MockResponse,
  type RecordedResponse,
} from './response.js';

/** Why a request was aborted: a rule said so, or `mock` mode had nothing to serve it. */
export type AbortReason = 'rule' | 'no-recording';

/**
 * What the runner should do with a request. `passthrough` means "let the recording serve it" —
 * possibly late, which is the delay-only rule.
 */
export type MockAction =
  | { kind: 'passthrough'; delayMs: number }
  | { kind: 'fulfill'; delayMs: number; response: MockResponse }
  | { kind: 'abort'; delayMs: number; reason: AbortReason };

export interface ScenarioDecision {
  action: MockAction;
  attribution: ScenarioAttribution;
  /** The rule that produced this decision, for callers wanting more than its id. */
  rule: ScenarioRule | null;
}

/** Which verb a rule carries. `delay` is the modifier standing alone (§5). */
export function verbOf(rule: ScenarioRule): ScenarioAction {
  if (rule.patch !== undefined) return 'patch';
  if (rule.patchOps !== undefined) return 'patchOps';
  if (rule.respond !== undefined) return 'respond';
  if (rule.abort === true) return 'abort';
  return 'delay';
}

/** True when {@link resolveDecision} needs the recorded response to answer for this rule. */
export function needsRecordedResponse(selected: SelectedRule | null): boolean {
  if (selected === null) return false;
  const verb = verbOf(selected.rule);
  return verb === 'patch' || verb === 'patchOps';
}

export interface ResolveParams {
  scenario: string;
  mode: ScenarioMode;
  request: MockRequest;
  selected: SelectedRule | null;
  /** Required for `patch` and `patchOps`; ignored by every other verb. */
  recorded?: RecordedResponse | undefined;
}

function attribution(
  scenario: string,
  ruleId: string | null,
  action: ScenarioAction,
  bodyChanged: boolean,
): ScenarioAttribution {
  return { scenario, ruleId, action, bodyChanged };
}

/**
 * Decide what happens to one request. Pure — the same inputs always produce the same action, which
 * is what lets §10.1's determinism guarantee survive this layer.
 *
 * Throws {@link ScenarioError} for the §8 run failures, each naming the rule.
 */
export function resolveDecision(params: ResolveParams): ScenarioDecision {
  const { scenario, mode, request, selected, recorded } = params;

  if (selected === null) {
    // Unmatched: served from the recording in overlay mode, aborted as a miss in mock mode (§5).
    if (mode === 'mock') {
      return {
        action: { kind: 'abort', delayMs: 0, reason: 'no-recording' },
        attribution: attribution(scenario, null, 'miss', false),
        rule: null,
      };
    }
    return {
      action: { kind: 'passthrough', delayMs: 0 },
      attribution: attribution(scenario, null, 'passthrough', false),
      rule: null,
    };
  }

  const { rule } = selected;
  const delayMs = rule.delay ?? 0;
  const verb = verbOf(rule);
  // Read the verbs into locals: the rule type is an intersection with a five-branch union, and a
  // local narrows where `rule.patch` does not.
  const patch = rule.patch;
  const patchOps = rule.patchOps;
  const respond = rule.respond;

  if (rule.abort === true) {
    return {
      action: { kind: 'abort', delayMs, reason: 'rule' },
      attribution: attribution(scenario, rule.id, 'abort', false),
      rule,
    };
  }

  if (respond !== undefined) {
    // `respond` does not need the recording, so callers usually pass none and a synthetic body is
    // reported as changed — which it is. When a caller does supply the recorded response, the
    // comparison is real, and a rule that happens to restate the recorded body reports `false`.
    const response = responseFromSpec(respond);
    return {
      action: { kind: 'fulfill', delayMs, response },
      attribution: attribution(
        scenario,
        rule.id,
        'respond',
        bodyChangedFrom(recorded, response),
      ),
      rule,
    };
  }

  if (patch === undefined && patchOps === undefined) {
    // A delay-only rule passes the recorded response through, late. In `mock` mode there is no
    // recording to pass through, so the request is a miss like any other unserved one — attributed
    // to the rule, so the report says which rule left it unserved rather than blaming the glob.
    if (mode === 'mock') {
      return {
        action: { kind: 'abort', delayMs, reason: 'no-recording' },
        attribution: attribution(scenario, rule.id, 'miss', false),
        rule,
      };
    }
    return {
      action: { kind: 'passthrough', delayMs },
      attribution: attribution(scenario, rule.id, 'delay', false),
      rule,
    };
  }

  /* -------------------------------------------------------------- patch and patchOps */

  if (mode === 'mock') {
    // Rejected at validation (§5); reaching here means something bypassed the validator, and a
    // merge patch against a nonexistent body would produce whatever the patch alone contains.
    throw new ScenarioError({
      code: 'scenario-patch-in-mock',
      scenario,
      ruleId: rule.id,
      url: request.url,
      message:
        `${ruleLabel(scenario, rule.id)} uses ${verb}, which is not valid in a mock-mode ` +
        'scenario: there is no recorded response to patch',
      hint: "use 'respond' to serve a whole body, or set mode: overlay and record the traffic",
    });
  }

  if (recorded === undefined) {
    throw new ScenarioError({
      code: 'scenario-no-recorded-response',
      scenario,
      ruleId: rule.id,
      url: request.url,
      message:
        `${ruleLabel(scenario, rule.id)} matched ${request.method} ${request.url}, but the ` +
        `recording has no response for it, so there is nothing for ${verb} to patch`,
      hint: "re-record the flow, or use 'respond' to serve a whole body for this request",
    });
  }

  if (!isJsonMediaType(recorded.mediaType)) {
    const described = recorded.mediaType === '' ? 'no content type' : `'${recorded.mediaType}'`;
    throw new ScenarioError({
      code: 'scenario-patch-non-json',
      scenario,
      ruleId: rule.id,
      url: request.url,
      message:
        `${ruleLabel(scenario, rule.id)} cannot apply ${verb} to ${request.method} ` +
        `${request.url}: the recorded response declares ${described}, and patch/patchOps are only ` +
        'valid against JSON content types',
      hint: "use 'respond' to replace a non-JSON body outright",
    });
  }

  const parsed = jsonBody(recorded);
  if (!parsed.ok) {
    throw new ScenarioError({
      code: parsed.empty ? 'scenario-empty-recorded-body' : 'scenario-unparseable-body',
      scenario,
      ruleId: rule.id,
      url: request.url,
      message:
        `${ruleLabel(scenario, rule.id)} cannot apply ${verb} to ${request.method} ` +
        `${request.url}: ${parsed.detail}`,
      hint: "use 'respond' to serve a whole body for this request",
    });
  }

  const before = parsed.value;

  if (patch !== undefined) {
    const after = applyMergePatch(before, patch);
    return {
      action: { kind: 'fulfill', delayMs, response: withJsonBody(recorded, after) },
      attribution: attribution(scenario, rule.id, 'patch', !jsonEquals(before, after)),
      rule,
    };
  }

  // `patchOps` is defined here — the two branches above returned for every other verb — but the
  // rule type is an intersection the compiler cannot follow that far, and an empty op list is the
  // one fallback that cannot change a body.
  const result = applyJsonPatch(before, patchOps ?? []);
  if (!result.ok) {
    throw new ScenarioError({
      code: 'scenario-patch-op-failed',
      scenario,
      ruleId: rule.id,
      url: request.url,
      message:
        `${ruleLabel(scenario, rule.id)} could not apply patchOps to ${request.method} ` +
        `${request.url}: ${result.error.message}`,
    });
  }

  return {
    action: { kind: 'fulfill', delayMs, response: withJsonBody(recorded, result.value) },
    attribution: attribution(scenario, rule.id, 'patchOps', !jsonEquals(before, result.value)),
    rule,
  };
}

/** How many missed URLs a warning lists before it starts counting instead of naming. */
export const MAX_REPORTED_MISS_URLS = 20;

/**
 * One run's worth of scenario state: occurrence counters, which rules have matched, and which
 * requests went unserved.
 */
export class ScenarioEngine {
  readonly spec: ScenarioSpec;
  readonly scenario: string;
  readonly mode: ScenarioMode;

  readonly #counter = new RequestCounter();
  readonly #matched = new Set<string>();
  readonly #missed = new Map<string, number>();

  constructor(spec: ScenarioSpec) {
    this.spec = spec;
    this.scenario = spec.scenario;
    this.mode = spec.mode;

    // Compile every glob up front. A pattern that does not compile matches nothing, and "matches
    // nothing" is indistinguishable from a mistyped glob at run time — the exact confusion §8's
    // never-matched warning exists to prevent — so the engine refuses to start instead.
    for (const rule of spec.rules) {
      const compiled = compileGlob(rule.match.url);
      if (compiled.ok) continue;
      throw new ScenarioError({
        code: 'scenario-invalid-glob',
        scenario: this.scenario,
        ruleId: rule.id,
        exitCode: 2,
        kind: 'scenario-invalid',
        message: `${ruleLabel(this.scenario, rule.id)}: ${globErrorMessage(rule.match.url, compiled.error)}`,
      });
    }
  }

  static from(spec: ScenarioSpec): ScenarioEngine {
    return new ScenarioEngine(spec);
  }

  /**
   * Count this request and pick the rule that owns it, first match wins in file order. Stateful:
   * it advances the `nth` counters and marks the chosen rule as having matched.
   */
  select(request: MockRequest): SelectedRule | null {
    const occurrence = this.#counter.next(request);
    const selected = selectRule(this.spec.rules, request, occurrence);
    if (selected !== null) this.#matched.add(selected.rule.id);
    return selected;
  }

  /** True when {@link ScenarioEngine.resolve} needs the recorded response for this rule. */
  needsRecordedResponse(selected: SelectedRule | null): boolean {
    return needsRecordedResponse(selected);
  }

  /** {@link resolveDecision}, plus the miss bookkeeping the warnings are built from. */
  resolve(
    request: MockRequest,
    selected: SelectedRule | null,
    recorded?: RecordedResponse | undefined,
  ): ScenarioDecision {
    const decision = resolveDecision({
      scenario: this.scenario,
      mode: this.mode,
      request,
      selected,
      recorded,
    });
    if (decision.attribution.action === 'miss') {
      const key = `${request.method.toUpperCase()} ${request.url}`;
      this.#missed.set(key, (this.#missed.get(key) ?? 0) + 1);
    }
    return decision;
  }

  /**
   * Select and resolve in one call, for the common case where the caller already holds the recorded
   * response (or knows there is none).
   */
  handle(request: MockRequest, recorded?: RecordedResponse | undefined): ScenarioDecision {
    return this.resolve(request, this.select(request), recorded);
  }

  /** Rule ids that matched at least one request, in file order. */
  matchedRuleIds(): string[] {
    return this.spec.rules.filter((rule) => this.#matched.has(rule.id)).map((rule) => rule.id);
  }

  /** Rule ids that never matched, in file order (§8). */
  unmatchedRuleIds(): string[] {
    return this.spec.rules.filter((rule) => !this.#matched.has(rule.id)).map((rule) => rule.id);
  }

  /**
   * The never-matched warning — "the most important line in §8".
   *
   * A user looking at a screen they believe is the empty state, when a mistyped glob matched
   * nothing and they are in fact seeing the recorded full response, has been actively misled by the
   * tool. So the warning names every silent rule and says what was served instead.
   */
  unmatchedRulesWarning(): RunWarning | null {
    const rules = this.unmatchedRuleIds();
    if (rules.length === 0) return null;
    const subject =
      rules.length === 1
        ? `rule '${rules[0] as string}' never matched a request`
        : `${rules.length} rules never matched a request (${rules.join(', ')})`;
    const consequence =
      this.mode === 'mock'
        ? 'nothing was served in their place, so the screens you are looking at are missing those responses'
        : 'those requests were served from the recording unchanged, so the screens you are looking ' +
          'at are the recorded state, not the patched one';
    return {
      kind: 'scenario-rule-unmatched',
      message: `scenario '${this.scenario}': ${subject} during this run — ${consequence}. Check the url glob.`,
      rules,
    };
  }

  /** Requests aborted with no recording to fall back to, most recent counts included. */
  missedRequests(): Array<{ request: string; count: number }> {
    return [...this.#missed.entries()].map(([request, count]) => ({ request, count }));
  }

  /** The `mock` mode miss warning (§8): unmatched requests were aborted, and here is which. */
  missWarning(): RunWarning | null {
    const entries = this.missedRequests();
    if (entries.length === 0) return null;
    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    const urls = entries.slice(0, MAX_REPORTED_MISS_URLS).map((entry) => entry.request);
    const overflow = entries.length - urls.length;
    const tail = overflow > 0 ? ` (${overflow} more not listed)` : '';
    return {
      kind: 'mock-miss',
      message:
        `scenario '${this.scenario}' (mock mode): ${total} ` +
        `${total === 1 ? 'request' : 'requests'} across ${entries.length} ` +
        `${entries.length === 1 ? 'url' : 'urls'} matched no rule and ` +
        `${total === 1 ? 'was' : 'were'} aborted${tail} — ` +
        'a mock-mode run serves only what its rules serve',
      urls,
    };
  }

  /** Every warning this run produced, in the order a report should show them. */
  warnings(): RunWarning[] {
    const out: RunWarning[] = [];
    const unmatched = this.unmatchedRulesWarning();
    if (unmatched !== null) out.push(unmatched);
    const misses = this.missWarning();
    if (misses !== null) out.push(misses);
    return out;
  }

  /** Forget everything this run recorded. Used between runs that share one engine. */
  reset(): void {
    this.#counter.reset();
    this.#matched.clear();
    this.#missed.clear();
  }
}
