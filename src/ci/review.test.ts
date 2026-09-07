/**
 * The model-written review (CI spec D39): provider resolution, what the model is shown, what is
 * accepted back, and the exact request each provider receives — driven through an injected `fetch`,
 * so nothing here opens a socket.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DiffResult, Review } from '../types.js';
import {
  makeDiff,
  makeFinding,
  makeStepDiff,
  makeSummary,
  makeViewportDiff,
} from '../report/ui/test-fixtures.js';
import { TINY_PNG } from '../store/fixtures.js';
import { fakeReview } from '../cli/testing.js';
import {
  DEFAULT_REVIEW_MODEL,
  REVIEW_KEY_ENV,
  resolveReviewProvider,
} from './review-provider.js';
import { flaggedChanges, reviewAttribution, reviewLines } from './review-render.js';
import {
  REVIEW_SCHEMA,
  ReviewError,
  collectEvidence,
  describeDiff,
  parseReviewBody,
  rankCells,
  requestReview,
  userPrompt,
  type ReviewRequest,
} from './review.js';

const PIXEL_PATH = 'diffs/checkout/0003..0007/steps/pay-form/1280x800/pixel.png';
const CROP_PATH = 'diffs/checkout/0003..0007/crops/f1.png';

function fixtureDiff(): DiffResult {
  return makeDiff({
    steps: [
      makeStepDiff('cart', 'matched', {
        viewports: {
          '1280x800': makeViewportDiff('1280x800', { pixelChangedRatio: 0.2 }),
        },
      }),
      makeStepDiff('pay-form', 'matched', {
        viewports: {
          '1280x800': makeViewportDiff('1280x800', {
            pixelChangedRatio: 0.03,
            findings: [makeFinding('f1', { severity: 'high', crop: CROP_PATH })],
            pixelPath: PIXEL_PATH,
          }),
          '390x844': makeViewportDiff('390x844'),
        },
      }),
    ],
    summary: makeSummary({
      totalFindings: 1,
      bySeverity: { high: 1, med: 0, low: 0 },
      stepsCompared: 2,
      stepsChanged: 2,
      maxPixelChangedRatio: 0.2,
    }),
  });
}

async function seedStore(root: string): Promise<void> {
  const png = Buffer.from(TINY_PNG);
  for (const runId of ['0003', '0007']) {
    const dir = join(root, '.visual-diff', 'runs', 'checkout', runId, 'steps', 'pay-form', '1280x800');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'screenshot.png'), png);
  }
  await mkdir(join(root, '.visual-diff', 'diffs', 'checkout', '0003..0007', 'steps', 'pay-form', '1280x800'), {
    recursive: true,
  });
  await writeFile(join(root, '.visual-diff', PIXEL_PATH), png);
  await mkdir(join(root, '.visual-diff', 'diffs', 'checkout', '0003..0007', 'crops'), { recursive: true });
  await writeFile(join(root, '.visual-diff', CROP_PATH), png);
}

const BODY = {
  headline: 'The Pay button grew and the cart total wraps.',
  summary: 'Two steps moved. The button change matches the description; the cart wrap does not.',
  changes: [
    { step: 'pay-form', viewport: '1280x800', description: 'Button is wider.', assessment: 'expected' },
    { step: 'cart', viewport: null, description: 'Total wraps onto two lines.', assessment: 'unrelated' },
    { step: 'ghost', viewport: null, description: 'Invented.', assessment: 'regression' },
    { step: 'pay-form', viewport: '4000x1', description: 'Made-up viewport.', assessment: 'unclear' },
  ],
  concerns: ['The cart total wrapping is not mentioned in the pull request.'],
};

/** A `fetch` that records the one request it receives and answers with a canned body. */
function fakeFetch(answer: unknown, status = 200): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(answer), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('resolveReviewProvider', () => {
  it('picks the provider whose key is present, Anthropic first when both are', () => {
    expect(resolveReviewProvider({ OPENAI_API_KEY: 'sk-o' })).toMatchObject({
      ok: true,
      value: { provider: 'openai', model: DEFAULT_REVIEW_MODEL.openai, apiKey: 'sk-o' },
    });
    expect(resolveReviewProvider({ ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' })).toMatchObject({
      ok: true,
      value: { provider: 'anthropic', model: DEFAULT_REVIEW_MODEL.anthropic, apiKey: 'sk-a' },
    });
    expect(
      resolveReviewProvider({ ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' }, { provider: 'openai' }),
    ).toMatchObject({ ok: true, value: { provider: 'openai' } });
  });

  it('treats an empty string as no key — a workflow passes "" for an input nobody set', () => {
    const outcome = resolveReviewProvider({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '  ' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain('no model API key');
      expect(outcome.hint).toContain(REVIEW_KEY_ENV.anthropic);
      expect(outcome.hint).toContain(REVIEW_KEY_ENV.openai);
    }
  });

  it('refuses a forced provider whose key is missing rather than silently switching', () => {
    const outcome = resolveReviewProvider({ ANTHROPIC_API_KEY: 'sk-a' }, { provider: 'openai' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('OPENAI_API_KEY is not set');
  });

  it('honours a named model and a base URL override', () => {
    const outcome = resolveReviewProvider(
      { ANTHROPIC_API_KEY: 'sk-a', ANTHROPIC_BASE_URL: 'https://gateway.test/anthropic/' },
      { model: 'claude-sonnet-5' },
    );
    expect(outcome).toMatchObject({
      ok: true,
      value: { model: 'claude-sonnet-5', baseUrl: 'https://gateway.test/anthropic' },
    });
  });
});

describe('what the model is shown', () => {
  it('ranks changed cells by worst finding, then by pixel movement', () => {
    const ranked = rankCells(fixtureDiff()).map((cell) => `${cell.step}@${cell.viewport}`);
    // cart moved 20% of its pixels but has no finding; pay-form has a high one.
    expect(ranked).toEqual(['pay-form@1280x800', 'cart@1280x800']);
  });

  it('describes the diff without paths or environments, and states what it omitted', () => {
    const text = describeDiff(fixtureDiff(), []);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['flow']).toBe('checkout');
    expect(text).not.toContain('pixelPath');
    expect(text).not.toContain('sha-0003');
    expect(text).not.toContain('findingsOmittedFromThisPrompt');

    const many = makeDiff({
      steps: [
        makeStepDiff('pay-form', 'matched', {
          viewports: {
            '1280x800': makeViewportDiff('1280x800', {
              findings: Array.from({ length: 70 }, (_, i) => makeFinding(`f${i}`)),
            }),
          },
        }),
      ],
    });
    expect(JSON.parse(describeDiff(many, []))).toMatchObject({ findingsOmittedFromThisPrompt: 10 });
  });

  it('reads base, head, pixel and crop images for the top cells and labels every one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vdiff-review-'));
    try {
      await seedStore(root);
      const evidence = await collectEvidence(root, fixtureDiff(), 3);
      // cart has nothing on disk in this fixture; pay-form has all four.
      expect(evidence.cells.map((cell) => cell.step)).toEqual(['pay-form', 'cart']);
      expect(evidence.images.map((image) => image.label)).toEqual([
        'step `pay-form` at 1280x800 — BASE (before the change)',
        'step `pay-form` at 1280x800 — HEAD (after the change)',
        'step `pay-form` at 1280x800 — PIXEL DIFF (changed regions highlighted on the head capture)',
        'step `pay-form` at 1280x800 — CROP of finding f1 (text changed) on the head capture',
      ]);
      expect((await collectEvidence(root, fixtureDiff(), 0)).images).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tells the model when there is no description, and quotes it when there is', () => {
    const request = { root: '/p', result: fixtureDiff(), provider: 'anthropic', model: 'm', apiKey: 'k' } as const;
    const bare = userPrompt(request, { cells: [], images: [] });
    expect(bare).toContain('No description of the intended change was provided');
    expect(bare).toContain('No screenshots are attached');
    const described = userPrompt({ ...request, context: 'Rename Pay to Pay now' }, { cells: [], images: [] });
    expect(described).toContain('The pull request describes the change as:');
    expect(described).toContain('Rename Pay to Pay now');
  });
});

describe('what is accepted back', () => {
  it('parses the body and drops changes that name steps or viewports the diff does not have', () => {
    const body = parseReviewBody(JSON.stringify(BODY), fixtureDiff());
    expect(body.changes.map((change) => `${change.step}/${change.viewport}`)).toEqual([
      'pay-form/1280x800',
      'cart/null',
      // A viewport the step does not have is not invented: the change survives without it.
      'pay-form/null',
    ]);
    expect(body.concerns).toHaveLength(1);
  });

  it('fails loudly on non-JSON and on JSON of the wrong shape', () => {
    expect(() => parseReviewBody('Sure! Here is my review…', fixtureDiff())).toThrowError(ReviewError);
    expect(() => parseReviewBody('{"headline": 1}', fixtureDiff())).toThrowError(/does not match/);
  });

  it('keeps the schema strict-mode friendly: every property required, nothing extra allowed', () => {
    expect(REVIEW_SCHEMA.required).toEqual(['headline', 'summary', 'changes', 'concerns']);
    expect(REVIEW_SCHEMA.additionalProperties).toBe(false);
    expect(REVIEW_SCHEMA.properties.changes.items.required).toEqual([
      'step',
      'viewport',
      'description',
      'assessment',
    ]);
  });
});

describe('requestReview', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vdiff-review-'));
    await seedStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
    return {
      root,
      result: fixtureDiff(),
      provider: 'anthropic',
      model: 'claude-opus-5',
      apiKey: 'sk-ant-test',
      generatedAt: '2026-09-07T10:00:00.000Z',
      ...overrides,
    };
  }

  it('sends the Anthropic Messages API a structured-output request with the images inline', async () => {
    const { fetch, calls } = fakeFetch({
      content: [{ type: 'text', text: JSON.stringify(BODY) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4321, output_tokens: 210 },
    });
    const response = await requestReview(request({ fetch, context: 'Rename Pay to Pay now' }));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = bodyOf(call);
    expect(body['model']).toBe('claude-opus-5');
    expect(body['output_config']).toEqual({ format: { type: 'json_schema', schema: REVIEW_SCHEMA } });
    const messages = body['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages).toHaveLength(1);
    const content = messages[0]!.content;
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(String(content[0]!['text'])).toContain('Rename Pay to Pay now');
    const images = content.filter((block) => block['type'] === 'image');
    expect(images).toHaveLength(4);
    expect(images[0]).toMatchObject({ source: { type: 'base64', media_type: 'image/png' } });
    // Every image is preceded by its label.
    expect(content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('BASE (before the change)') });

    expect(response.images).toBe(4);
    expect(response.usage).toEqual({ inputTokens: 4321, outputTokens: 210 });
    expect(response.review).toMatchObject({
      flow: 'checkout',
      pair: { base: '0003', head: '0007' },
      provider: 'anthropic',
      model: 'claude-opus-5',
      generatedAt: '2026-09-07T10:00:00.000Z',
      headline: BODY.headline,
      evidence: { cells: 2, images: 4, contextProvided: true },
    });
    expect(response.review.changes).toHaveLength(3);
  });

  it('sends the OpenAI Responses API a strict json_schema request with data-URI images', async () => {
    const { fetch, calls } = fakeFetch({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(BODY) }] }],
      usage: { input_tokens: 999, output_tokens: 100 },
    });
    const response = await requestReview(
      request({ fetch, provider: 'openai', model: 'gpt-6-astra', apiKey: 'sk-oai', shots: 1 }),
    );

    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    expect((call.init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-oai');
    const body = bodyOf(call);
    expect(body['model']).toBe('gpt-6-astra');
    expect(body['text']).toEqual({
      format: { type: 'json_schema', name: 'visual_diff_review', schema: REVIEW_SCHEMA, strict: true },
    });
    const input = body['input'] as Array<{ content: Array<Record<string, unknown>> }>;
    const images = input[0]!.content.filter((block) => block['type'] === 'input_image');
    // One cell asked for: pay-form's base, head, pixel and crop.
    expect(images).toHaveLength(4);
    expect(String(images[0]!['image_url'])).toMatch(/^data:image\/png;base64,/);
    expect(response.review.provider).toBe('openai');
    expect(response.review.evidence).toEqual({ cells: 1, images: 4, contextProvided: false });
  });

  it('honours a base URL override and sends no images under shots 0', async () => {
    const { fetch, calls } = fakeFetch({
      content: [{ type: 'text', text: JSON.stringify(BODY) }],
      stop_reason: 'end_turn',
    });
    const response = await requestReview(request({ fetch, baseUrl: 'https://gw.test/anthropic', shots: 0 }));
    expect(calls[0]!.url).toBe('https://gw.test/anthropic/v1/messages');
    expect(response.images).toBe(0);
    expect(response.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('turns a rejected key, a refusal and a truncated answer into run failures, never spec errors', async () => {
    const rejected = fakeFetch({ error: { message: 'invalid x-api-key' } }, 401);
    await expect(requestReview(request({ fetch: rejected.fetch }))).rejects.toMatchObject({
      code: 'review-rejected',
      exitCode: 1,
      hint: expect.stringContaining('API key was rejected'),
    });

    const refused = fakeFetch({ content: [], stop_reason: 'refusal', stop_details: { explanation: 'nope' } });
    await expect(requestReview(request({ fetch: refused.fetch }))).rejects.toMatchObject({
      code: 'review-refused',
      message: expect.stringContaining('nope'),
    });

    const incomplete = fakeFetch({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"head' }] }],
    });
    await expect(
      requestReview(request({ fetch: incomplete.fetch, provider: 'openai', apiKey: 'k' })),
    ).rejects.toMatchObject({ code: 'review-truncated' });

    const unreachable = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(requestReview(request({ fetch: unreachable }))).rejects.toMatchObject({
      code: 'review-unreachable',
      exitCode: 1,
    });
  });
});

describe('rendering', () => {
  it('flags unrelated and regression changes and leads with the headline', () => {
    const review: Review = fakeReview({
      headline: 'The cart total wraps onto two lines.',
      changes: [
        { step: 'cart', viewport: null, description: 'Total wraps.', assessment: 'unrelated' },
        { step: 'pay-form', viewport: '1280x800', description: 'Button wider.', assessment: 'expected' },
        { step: 'pay-form', viewport: null, description: 'Focus ring gone.', assessment: 'regression' },
      ],
      concerns: ['Focus ring loss is an accessibility regression.'],
    });
    expect(flaggedChanges(review)).toHaveLength(2);
    const lines = reviewLines(review);
    expect(lines[0]).toBe('#### Review');
    expect(lines[2]).toBe('**The cart total wraps onto two lines.**');
    expect(lines.join('\n')).toContain('**2 changes are not accounted for by this pull request or look like a regression**');
    expect(lines.join('\n')).toContain('- ⚠️ `cart` — Total wraps. _(not accounted for by this change)_');
    expect(lines.join('\n')).toContain('- 🔴 `pay-form` — Focus ring gone. _(looks like a regression)_');
    expect(lines[lines.length - 1]).toBe(`<sub>${reviewAttribution(review)}</sub>`);
  });

  it('caps the lists and counts what it dropped', () => {
    const review = fakeReview({
      changes: Array.from({ length: 15 }, (_, i) => ({
        step: 'pay-form',
        viewport: null,
        description: `Change ${i}`,
        assessment: 'expected' as const,
      })),
      concerns: Array.from({ length: 8 }, (_, i) => `Concern ${i}`),
    });
    const text = reviewLines(review).join('\n');
    expect(text).toContain('- … 3 more changes in `review.json`');
    expect(text).toContain('- … 2 more in `review.json`');
  });

  it('says what the model saw, and whether it had the description', () => {
    expect(reviewAttribution(fakeReview())).toBe(
      'Review by claude-opus-5 (Anthropic) from findings.json and 3 screenshots, without a ' +
        'description of the intended change. It is a reading of the evidence, not a verdict.',
    );
    expect(
      reviewAttribution(fakeReview({ provider: 'openai', model: 'gpt-6-astra', evidence: { cells: 0, images: 0, contextProvided: true } })),
    ).toContain('(OpenAI) from findings.json only, no screenshots, with the pull request description');
  });
});
