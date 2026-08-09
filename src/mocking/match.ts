/**
 * Request matching (mocking spec §5, §11).
 *
 * Three rules, and all three are load-bearing:
 *
 * 1. **`method` is optional and defaults to any**, compared case-insensitively.
 * 2. **`url` is a required glob matched against the full URL including the query string.** Matching
 *    the path alone would make `**\/v1/forecast**` and a rule meant for `?past_days=7` the same
 *    rule, and query parameters are exactly how the fixture API varies (D14).
 * 3. **`nth` selects the nth occurrence of an otherwise identical request, counted per
 *    `(method, url)` within a run** (§11) — not per rule. The counter is advanced once per request,
 *    before any rule is consulted, so two rules with `nth: 1` and `nth: 2` on the same URL see the
 *    same numbering and a rule that fails to match does not perturb it.
 *
 * First match wins in file order (§5), which is why {@link selectRule} returns the rule *and* its
 * index: the index is what makes "an earlier rule shadowed this one" explainable later.
 */

import type { ScenarioRule } from '../types.js';
import { matchesGlob } from './glob.js';

/** The engine's view of a request: everything matching needs, and nothing else. */
export interface MockRequest {
  method: string;
  /** Absolute URL including the query string. */
  url: string;
  /** Playwright's resource type, carried through to attribution consumers. Never matched on. */
  resourceType?: string;
}

export interface SelectedRule {
  rule: ScenarioRule;
  /** Position in `rules`, i.e. file order. */
  index: number;
  /** 1-based occurrence of this `(method, url)` within the run, the value `nth` is compared to. */
  occurrence: number;
}

/** The key `nth` counts against: method and full URL, per §11. */
export function requestKey(request: MockRequest): string {
  return `${request.method.toUpperCase()} ${request.url}`;
}

/**
 * Per-`(method, url)` occurrence counters for one run.
 *
 * State lives here rather than in the engine's matching code so that the decision half of the
 * engine can stay a pure function of `(rule, request, recorded)`.
 */
export class RequestCounter {
  #counts = new Map<string, number>();

  /** Count this request and return its 1-based occurrence. */
  next(request: MockRequest): number {
    const key = requestKey(request);
    const occurrence = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, occurrence);
    return occurrence;
  }

  /** How many times this request has been counted so far. */
  seen(request: MockRequest): number {
    return this.#counts.get(requestKey(request)) ?? 0;
  }

  reset(): void {
    this.#counts.clear();
  }
}

/** Does this rule match this request, given the request's occurrence number? */
export function ruleMatches(
  rule: ScenarioRule,
  request: MockRequest,
  occurrence: number,
): boolean {
  const { method, url, nth } = rule.match;
  if (method !== undefined && method.toUpperCase() !== request.method.toUpperCase()) return false;
  if (nth !== undefined && nth !== occurrence) return false;
  return matchesGlob(url, request.url);
}

/** The first rule matching this request in file order, or `null` for a passthrough. */
export function selectRule(
  rules: readonly ScenarioRule[],
  request: MockRequest,
  occurrence: number,
): SelectedRule | null {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index] as ScenarioRule;
    if (ruleMatches(rule, request, occurrence)) return { rule, index, occurrence };
  }
  return null;
}
