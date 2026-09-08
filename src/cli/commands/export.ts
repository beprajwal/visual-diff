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

import { resolveAppScript } from '../../ci/app-script.js';
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
  const { config, pair, result, exportDir, review } = await resolveDiff(ctx, invocation);

  const composed = composePairNotices(result);
  const notices = [...composed.notices.map((notice) => notice.sentence), ...composed.degraded];
  const gate = evaluateGate(result.summary, invocation.failOn);

  // `--out` is resolved against the invocation directory, not the project root: a workflow writes
  // the bundle into the runner's workspace, which is not necessarily inside `.visual-diff/`.
  const outDir =
    invocation.out === undefined ? exportDir : path.resolve(ctx.cwd, invocation.out);

  const appScript = await resolveAppScript();

  const request: ExportRequest = {
    root: config.root,
    result,
    outDir,
    images: invocation.images,
    html: invocation.html,
    appScript,
    version: ctx.version,
    generatedAt: new Date().toISOString(),
    notices,
    gate,
    repro: reproCommands(pair),
  };
  if (invocation.artifactUrl !== undefined) request.artifactUrl = invocation.artifactUrl;
  if (invocation.artifactName !== undefined) request.artifactName = invocation.artifactName;
  // The stored review travels with the bundle (D39): as `review.json`, inside `comment.md`, and in
  // the page's snapshot — so the zip a reviewer downloads says the same thing the comment did.
  if (review !== null) request.review = review;
  if (invocation.preview) request.preview = true;

  const report = await ctx.ports.exportBundle(request);

  // The picture for the comment (D51), taken of the card the writer just put in the bundle. A
  // machine without Chromium still has its bundle; it just has no picture, and the warning says which.
  const preview: string[] = [];
  const previewWarnings: string[] = [];
  if (invocation.preview) {
    try {
      const captured = await ctx.ports.capturePreview({ outDir: report.outDir });
      preview.push(...captured.files);
    } catch (error) {
      previewWarnings.push(
        `no preview captured: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const human: string[] = [
    `${pair.flow}  ${pair.base}..${pair.head}  →  ${report.outDir}`,
    `${report.files.length} file(s), ${report.images} image(s), images=${invocation.images}, html=${invocation.html}`,
  ];
  for (const file of report.files) human.push(`  ${file}`);
  for (const file of preview) human.push(`  ${file}`);
  human.push('');
  human.push(`open ${path.join(report.outDir, 'report.html')} to review it offline`);
  if (invocation.html === 'inline') {
    human.push('report.html is self-contained: its images are embedded, the one file is the report');
  } else if (invocation.html === 'both') {
    human.push('report.inline.html is the same page with its images embedded — shareable as one file');
  }

  const warnings: string[] = [...composed.warnings, ...previewWarnings];
  if (appScript === null) {
    warnings.push(
      'report UI bundle not found (dist/ui/report-static.js): report.html carries the data but ' +
        'not the interactive app — build it with `pnpm build:ui`, or export from an installed package',
    );
  }
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
    html: invocation.html,
    missing: report.missing,
    gate,
    labels: pairLabels(result.scenarios),
    notices,
    comment: {
      path: path.join(report.outDir, 'comment.md'),
      bytes: report.comment.bytes,
    },
      preview,
    result,
  };

  return { data, human, warnings, exitCode: EXIT.OK };
}
