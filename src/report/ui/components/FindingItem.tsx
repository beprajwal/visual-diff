/**
 * One finding row: kind, severity, element, and — when expanded — the property-level change list
 * from the diff engine. Clicking the row selects the finding (highlighting its region); the comment
 * action opens the feedback box (spec §9).
 *
 * A row with no element is the ordinary case on an e2e pair, not an omission (e2e spec §4): a trace
 * snapshot carries no box metrics, so a changed region cannot be attributed to anything. The row
 * says so in place of the selector rather than simply showing nothing, because a blank where every
 * other row has an element reads as a rendering fault, and a reviewer who does not know the pair is
 * a pixel comparison will look for the missing detail somewhere else.
 */

import { useState } from 'preact/hooks';

import type { Finding, JsonPrimitive } from '../../../types.js';
import { pixelsOnlyFindingNote } from '../derive.js';

export interface FindingItemProps {
  finding: Finding;
  selected: boolean;
  cropUrl: string | null;
  onSelect: (finding: Finding) => void;
  onComment: (finding: Finding) => void;
}

function renderValue(value: JsonPrimitive): string {
  if (value === null) return '∅';
  if (typeof value === 'string') return value.length === 0 ? '""' : value;
  return String(value);
}

export function FindingItem({
  finding,
  selected,
  cropUrl,
  onSelect,
  onComment,
}: FindingItemProps) {
  const [expanded, setExpanded] = useState(false);
  const element = finding.element;
  const pixelsOnly = pixelsOnlyFindingNote(finding);
  const hasDetail = finding.changes.length > 0 || cropUrl !== null;

  return (
    <div class={`finding${selected ? ' selected' : ''}`}>
      <button
        type="button"
        class="row"
        aria-expanded={expanded}
        onClick={() => {
          onSelect(finding);
          if (hasDetail) setExpanded(!expanded);
        }}
      >
        <span class="kind">{finding.kind}</span>
        <span class="label">{finding.label}</span>
        {hasDetail ? <span class="caret">{expanded ? '▾' : '▸'}</span> : null}
      </button>

      {element ? (
        <div class="sel" title={element.selector}>
          {element.selector}
          {element.role ? ` · ${element.role}` : ''}
          {element.name ? ` “${element.name}”` : ''}
        </div>
      ) : null}

      {pixelsOnly === null ? null : (
        <div class="sel pixels-only" title={pixelsOnly}>
          {pixelsOnly}
        </div>
      )}

      {finding.collapsed ? (
        <div class="sel">{finding.collapsed.count} smaller changes folded in</div>
      ) : null}

      {expanded ? (
        <>
          {finding.changes.length > 0 ? (
            <ul class="changes">
              {finding.changes.map((change, index) => (
                <li key={`${change.prop}-${index}`}>
                  <span class="prop" title={change.prop}>
                    {change.prop}
                  </span>
                  <span>
                    <span class="from">{renderValue(change.from)}</span>
                    <span class="arrow">→</span>
                    <span class="to">{renderValue(change.to)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {finding.reasons.length > 0 ? (
            <div class="sel">{finding.reasons.join(', ')}</div>
          ) : null}
          {cropUrl ? <img class="crop" src={cropUrl} alt={`crop for ${finding.id}`} /> : null}
        </>
      ) : null}

      <div class="actions">
        <button type="button" onClick={() => onComment(finding)}>
          comment
        </button>
        <span class="sel">{finding.id}</span>
      </div>
    </div>
  );
}
