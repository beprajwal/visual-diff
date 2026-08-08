/**
 * Right rail: findings for the selected step, grouped by severity, expandable to the
 * property-level change list (spec §9).
 *
 * Severity orders and colours the list; it never hides anything (spec §8), so every group present
 * in the data is rendered even when the reviewer is filtering steps.
 */

import type { Finding, Severity } from '../../../types.js';
import { groupBySeverity } from '../derive.js';
import { FindingItem } from './FindingItem.js';

export interface RightRailProps {
  findings: Finding[];
  selectedFinding: string | null;
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
    </section>
  );
}
