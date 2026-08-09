/**
 * zod schema for scenario YAML v1 (mocking spec §5).
 *
 * This file describes *shape* only, exactly as `flow/schema.ts` does. Every object is `.strict()`,
 * so the closed vocabulary is enforced structurally and `parse.ts` can turn `unrecognized_keys`
 * into an `unknown-key` issue that names the offending key.
 *
 * Three shapes are deliberately left as `unknown` here — `patch`, each `patchOps` entry, and
 * `respond.body` — and are checked in `validate.ts` instead. zod would reject them accurately but
 * describe them badly: a union failure inside a recursive JSON schema reports "Invalid input" at
 * the root of the value, and mocking spec §10 is explicit that these messages are the feature's
 * user interface. Hand-written checks name the operation, the key and the reason.
 */

import { z } from 'zod';
import { SCENARIO_MODES } from '../types.js';

/** Directory under `.visual-diff/` holding scenario specs (mocking spec §5, Storage). */
export const SCENARIOS_DIRNAME = 'scenarios';

/**
 * A scenario name is the stem of its own filename and is echoed into `meta.json`, `findings.json`
 * and every CLI line, so it is held to the same shape as a flow name: no separators, no leading
 * dot, nothing that needs quoting.
 */
export const SAFE_SCENARIO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The complete rule vocabulary: `id`, `match`, the four response verbs, and the `delay` modifier. */
export const RULE_KEYS = ['id', 'match', 'patch', 'patchOps', 'respond', 'abort', 'delay'] as const;

/** The complete `match` vocabulary (mocking spec §5). */
export const MATCH_KEYS = ['method', 'url', 'nth'] as const;

/** The complete `respond` vocabulary (mocking spec §5). */
export const RESPOND_KEYS = ['status', 'headers', 'body'] as const;

/** The complete RFC 6902 operation vocabulary; which of them apply depends on `op`. */
export const PATCH_OP_KEYS = ['op', 'path', 'value', 'from'] as const;

/** The top-level scenario vocabulary. */
export const SCENARIO_KEYS = ['version', 'scenario', 'description', 'mode', 'rules'] as const;

const zMatch = z
  .object({
    method: z.string().optional(),
    // Emptiness and glob syntax are checked in validate.ts, which can explain both.
    url: z.string(),
    // Range and integrality are checked in validate.ts: "nth below 1" deserves its own sentence.
    nth: z.number().optional(),
  })
  .strict();

const zRespond = z
  .object({
    // 100–599 is checked in validate.ts so the message can say what the range means.
    status: z.number(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown(),
  })
  .strict();

const zRule = z
  .object({
    id: z.string(),
    match: zMatch,
    patch: z.unknown(),
    patchOps: z.array(z.unknown()).optional(),
    respond: zRespond.optional(),
    abort: z.literal(true).optional(),
    delay: z.number().optional(),
  })
  .strict();

export const scenarioSpecSchema = z
  .object({
    version: z.literal(1),
    scenario: z.string(),
    description: z.string().optional(),
    mode: z.enum(SCENARIO_MODES).optional(),
    rules: z.array(zRule).min(1),
  })
  .strict();

/** The schema's output: shape-valid, semantics not yet checked and defaults not yet applied. */
export type ScenarioSpecInput = z.infer<typeof scenarioSpecSchema>;
export type ScenarioRuleInput = ScenarioSpecInput['rules'][number];
export type RespondInput = NonNullable<ScenarioRuleInput['respond']>;

/**
 * Own-property test. `patch` and `respond.body` are `unknown`, so their *presence* is what carries
 * meaning — `patch: ~` is a merge patch of null (and rejected as such), not an absent verb.
 */
export function hasKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
