/**
 * `POST /api/feedback` (spec §9, D6).
 *
 * The page never executes anything. This endpoint validates a comment and appends one JSON line to
 * `.visual-diff/feedback/pending.jsonl`; an agent later reads it with `vdiff feedback --json
 * --ack`. There is no other effect, and by construction no other effect can be added here without
 * breaking the D6 constraint the whole two-way design rests on.
 *
 * The server owns `id`, `ts`, `status` and the derived `crop` path — the client cannot forge them.
 */

import type { IncomingMessage } from 'node:http';
import { z } from 'zod';

import type { FeedbackEntry } from '../../types.js';
import type { FeedbackDraft, ReportStore } from './deps.js';
import { HttpError, readBody } from './http.js';

const PAIR = /^[0-9]{4,}\.\.[0-9]{4,}$/;
const VIEWPORT = /^[0-9]{1,5}x[0-9]{1,5}$/;
const FLOW = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINDING_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const rectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().nonnegative(),
    h: z.number().finite().nonnegative(),
  })
  .strict();

/** Mirrors `FeedbackInput` in src/types.ts. Unknown keys are rejected, not ignored. */
export const feedbackInputSchema = z
  .object({
    flow: z.string().regex(FLOW),
    pair: z.string().regex(PAIR),
    step: z.string().regex(STEP_ID).optional(),
    viewport: z.string().regex(VIEWPORT).optional(),
    findingId: z.string().regex(FINDING_ID).optional(),
    element: z.string().min(1).max(1000).optional(),
    region: rectSchema.optional(),
    text: z.string().min(1).max(8000),
  })
  .strict();

export type ValidatedFeedbackInput = z.infer<typeof feedbackInputSchema>;

export function parseFeedbackInput(raw: unknown): ValidatedFeedbackInput {
  const parsed = feedbackInputSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    const why = first ? first.message : 'invalid body';
    throw new HttpError(400, 'bad-feedback', `Rejected feedback${where}: ${why}.`);
  }
  return parsed.data;
}

/** Crop written by the diff engine for this finding, when one exists (spec §9). */
export async function deriveCropPath(
  store: ReportStore,
  input: ValidatedFeedbackInput,
): Promise<string | undefined> {
  if (!input.findingId) return undefined;
  const relative = `diffs/${input.flow}/${input.pair}/crops/${input.findingId}.png`;
  const resolved = await store.resolveBlob(relative);
  return resolved ? relative : undefined;
}

export function buildFeedbackDraft(
  input: ValidatedFeedbackInput,
  now: Date,
  crop: string | undefined,
): FeedbackDraft {
  // Key order matches the documented shape in spec §9; JSON.stringify drops the undefined ones.
  return {
    ts: now.toISOString(),
    flow: input.flow,
    pair: input.pair,
    step: input.step,
    viewport: input.viewport,
    findingId: input.findingId,
    element: input.element,
    region: input.region,
    crop,
    text: input.text,
    status: 'pending',
  };
}

export interface FeedbackApiOptions {
  store: ReportStore;
  now?: () => Date;
}

/** Read, validate, append. The returned entry is what landed on disk, verbatim. */
export async function handleFeedbackRequest(
  req: IncomingMessage,
  options: FeedbackApiOptions,
): Promise<FeedbackEntry> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'bad-content-type', 'Feedback must be sent as application/json.');
  }

  const body = await readBody(req);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new HttpError(400, 'bad-json', 'Request body is not valid JSON.');
  }

  const input = parseFeedbackInput(raw);
  const crop = await deriveCropPath(options.store, input);
  const draft = buildFeedbackDraft(input, options.now ? options.now() : new Date(), crop);
  return options.store.appendFeedback(draft);
}
