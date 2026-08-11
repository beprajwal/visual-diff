/**
 * `vdiff export <flow> [base] [head]` — write the portable evidence bundle (CI spec §5).
 *
 * The bundle exists because GitHub cannot render an image out of a workflow artifact (D31): a
 * comment can carry numbers and links, but the pictures have to live somewhere a browser can reach.
 * So this writes a directory that is complete on its own — the stored diff verbatim, a rendered
 * comment, a static HTML page, and the PNGs both of them address — with every internal path relative,
 * so the same bytes work zipped, pushed to a branch, deployed to Pages, or opened off a filesystem.
 *
 * It writes; it does not upload. Whatever moves the directory somewhere is the transport's job, for
 * the same reason `comment` does not post (D29).
 *
 * Unlike `comment`, this command never exits 3. `--fail-on` here only *records* the verdict in the
 * bundle's own `summary.json` and renders it into the bundle's `comment.md`, because failing after
 * writing a directory of evidence would make the evidence the least likely thing a workflow keeps.
 */

import { EXIT } from '../../types.js';
import * as path from 'node:path';

import type { ExportRequest } from '../../ci/index.js';
import type { Invocation } from '../args.js';
import { evaluateGate } from '../ci.js';
import type { CommandContext, CommandResult } from '../command.js';
import { composePairNotices, pairLabels } from '../pair-notices.js';
import type { ExportData } from '../shapes.js';
import { reproCommands, resolveDiff } from './pair.js';

type ExportInvocation = Extract<Invocation, { kind: 'export' }>;

export async function exportCommand(
  ctx: CommandContext,
  invocation: ExportInvocation,
): Promise<CommandResult<ExportData>> {
  const { config, pair, result, exportDir } = await resolveDiff(ctx, invocation);

  const composed = composePairNotices(result);
  const notices = [...composed.notices.map((notice) => notice.sentence), ...composed.degraded];
  const gate = evaluateGate(result.summary, invocation.failOn);

  // `--out` is resolved against the invocation directory, not the project root: a workflow writes
  // the bundle into the runner's workspace, which is not necessarily inside `.visual-diff/`.
  const outDir =
    invocation.out === undefined ? exportDir : path.resolve(ctx.cwd, invocation.out);

  const request: ExportRequest = {
    root: config.root,
    result,
    outDir,
    images: invocation.images,
    version: ctx.version,
    generatedAt: new Date().toISOString(),
    notices,
    gate,
    repro: reproCommands(pair),
  };
  if (invocation.artifactUrl !== undefined) request.artifactUrl = invocation.artifactUrl;
  if (invocation.artifactName !== undefined) request.artifactName = invocation.artifactName;

  const report = await ctx.ports.exportBundle(request);

  const human: string[] = [
    `${pair.flow}  ${pair.base}..${pair.head}  →  ${report.outDir}`,
    `${report.files.length} file(s), ${report.images} image(s), images=${invocation.images}`,
  ];
  for (const file of report.files) human.push(`  ${file}`);
  human.push('');
  human.push(`open ${path.join(report.outDir, 'report.html')} to review it offline`);

  const warnings: string[] = [...composed.warnings];
  if (report.missing.length > 0) {
    warnings.push(
      `${report.missing.length} expected image(s) were not on disk and are absent from the bundle: ` +
        `${report.missing.slice(0, 3).join(', ')}${report.missing.length > 3 ? ', …' : ''}`,
    );
  }
  if (gate.tripped) {
    // Stated, never enforced here: see the header. `vdiff comment --fail-on` is the gate.
    warnings.push(`gate would fail: ${gate.reason}`);
  }

  const data: ExportData = {
    flow: pair.flow,
    pair,
    outDir: report.outDir,
    files: report.files,
    images: report.images,
    missing: report.missing,
    gate,
    labels: pairLabels(result.scenarios),
    notices,
    comment: {
      path: path.join(report.outDir, 'comment.md'),
      bytes: report.comment.bytes,
    },
    result,
  };

  return { data, human, warnings, exitCode: EXIT.OK };
}
