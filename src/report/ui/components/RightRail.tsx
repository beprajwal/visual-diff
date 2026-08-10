/**
 * Right rail: findings for the selected step, grouped by severity, expandable to the
 * property-level change list (spec §9).
 *
 * Severity orders and colours the list; it never hides anything (spec §8), so every group present
 * in the data is rendered even when the reviewer is filtering steps.
 *
 * `unavailable` is the one thing here that is *not* a finding, and it is here rather than in the
 * banner strip on purpose (e2e spec §4). This rail is where a reader decides the tool found nothing.
 * An e2e pair cannot produce a property-level, accessibility or structural finding at all, and
 * cannot attribute any finding it *does* produce to an element — it is a pixel comparison. An empty
 * or elementless list that does not say so is indistinguishable from a clean, element-level review.
 */

import type { Finding, Severity } from '../../../types.js';
import { groupBySeverity } from '../derive.js';
import { FindingItem } from './FindingItem.js';

export interface RightRailProps {
  findings: Finding[];
  selectedFinding: string | null;
  /** Layers this pair could not run, each already a whole sentence. Empty for a replay pair. */
  unavailable?: readonly string[];
  cropUrl: (finding: Finding) => string | null;
  onSelect: (finding: Finding) => void;
  onComment: (finding: Finding) => void;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  high: 'high',
  med: 'medium',
  low: 'low',
};

export function RightRail({
  findings,
  selectedFinding,
  unavailable = [],
  cropUrl,
  onSelect,
  onComment,
}: RightRailProps) {
  const groups = groupBySeverity(findings);

  return (
    <section>
        <h2>
          findings
          {findings.length > 0 ? ` (${findings.length})` : ''}
        </h2>
        {groups.length === 0 ? (
          <p class="empty">No findings for this step.</p>
        ) : (
          groups.map((group) => (
            <div class={`sev-group ${group.severity}`} key={group.severity}>
              <h3>
                {SEVERITY_LABEL[group.severity]} · {group.findings.length}
              </h3>
              {group.findings.map((finding) => (
                <FindingItem
                  key={finding.id}
                  finding={finding}
                  selected={finding.id === selectedFinding}
                  cropUrl={cropUrl(finding)}
                  onSelect={onSelect}
                  onComment={onComment}
                />
              ))}
            </div>
          ))
        )}
        {unavailable.length === 0 ? null : (
          <ul class="unavailable-kinds">
            {unavailable.map((note) => (
              <li class="unavailable-kind" key={note}>
                {note}
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
