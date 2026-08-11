/**
 * `vdiff comment <flow> [base] [head]` — render a stored diff as pull-request markdown
 * (CI spec §6, §7).
 *
 * Three behaviours are decisions rather than details:
 *
 *  1. **It posts nothing.** The markdown goes to stdout, or to `--out`, or into the `--json`
 *     envelope. No token reaches this command and no socket is opened (D29); a workflow hands the
 *     file to the API step that already holds the credential.
 *  2. **No `--image-base`, no images.** GitHub cannot render a picture out of a workflow artifact, so
 *     without a publish target the comment carries numbers, tables and links (D31). An `<img>` whose
 *     URL 404s would be worse than the sentence saying where the pictures are.
 *  3. **`--fail-on` exits 3.** Not 1, which everywhere else in this CLI means the run or replay
 *     failed (D30); and not 0, because a gate that only prints is not a gate. `none` is the default,
 *     so the check stays green on a changed UI until a repository decides otherwise.
 */

import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { EXIT } from '../../types.js';
import type { Invocation } from '../args.js';
import { evaluateGate } from '../ci.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { CommentInput } from '../../ci/index.js';
import { percent } from '../output.js';
import { composePairNotices, pairLabels } from '../pair-notices.js';
import type { CommentData } from '../shapes.js';
import { reproCommands, resolveDiff } from './pair.js';

type CommentInvocation = Extract<Invocation, { kind: 'comment' }>;

export async function comment(
  ctx: CommandContext,
  invocation: CommentInvocation,
): Promise<CommandResult<CommentData>> {
  const { pair, result } = await resolveDiff(ctx, invocation);

  const composed = composePairNotices(result);
  const notices = [
    ...composed.notices.map((notice) => notice.sentence),
    ...composed.degraded,
  ];
  const gate = evaluateGate(result.summary, invocation.failOn);

  const input: CommentInput = {
    result,
    notices,
    gate,
    version: ctx.version,
    repro: reproCommands(pair),
  };
  if (invocation.imageBase !== undefined) input.imageBase = invocation.imageBase;
  if (invocation.artifactUrl !== undefined) input.artifactUrl = invocation.artifactUrl;
  if (invocation.artifactName !== undefined) input.artifactName = invocation.artifactName;
  if (invocation.marker !== undefined) input.marker = invocation.marker;
  if (invocation.maxFindings !== undefined) input.maxFindings = invocation.maxFindings;
  if (invocation.maxImages !== undefined) input.maxImages = invocation.maxImages;

  const document = await ctx.ports.renderComment(input);

  // `--out` is how a workflow avoids passing a multi-kilobyte body through a shell, where a
  // backtick in a selector becomes a command substitution.
  let written: string | null = null;
  if (invocation.out !== undefined) {
    written = path.resolve(ctx.cwd, invocation.out);
    await writeFile(written, document.markdown, 'utf8');
  }

  // In human mode the markdown *is* the output: `vdiff comment checkout > body.md` has to work, so
  // nothing else goes to stdout. Everything a person would want to know about the rendering goes to
  // stderr as warnings, and into `data` under `--json`.
  const human = written === null ? document.markdown.split('\n') : [written];

  const warnings: string[] = [...composed.warnings];
  if (document.truncated.findings > 0) {
    warnings.push(
      `comment truncated: ${document.truncated.findings} of ${result.summary.totalFindings} ` +
        'findings are not in the body; the full set is in findings.json',
    );
  }
  if (document.truncated.images > 0) {
    warnings.push(`comment truncated: ${document.truncated.images} changed shot(s) not shown`);
  }
  if (invocation.imageBase === undefined && result.summary.maxPixelChangedRatio > 0) {
    warnings.push(
      `no --image-base given, so this comment shows no screenshots (max pixel change ` +
        `${percent(result.summary.maxPixelChangedRatio)}); publish the bundle's images and pass ` +
        'their URL prefix to embed them',
    );
  }
  if (gate.tripped) warnings.push(`gate failed: ${gate.reason}`);

  const data: CommentData = {
    flow: pair.flow,
    pair,
    markdown: document.markdown,
    marker: document.marker,
    bytes: document.bytes,
    images: document.images,
    truncated: document.truncated,
    path: written,
    gate,
    labels: pairLabels(result.scenarios),
    notices,
    result,
  };

  // Exit 3 only when a level was named *and* tripped. A gate the caller did not ask for cannot fail,
  // which is what keeps `vdiff comment` usable as a plain renderer.
  return gate.tripped
    ? { data, human, warnings, exitCode: EXIT.GATE_FAILED }
    : { data, human, warnings };
}
