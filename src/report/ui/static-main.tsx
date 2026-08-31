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
`;

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
