/**
 * Run-level warnings: HAR misses, unstable git state, truncated DOM snapshots, blocked steps
 * (spec §7, §10, §12), and the two scenario warnings (mocking spec §8). These are the signals that
 * tell a reviewer a finding might be an artefact of the capture rather than a real change, so they
 * are shown, never swallowed.
 *
 * `scenario-rule-unmatched` is high severity and lists its rule ids, which is the whole point of
 * it: a reviewer looking at a screen they believe is the empty state, when a mistyped glob matched
 * nothing and they are in fact seeing the recorded full response, has been actively misled by the
 * tool (mocking spec §8). A warning that said only "a rule did not match" would leave them
 * grepping the YAML.
 *
 * The three variant warnings (variants spec §7) are the same hazard one axis over, and are shown
 * the same way. `variant-rule-unmatched` is the exact twin of the scenario one. `variant-rule-
 * reverted` is the D22 warning, and it is the reason apply-once is a safe choice at all: without it
 * an application that re-rendered after the rules were applied would hand back a screenshot of the
 * *unvaried* UI labelled as a proposal, and nobody could see that from the picture.
 */

import type { RunMeta, RunWarning } from '../../../types.js';
import { isHighSeverityWarning } from '../derive.js';

export interface WarningsProps {
  baseMeta: RunMeta | null;
  headMeta: RunMeta | null;
  /** Diff-level warnings from `findings.json`. */
  diffWarnings: string[];
}

function WarningRow({ side, warning }: { side: string; warning: RunWarning }) {
  return (
    <div class={`warn${isHighSeverityWarning(warning.kind) ? ' high' : ''}`}>
      <span class="badge">{side}</span>
      <span>
        <strong>{warning.kind}</strong> {warning.message}
        {warning.rules && warning.rules.length > 0 ? (
          <>
            {' '}
            <code class="rules">{warning.rules.join(', ')}</code>
          </>
        ) : null}
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
