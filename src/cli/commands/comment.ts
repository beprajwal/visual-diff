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

import { access, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { EXIT } from '../../types.js';
import type { Invocation } from '../args.js';
import { evaluateGate, GATE_NONE } from '../ci.js';
import type { CommandContext, CommandResult } from '../command.js';
import { PREVIEW_FILES, type CommentInput } from '../../ci/index.js';
import { PREVIEW_MANIFEST } from '../../ci/preview.js';
import { hasMinorChanges, significanceFingerprint, significantDiff } from '../../diff/significance.js';
import { percent } from '../output.js';
import { composePairNotices, pairLabels } from '../pair-notices.js';
import type { CommentData } from '../shapes.js';
import { emitChannelsOf, reproCommands, resolveDiff } from './pair.js';

type CommentInvocation = Extract<Invocation, { kind: 'comment' }>;

export async function comment(
  ctx: CommandContext,
  invocation: CommentInvocation,
): Promise<CommandResult<CommentData>> {
  const { pair, result, review } = await resolveDiff(ctx, invocation);

  const composed = composePairNotices(result);
  const notices = [
    ...composed.notices.map((notice) => notice.sentence),
    ...composed.degraded,
  ];
  const gate = evaluateGate(significantDiff(result).summary, invocation.failOn);

  const input: CommentInput = {
    result,
    notices,
    gate,
    version: ctx.version,
    repro: reproCommands(pair),
  };
  // A stored review rides along without a flag (D39): `vdiff review` ran, so the comment carries
  // its reading; it did not, so the comment is the one CI mode always rendered.
  if (review !== null) input.review = review;
  if (invocation.imageBase !== undefined) input.imageBase = invocation.imageBase;
  if (invocation.artifactUrl !== undefined) input.artifactUrl = invocation.artifactUrl;
  if (invocation.artifactName !== undefined) input.artifactName = invocation.artifactName;
  if (invocation.reportUrl !== undefined) input.reportUrl = invocation.reportUrl;
  // The picture of the report (D51) is offered only when the bundle actually holds it: an <img>
  // that 404s is worse than a comment without one, so the files are checked, not assumed.
  if (invocation.bundle !== undefined && invocation.imageBase !== undefined) {
    const bundle = path.resolve(ctx.cwd, invocation.bundle);
    const present = async (relative: string): Promise<boolean> =>
      access(path.join(bundle, relative)).then(
        () => true,
        () => false,
      );
    if (await present(PREVIEW_FILES.light)) {
      const fingerprint = await previewFingerprint(bundle);
      if (fingerprint !== undefined) input.previewDiffFingerprint = fingerprint;
      // The renderer applies this check too; doing it here keeps the JSON preview verdict honest.
      if (!hasMinorChanges(result) || fingerprint === significanceFingerprint(result)) {
        input.preview = (await present(PREVIEW_FILES.dark))
          ? { light: PREVIEW_FILES.light, dark: PREVIEW_FILES.dark }
          : { light: PREVIEW_FILES.light };
      }
    }
  }
  if (invocation.marker !== undefined) input.marker = invocation.marker;
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
  if (document.truncated.images > 0) {
    warnings.push(`comment truncated: ${document.truncated.images} changed shot(s) not shown`);
  }
  if (invocation.imageBase === undefined && significantDiff(result).summary.maxPixelChangedRatio > 0) {
    warnings.push(
      `no --image-base given, so this comment shows no screenshots (max pixel change ` +
        `${percent(significantDiff(result).summary.maxPixelChangedRatio)}); publish the bundle's images and pass ` +
        'their URL prefix to embed them',
    );
  }
  // A gate that counts findings, on a diff that emits none, is a green check that means nothing
  // (D54). Said on stderr even with `diff.warnings: false`: it is a fact about this invocation's
  // configuration, not one of the diff's own warnings.
  if (invocation.failOn !== GATE_NONE && !emitChannelsOf(result).findings) {
    warnings.push(
      `--fail-on ${invocation.failOn} cannot trip: findings are off for this diff, so the gate ` +
        'has nothing to count',
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
    preview: input.preview !== undefined,
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

/** Old bundles have no stamp; malformed or partially written metadata grants no identity. */
async function previewFingerprint(bundle: string): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await readFile(path.join(bundle, PREVIEW_MANIFEST), 'utf8'));
    if (manifest === null || typeof manifest !== 'object' || !('diffFingerprint' in manifest)) {
      return undefined;
    }
    const value = manifest.diffFingerprint;
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
