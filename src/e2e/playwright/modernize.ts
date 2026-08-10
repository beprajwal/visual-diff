/**
 * `e2e/playwright` — reading a version 7 archive as if it were version 8.
 *
 * Exactly one difference between the two versions matters to this reader, and it is the difference
 * most likely to be missed, because nothing fails when you miss it:
 *
 * > **v7 stores an action's title under `apiName`. v8 renamed it to `title`.**
 *
 * A reader that only looks at `title` returns `undefined` for every action of every trace produced
 * by Playwright 1.45 through 1.52 — no error, no warning, just a suite whose steps are all named
 * after their selectors and whose ids drift the moment a locator changes. Playwright's own
 * `_modernize_7_to_8` performs this rename plus `stepId = stepId ?? callId`, and both are applied
 * here.
 *
 * Nothing else is modernized. `version.ts` explains why versions below 7 are refused rather than
 * upgraded: the chain of rewrites that gets a version 3 trace to version 8 cannot invent the
 * `stepId` and `origin` fields those events never carried.
 */

import { isAfter, isBefore, type AnyTraceEvent, type BeforeActionEvent } from './events.js';

export interface ModernizeResult {
  events: AnyTraceEvent[];
  /** True when any event was rewritten, so the caller can record the `modernized` notice. */
  changed: boolean;
}

/** Rewrites version 7 events into their version 8 shape. Version 8 passes through untouched. */
export function modernizeEvents(events: readonly AnyTraceEvent[], version: number): ModernizeResult {
  if (version >= 8) return { events: [...events], changed: false };

  let changed = false;
  const out = events.map((event) => {
    if (isBefore(event)) {
      const before = event as BeforeActionEvent & { apiName?: string };
      const title = before.title ?? before.apiName;
      const stepId = before.stepId ?? before.callId;
      if (title === before.title && stepId === before.stepId) return event;
      changed = true;
      const next: BeforeActionEvent = { ...before, stepId };
      if (title !== undefined) next.title = title;
      return next;
    }
    if (isAfter(event)) return event;
    return event;
  });

  return { events: out, changed };
}
