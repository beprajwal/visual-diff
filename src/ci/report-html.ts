/**
 * ci/report-html — the bundle's page: the interactive report over embedded data (CI spec D38).
 *
 * This used to be a hand-rendered no-JS page — the honest subset of `vdiff serve` that survived
 * being zipped. D38 replaces the rendering, not the honesty: the page is now the same Preact app
 * the live report mounts (filmstrip, side-by-side, overlay, swipe, keyboard), inlined into one
 * file with its data embedded as a JSON snapshot. Still no server, no framework CDN, no external
 * request of any kind: the app script ships inside the `<script>` tag and the images are relative
 * paths into `images/` (`--html linked`) or `data:` URIs (`--html inline`).
 *
 * What a file cannot honour stays absent by construction: the snapshot client refuses feedback
 * with a sentence, the live badge is hidden, and only the exported pair is answerable. Composition
 * here is deliberately dumb — shell, `<noscript>` summary, JSON, script — so everything with
 * behaviour lives in `report/ui/` where it is tested against the same components the server uses.
 */

import type { ReportSnapshot } from '../report/ui/snapshot.js';

export interface ReportPageInput {
  snapshot: ReportSnapshot;
  /**
   * The prebuilt IIFE from `dist/ui/report-static.js`, or null when the caller could not find it
   * (a source checkout that has not run `pnpm build:ui`). Null still writes a valid page — the
   * snapshot and the pointer to `findings.json` are there — with a visible note instead of an app.
   */
  appScript: string | null;
}

/** `</script>` and JSON line separators must not terminate the carrying tags early. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderReportPage(input: ReportPageInput): string {
  const { snapshot, appScript } = input;
  const summary = snapshot.diff.summary;
  const title = `${snapshot.flow} ${snapshot.base}..${snapshot.head} — visual diff`;
  const headline =
    summary.totalFindings === 0
      ? 'No findings.'
      : `${summary.totalFindings} finding(s) — ${summary.bySeverity.high} high, ` +
        `${summary.bySeverity.med} med, ${summary.bySeverity.low} low.`;

  const body =
    appScript === null
      ? `<p style="font-family: system-ui; margin: 2rem;">This bundle was exported without the ` +
        `report UI (dist/ui/report-static.js was not built). The data is all here — see ` +
        `<code>findings.json</code> beside this file — but the interactive page needs an export ` +
        `from a built package.</p>`
      : `<script>${appScript}</script>`;

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="referrer" content="no-referrer" />',
    `<title>${escapeHtml(title)}</title>`,
    '</head>',
    '<body>',
    `<noscript><p>${escapeHtml(headline)} This page is the interactive visual-diff report and ` +
      'needs JavaScript (all of it inline — nothing is fetched). The raw data is in ' +
      '<code>findings.json</code> beside this file.</p></noscript>',
    '<div id="vdiff-root"></div>',
    `<script type="application/json" id="vdiff-snapshot">${embedJson(snapshot)}</script>`,
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
