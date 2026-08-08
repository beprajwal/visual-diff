/**
 * Run-level warnings: HAR misses, unstable git state, truncated DOM snapshots, blocked steps
 * (spec §7, §10, §12). These are the signals that tell a reviewer a finding might be an artefact of
 * the capture rather than a real change, so they are shown, never swallowed.
 */

import type { RunMeta, RunWarning, RunWarningKind } from '../../../types.js';

export interface WarningsProps {
  baseMeta: RunMeta | null;
  headMeta: RunMeta | null;
  /** Diff-level warnings from `findings.json`. */
  diffWarnings: string[];
}

const HIGH: ReadonlySet<RunWarningKind> = new Set<RunWarningKind>([
  'har-miss',
  'unstable-git',
  'console-error',
]);

function WarningRow({ side, warning }: { side: string; warning: RunWarning }) {
  return (
    <div class={`warn${HIGH.has(warning.kind) ? ' high' : ''}`}>
      <span class="badge">{side}</span>
      <span>
        <strong>{warning.kind}</strong> {warning.message}
        {warning.steps && warning.steps.length > 0 ? (
          <>
            {' '}
            <code>{warning.steps.join(', ')}</code>
          </>
        ) : null}
        {warning.urls && warning.urls.length > 0 ? (
          <>
            {' '}
            <code>{warning.urls.join(' ')}</code>
          </>
        ) : null}
      </span>
    </div>
  );
}

export function Warnings({ baseMeta, headMeta, diffWarnings }: WarningsProps) {
  const rows: Array<{ side: string; warning: RunWarning }> = [];
  for (const warning of baseMeta?.warnings ?? []) rows.push({ side: 'base', warning });
  for (const warning of headMeta?.warnings ?? []) rows.push({ side: 'head', warning });

  if (rows.length === 0 && diffWarnings.length === 0) return null;

  return (
    <section>
      <h2>warnings</h2>
      <div class="warnings">
        {rows.map((row, index) => (
          <WarningRow key={`${row.side}-${row.warning.kind}-${index}`} {...row} />
        ))}
        {diffWarnings.map((message, index) => (
          <div class="warn" key={`diff-${index}`}>
            <span class="badge">diff</span>
            <span>{message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
