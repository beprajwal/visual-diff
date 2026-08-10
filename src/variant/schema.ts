/**
 * zod schema for variant YAML v1 (variants spec §4).
 *
 * Shape only, exactly as `flow/schema.ts` and `scenario/schema.ts` are. Every object is
 * `.strict()`, so the closed rule vocabulary (D21) is enforced structurally and `parse.ts` can turn
 * `unrecognized_keys` into an `unknown-key` issue naming the offending key — the "no HTML injection
 * verb, ever" guarantee of §2 is, at this level, simply the fact that `html` is not in `RULE_KEYS`
 * and `.strict()` refuses it.
 *
 * Three shapes are deliberately left as `unknown` here — `style`, `order` and `clone.position` —
 * and are checked in `validate.ts` instead, for the reason the scenario layer leaves `patch` open:
 * zod would reject them accurately and describe them badly. `order: { before: a, after: b }`
 * failing a union reports "Invalid input" at the root of the value, while §7 wants the message to
 * say which two keys collided and why only one is allowed.
 */

import { z } from 'zod';

/** Directory under `.visual-diff/` holding variant specs (variants spec §4, Storage). */
export const VARIANTS_DIRNAME = 'variants';

/**
 * A variant name is the stem of its own filename and is echoed into `meta.json`, the CLI and the
 * report, so it is held to the same shape a flow or scenario name is: no separators, no leading
 * dot, nothing that needs quoting.
 */
export const SAFE_VARIANT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Clone source steps name a step of the flow being run (D23), and step ids are filesystem-safe by
 * `flow/schema.ts`. Restated rather than imported so the variant layer stays as dependency-light as
 * the scenario layer, which restates `.visual-diff` for the same reason.
 */
export const SAFE_STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The complete rule vocabulary: `id`, `match`, and the five verbs (D21). */
export const RULE_KEYS = ['id', 'match', 'style', 'text', 'hide', 'order', 'clone'] as const;

/** The complete `clone` vocabulary (variants spec §4). */
export const CLONE_KEYS = ['from', 'into', 'position', 'times'] as const;

/** The complete `clone.from` vocabulary — `step` and `url` are alternatives (D23). */
export const CLONE_FROM_KEYS = ['step', 'url', 'match'] as const;

/** The top-level variant vocabulary. */
export const VARIANT_KEYS = ['version', 'variant', 'description', 'rules'] as const;

/** `order: first | last`. */
export const ORDER_KEYWORDS = ['first', 'last'] as const;

/** `clone.position: prepend | append`. */
export const POSITION_KEYWORDS = ['prepend', 'append'] as const;

/** The two keys of a selector-relative placement, in `order` and in `clone.position`. */
export const RELATIVE_KEYS = ['before', 'after'] as const;

const zCloneFrom = z
  .object({
    // Exactly one of step/url, and the shape of each, are checked in validate.ts: "neither" and
    // "both" are different mistakes and deserve different sentences (§7).
    step: z.string().optional(),
    url: z.string().optional(),
    match: z.string(),
  })
  .strict();

const zClone = z
  .object({
    from: zCloneFrom,
    into: z.string(),
    // Left open on purpose: prepend | append | { before: … } | { after: … } (see the file comment).
    position: z.unknown(),
    // Range and integrality are checked in validate.ts, which can say what `times` counts.
    times: z.number().optional(),
  })
  .strict();

const zRule = z
  .object({
    id: z.string(),
    // Required for the four in-place verbs and refused on `clone`, both in validate.ts: which one
    // applies depends on the verb, and zod can only say "missing".
    match: z.string().optional(),
    style: z.unknown(),
    text: z.string().optional(),
    hide: z.literal(true).optional(),
    order: z.unknown(),
    clone: zClone.optional(),
  })
  .strict();

export const variantSpecSchema = z
  .object({
    version: z.literal(1),
    variant: z.string(),
    description: z.string().optional(),
    rules: z.array(zRule).min(1),
  })
  .strict();

/** The schema's output: shape-valid, semantics not yet checked and defaults not yet applied. */
export type VariantSpecInput = z.infer<typeof variantSpecSchema>;
export type VariantRuleInput = VariantSpecInput['rules'][number];
export type CloneInput = NonNullable<VariantRuleInput['clone']>;

/**
 * Own-property test. `style` and `order` are `unknown`, so their *presence* is what carries
 * meaning — `style:` with nothing after it is an empty style verb (and rejected as one), not an
 * absent verb, and must not be mistaken for a rule that never mentioned `style` at all.
 */
export function hasKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
