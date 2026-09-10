/**
 * `vdiff review <flow> [base] [head]` — a hosted model reads the stored diff and writes the review
 * an agent would have (CI spec D39).
 *
 * Step 4 of the loop — "summarize the findings; call out anything you did not intend" — is the
 * agent's job when an agent is driving. In CI nobody is, so this command hands the same evidence
 * (findings, screenshots, and the pull request's own description when `--context` names it) to
 * the model whose API key the environment holds, and stores what comes back beside `findings.json`.
 * `vdiff comment` and `vdiff export` then carry it without being told to.
 *
 * Three behaviours are decisions rather than details:
 *
 *  1. **The provider is whichever key is present.** `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; both
 *     set, Anthropic unless `--provider openai`. No key is a config error (exit 2) naming both
 *     variables — a job that meant to review and could not should say so, not go quiet.
 *  2. **A provider failure is exit 1, not 2.** An unreachable API or a rejected key is a run failure
 *     in the same sense a dead dev server is; the spec was fine. The action treats it as
 *     non-fatal: the comment then simply carries no review.
 *  3. **It never gates.** The review is advisory and says who wrote it. `--fail-on` on `comment`
 *     remains the only thing that can turn the check red (D30).
 */

import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { EXIT } from '../../types.js';
import type { Invocation } from '../args.js';
import { flaggedChanges, resolveReviewProvider, reviewLines } from '../ci.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { ReviewRequest } from '../../ci/index.js';
import { configError } from '../error.js';
import type { ReviewData } from '../shapes.js';
import { resolveDiff } from './pair.js';

type ReviewInvocation = Extract<Invocation, { kind: 'review' }>;

/**
 * The environment, read in exactly one place. Injected through the context when a test supplies
 * one, so no command test ever depends on the keys of the machine running it.
 */
function environment(ctx: CommandContext): Readonly<Record<string, string | undefined>> {
  return ctx.env ?? process.env;
}

export async function review(
  ctx: CommandContext,
  invocation: ReviewInvocation,
): Promise<CommandResult<ReviewData>> {
  // Resolve the provider before touching the store: a missing key is the most likely mistake and
  // the cheapest one to report.
  const resolved = resolveReviewProvider(environment(ctx), {
    ...(invocation.provider === undefined ? {} : { provider: invocation.provider }),
    ...(invocation.model === undefined ? {} : { model: invocation.model }),
  });
  if (!resolved.ok) {
    throw configError('review-no-key', resolved.message, { hint: resolved.hint });
  }
  const credentials = resolved.value;

  const { config, pair, result } = await resolveDiff(ctx, invocation);

  const warnings: string[] = [];
  let context: string | undefined;
  if (invocation.context !== undefined) {
    const file = path.resolve(ctx.cwd, invocation.context);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (cause) {
      throw configError('review-context-unreadable', `could not read --context file ${file}`, {
        hint: 'pass a file holding the pull request title and body, or drop --context',
        cause,
      });
    }
    if (text.trim().length === 0) {
      warnings.push(`--context file ${file} is empty; the review judges appearance alone`);
    } else {
      context = text;
    }
  } else {
    warnings.push(
      'no --context given: the model cannot tell an intended change from an unrelated one and ' +
        'will mark what it cannot place as unclear; pass the pull request description to sharpen it',
    );
  }

  const request: ReviewRequest = {
    root: config.root,
    result,
    provider: credentials.provider,
    model: credentials.model,
    auth: credentials.auth,
    generatedAt: new Date().toISOString(),
  };
  if (credentials.baseUrl !== undefined) request.baseUrl = credentials.baseUrl;
  if (context !== undefined) request.context = context;
  if (invocation.shots !== undefined) request.shots = invocation.shots;

  const store = await ctx.ports.openStore(config);
  await store.invalidateReview(pair);
  const response = await ctx.ports.requestReview(request);

  const stored = await store.writeReview(pair, response.review);

  let out: string | null = null;
  if (invocation.out !== undefined) {
    out = path.resolve(ctx.cwd, invocation.out);
    await writeFile(out, `${JSON.stringify(response.review, null, 2)}\n`, 'utf8');
  }

  const flagged = flaggedChanges(response.review).length;
  if (flagged > 0) {
    warnings.push(
      `${flagged} change${flagged === 1 ? '' : 's'} flagged as unrelated to the described change ` +
        'or as a regression — see the review',
    );
  }
  if (response.images === 0 && (invocation.shots ?? 1) > 0) {
    warnings.push('no screenshots were on disk for the changed steps; the review read findings.json only');
  }

  const usage = response.usage;
  const human: string[] = [
    ...reviewLines(response.review),
    '',
    `review.json: ${stored}`,
    `model ${credentials.model} (${credentials.provider}) · ${response.images} image(s) sent` +
      (usage.inputTokens !== null && usage.outputTokens !== null
        ? ` · ${usage.inputTokens} in / ${usage.outputTokens} out tokens`
        : ''),
  ];
  if (out !== null) human.push(`copy: ${out}`);

  const data: ReviewData = {
    flow: pair.flow,
    pair,
    review: response.review,
    path: stored,
    out,
    provider: credentials.provider,
    model: credentials.model,
    images: response.images,
    usage,
    contextProvided: context !== undefined,
    flagged,
    result,
  };

  return { data, human, warnings, exitCode: EXIT.OK };
}
