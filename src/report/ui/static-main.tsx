/**
 * report/ui/static-main — entry point for the exported bundle's page (CI spec D38).
 *
 * The served report loads `main.tsx`, which fetches from the API; this entry mounts the same App
 * over the snapshot embedded in the page by `vdiff export`. Everything interactive — filmstrip,
 * side-by-side, overlay, swipe, keyboard, hash routing — is the shared component tree; what this
 * file adds is the snapshot parsing, a banner for the export-time notices and gate verdict, and the
 * CSS that hides the two affordances a file cannot honour (the liveness badge; nothing else — the
 * comment buttons stay, and refuse with a sentence when used).
 */

import { render } from 'preact';

import type { Review } from '../../types.js';
import { App, injectStyles } from './main.js';
import { createSnapshotClient, type ReportSnapshot } from './snapshot.js';

const STATIC_STYLES = `
.live { display: none; }
.snapshot-banner {
  padding: 6px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--border, #ccc3);
  opacity: 0.85;
}
.snapshot-banner .gate-failed { font-weight: 600; }
.snapshot-review { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border, #ccc3); }
.snapshot-review .headline { font-weight: 600; }
.snapshot-review ul { margin: 4px 0 0; padding-left: 18px; }
.snapshot-review .flagged { font-weight: 600; }
.snapshot-review .attribution { opacity: 0.7; margin-top: 4px; }
`;

const ASSESSMENT_MARK: Record<Review['changes'][number]['assessment'], string> = {
  expected: '✅',
  unrelated: '⚠️',
  regression: '🔴',
  unclear: '❔',
};

/**
 * The model's reading of the pair (CI spec D39), when the bundle carries one: headline, a warning
 * for anything outside the described change, the ranked changes, the concerns, and who wrote it.
 * The same content `comment.md` renders, so the page and the comment never disagree.
 */
function ReviewBanner({ review }: { review: Review }) {
  const flagged = review.changes.filter(
    (change) => change.assessment === 'unrelated' || change.assessment === 'regression',
  );
  return (
    <div class="snapshot-review">
      <div class="headline">{review.headline}</div>
      {flagged.length > 0 ? (
        <div class="flagged">
          ⚠️ {flagged.length} change{flagged.length === 1 ? '' : 's'} not accounted for by this
          pull request or looking like a regression
        </div>
      ) : null}
      <div>{review.summary}</div>
      {review.changes.length > 0 ? (
        <ul>
          {review.changes.map((change, index) => (
            <li key={`${change.step}-${change.viewport ?? 'all'}-${index}`}>
              {ASSESSMENT_MARK[change.assessment]} <code>{change.step}</code>
              {change.viewport === null ? '' : ` @ ${change.viewport}`} — {change.description}
            </li>
          ))}
        </ul>
      ) : null}
      {review.concerns.length > 0 ? (
        <ul>
          {review.concerns.map((concern) => (
            <li key={concern}>⚠️ {concern}</li>
          ))}
        </ul>
      ) : null}
      <div class="attribution">
        Review by {review.model} ({review.provider}) from {review.evidence.images} screenshot
        {review.evidence.images === 1 ? '' : 's'}
        {review.evidence.contextProvided
          ? ' and the pull request description'
          : ', without a description of the intended change'}
        . A reading of the evidence, not a verdict.
      </div>
    </div>
  );
}

function Banner({ snapshot }: { snapshot: ReportSnapshot }) {
  const gate = snapshot.gate;
  return (
    <div class="snapshot-banner">
      <span>
        exported snapshot · {snapshot.flow} {snapshot.base}..{snapshot.head} ·{' '}
        {snapshot.generatedAt} · vdiff {snapshot.version}
      </span>
      {(snapshot.notices ?? []).map((notice) => (
        <div key={notice}>⚠️ {notice}</div>
      ))}
      {gate && gate.level !== 'none' ? (
        <div class={gate.tripped ? 'gate-failed' : ''}>
          {gate.tripped ? '❌ gate failed' : '✅ gate passed'} — {gate.reason}
        </div>
      ) : null}
      {snapshot.review ? <ReviewBanner review={snapshot.review} /> : null}
    </div>
  );
}

function mountSnapshot(): void {
  const holder = document.getElementById('vdiff-snapshot');
  const container = document.getElementById('vdiff-root');
  if (!holder || !container) return;
  const snapshot = JSON.parse(holder.textContent ?? '{}') as ReportSnapshot;

  injectStyles(document);
  const style = document.createElement('style');
  style.textContent = STATIC_STYLES;
  document.head.appendChild(style);

  render(
    <div>
      <Banner snapshot={snapshot} />
      <App client={createSnapshotClient(snapshot)} />
    </div>,
    container,
  );
}

if (typeof document !== 'undefined') mountSnapshot();
