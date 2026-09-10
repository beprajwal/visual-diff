/**
 * `vdiff review` against the in-memory ports (CI spec D39).
 *
 * The provider call is faked at the port, so what is asserted here is the command's contract: the
 * key rule and its exit code, what is persisted and where, what `--json` carries, and that
 * `comment` and `export` pick the stored review up without being told to.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT, type DiffResult } from '../../types.js';
import type { ReviewRequest } from '../../ci/index.js';
import type { CommandContext } from '../command.js';
import { toCliError } from '../error.js';
import {
  createTestPorts,
  createTestStore,
  fakeDiffResult,
  fakeReview,
  fakeRunSummary,
} from '../testing.js';
import { comment } from './comment.js';
import { exportCommand } from './export.js';
import { review } from './review.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdiff-review-cmd-'));
  dirs.push(dir);
  return dir;
}

function diff(): DiffResult {
  return fakeDiffResult();
}

interface Harness {
  ctx: CommandContext;
  store: ReturnType<typeof createTestStore>;
  requests: ReviewRequest[];
}

function harness(
  env: Record<string, string | undefined>,
  options: { cwd?: string; result?: DiffResult } = {},
): Harness {
  const store = createTestStore({
    runs: { checkout: [fakeRunSummary({ runId: '0003' }), fakeRunSummary({ runId: '0007' })] },
    diffs: { 'checkout/0003..0007': options.result ?? diff() },
  });
  const requests: ReviewRequest[] = [];
  const ports = createTestPorts({ openStore: async () => store });
  const requestReview = ports.requestReview;
  ports.requestReview = async (request) => {
    requests.push(request);
    return requestReview(request);
  };
  return {
    ctx: {
      cwd: options.cwd ?? '/project',
      env,
      ports,
      version: '0.9.0',
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      waitForShutdown: async () => undefined,
    },
    store,
    requests,
  };
}

const invocation = { kind: 'review' as const, flow: 'checkout', e2e: false, json: false };

describe('vdiff review', () => {
  it('is a config error, exit 2, when no key is in the environment — and never calls out', async () => {
    const h = harness({});
    let thrown: unknown;
    try {
      await review(h.ctx, invocation);
    } catch (err) {
      thrown = err;
    }
    expect(toCliError(thrown)).toMatchObject({
      code: 'review-no-key',
      exitCode: EXIT.CONFIG_ERROR,
      hint: expect.stringContaining('ANTHROPIC_API_KEY'),
    });
    expect(h.requests).toEqual([]);
    expect(h.store.state.calls).toEqual([]);
  });

  it('reads the key, asks the provider once, and stores review.json beside findings.json', async () => {
    const h = harness({ ANTHROPIC_API_KEY: 'sk-ant-1' });
    const result = await review(h.ctx, invocation);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      root: '/project',
      provider: 'anthropic',
      model: 'claude-opus-5',
      auth: { kind: 'api-key', apiKey: 'sk-ant-1' },
    });
    expect(h.requests[0]?.context).toBeUndefined();
    expect(h.store.state.calls).toEqual(['invalidateReview checkout/0003..0007', 'writeReview checkout/0003..0007']);
    expect(h.store.state.reviews['checkout/0003..0007']?.provider).toBe('anthropic');

    expect(result.data.path).toBe('/project/.visual-diff/diffs/checkout/0003..0007/review.json');
    expect(result.data.out).toBeNull();
    expect(result.data.flagged).toBe(0);
    expect(result.data.contextProvided).toBe(false);
    // Human mode prints the same lines the comment will carry, then where the file went.
    expect(result.human[0]).toBe('#### Review');
    expect(result.human).toContain('review.json: /project/.visual-diff/diffs/checkout/0003..0007/review.json');
    expect(result.warnings?.join('\n')).toContain('no --context given');
  });

  it('honours --provider and --model, and reads --context from a file', async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, 'pr.md'), 'Rename the Pay button to "Pay now".\n', 'utf8');
    const h = harness({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, { cwd });
    const result = await review(h.ctx, {
      ...invocation,
      provider: 'openai',
      model: 'gpt-6-astra',
      context: 'pr.md',
      shots: 1,
      out: 'review-copy.json',
    });

    expect(h.requests[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-6-astra',
      auth: { kind: 'api-key', apiKey: 'o' },
      shots: 1,
      context: 'Rename the Pay button to "Pay now".\n',
    });
    expect(result.data.contextProvided).toBe(true);
    expect(result.data.out).toBe(join(cwd, 'review-copy.json'));
    const copy = JSON.parse(await readFile(join(cwd, 'review-copy.json'), 'utf8')) as { provider: string };
    expect(copy.provider).toBe('openai');
    expect(result.warnings?.join('\n')).not.toContain('no --context given');
  });

  it('fails as a config error when the --context file cannot be read', async () => {
    const h = harness({ ANTHROPIC_API_KEY: 'a' }, { cwd: await tempDir() });
    await expect(review(h.ctx, { ...invocation, context: 'missing.md' })).rejects.toMatchObject({
      code: 'review-context-unreadable',
      exitCode: EXIT.CONFIG_ERROR,
    });
    expect(h.requests).toEqual([]);
  });

  it('warns on flagged changes and lets a provider failure surface as exit 1', async () => {
    const h = harness({ ANTHROPIC_API_KEY: 'a' });
    h.ctx.ports.requestReview = async (request) => ({
      review: fakeReview({
        flow: request.result.flow,
        changes: [
          { step: 'cart', viewport: null, description: 'Total wraps.', assessment: 'unrelated' },
        ],
      }),
      usage: { inputTokens: null, outputTokens: null },
      images: 0,
    });
    const result = await review(h.ctx, { ...invocation, shots: 2 });
    expect(result.data.flagged).toBe(1);
    expect(result.warnings?.join('\n')).toContain('1 change flagged');
    expect(result.warnings?.join('\n')).toContain('no screenshots were on disk');

    h.ctx.ports.requestReview = async () => {
      throw Object.assign(new Error('anthropic API answered 401'), {
        code: 'review-rejected',
        exitCode: EXIT.RUN_FAILURE,
      });
    };
    let thrown: unknown;
    try {
      await review(h.ctx, invocation);
    } catch (err) {
      thrown = err;
    }
    expect(toCliError(thrown)).toMatchObject({ code: 'review-rejected', exitCode: EXIT.RUN_FAILURE });
  });
});

describe('comment and export pick up a stored review', () => {
  it('discards the previous review when a fresh provider attempt fails', async () => {
    const h = harness({ ANTHROPIC_API_KEY: 'a' });
    await review(h.ctx, invocation);
    h.ctx.ports.requestReview = async () => { throw new Error('provider unavailable'); };
    await expect(review(h.ctx, invocation)).rejects.toThrow('provider unavailable');
    expect(await h.store.readReview({ flow: 'checkout', base: '0003', head: '0007' })).toBeNull();
    const after = await comment(h.ctx, {
      kind: 'comment', flow: 'checkout', e2e: false, failOn: 'none', json: false,
    });
    expect(after.data.markdown).not.toContain('#### Review');
  });

  it('render the review without a flag once vdiff review has run, and not before', async () => {
    const h = harness({ ANTHROPIC_API_KEY: 'a' });
    const commentInvocation = {
      kind: 'comment' as const,
      flow: 'checkout',
      e2e: false,
      failOn: 'none' as const,
      json: false,
    };

    const before = await comment(h.ctx, commentInvocation);
    expect(before.data.markdown).not.toContain('#### Review');

    await review(h.ctx, invocation);

    const after = await comment(h.ctx, commentInvocation);
    expect(after.data.markdown).toContain('#### Review');
    expect(after.data.markdown).toContain('Review by claude-opus-5 (Anthropic)');
  });

  it('ignores a review written for another engine version', async () => {
    const h = harness({ ANTHROPIC_API_KEY: 'a' });
    h.store.state.reviews['checkout/0003..0007'] = fakeReview({ engineVersion: 'ancient' });
    const result = await comment(h.ctx, {
      kind: 'comment',
      flow: 'checkout',
      e2e: false,
      failOn: 'none',
      json: false,
    });
    expect(result.data.markdown).not.toContain('#### Review');
  });

  it('export writes review.json into the bundle when one is stored', async () => {
    const out = await tempDir();
    const h = harness({ ANTHROPIC_API_KEY: 'a' });
    await review(h.ctx, invocation);
    const result = await exportCommand(h.ctx, {
      kind: 'export',
      flow: 'checkout',
      e2e: false,
      images: 'none',
      html: 'linked',
      preview: false,
      failOn: 'none',
      out,
      json: false,
    });
    expect(result.data.files).toContain('review.json');
    expect(await readFile(join(out, 'comment.md'), 'utf8')).toContain('#### Review');
  });
});
