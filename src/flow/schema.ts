/**
 * zod schema for flow YAML v1 (spec §6, D8).
 *
 * The step object is `.strict()`, so the closed vocabulary is enforced structurally: any key outside
 * `id` plus `STEP_VERBS` surfaces as an `unrecognized_keys` issue, which `parse.ts` turns into
 * `unknown-verb` or — for `sleep` and friends — `sleep-forbidden`.
 *
 * This file only describes *shape*. Semantic rules that need cross-field knowledge (id uniqueness,
 * viewport format, `har` required in replay) live in `validate.ts`.
 */

import { z } from 'zod';
import { FORBIDDEN_STEP_VERBS, STEP_VERBS } from '../types.js';

/** "1280x800" — both dimensions positive, no leading zeros. */
export const VIEWPORT_RE = /^[1-9]\d{0,4}x[1-9]\d{0,4}$/;

/**
 * Step ids and flow names become directory names in the run store (spec §6: "directory named by
 * step id"), so they are restricted to a filesystem-safe, non-relative shape.
 */
export const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `id` plus the closed verb list. */
export const STEP_KEYS: ReadonlySet<string> = new Set<string>(['id', ...STEP_VERBS]);

/** Keys refused by name rather than merely omitted (spec §6: there is no fixed sleep). */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set<string>(FORBIDDEN_STEP_VERBS);

const zExpectation = z
  .object({
    selector: z.string().min(1),
    visible: z.boolean().optional(),
    hidden: z.boolean().optional(),
    text: z.string().optional(),
    count: z.number().int().nonnegative().optional(),
  })
  .strict();

const zScroll = z
  .object({
    selector: z.string().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    to: z.enum(['top', 'bottom']).optional(),
  })
  .strict()
  .refine(
    (v) => v.selector !== undefined || v.x !== undefined || v.y !== undefined || v.to !== undefined,
    { message: 'scroll needs at least one of selector, x, y or to' },
  );

const zStep = z
  .object({
    id: z.string().min(1),
    goto: z.string().min(1).optional(),
    click: z.string().min(1).optional(),
    fill: z.record(z.string(), z.string()).optional(),
    press: z.string().min(1).optional(),
    hover: z.string().min(1).optional(),
    scroll: zScroll.optional(),
    waitFor: z.string().min(1).optional(),
    viewport: z.string().min(1).optional(),
    mask: z.array(z.string().min(1)).optional(),
    shoot: z.boolean().optional(),
    expect: z.array(zExpectation).min(1).optional(),
  })
  .strict();

const zNetwork = z
  .object({
    mode: z.enum(['record', 'replay', 'off']),
    har: z.string().min(1).optional(),
  })
  .strict();

export const flowSpecSchema = z
  .object({
    version: z.literal(1),
    flow: z.string().min(1),
    baseUrl: z.string().min(1).optional(),
    viewports: z.array(z.string().min(1)).min(1).optional(),
    network: zNetwork.optional(),
    steps: z.array(zStep).min(1),
  })
  .strict();

/** The schema's output: shape-valid, defaults not yet applied. */
export type FlowSpecInput = z.infer<typeof flowSpecSchema>;
