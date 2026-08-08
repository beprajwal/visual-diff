/**
 * Viewport tab bar (spec §9). Viewports are independent full replays, so switching tabs switches
 * the whole compared pair, including its regions and findings.
 */

import type { ViewportId } from '../../../types.js';

export interface ViewportTabsProps {
  viewports: ViewportId[];
  selected: ViewportId | null;
  /** Findings per viewport for the selected step, shown as a small count on each tab. */
  counts: Record<ViewportId, number>;
  onSelect: (viewport: ViewportId) => void;
}

export function ViewportTabs({ viewports, selected, counts, onSelect }: ViewportTabsProps) {
  if (viewports.length <= 1) return null;
  return (
    <div class="group tabs" role="tablist" aria-label="viewport">
      {viewports.map((viewport) => {
        const count = counts[viewport] ?? 0;
        return (
          <button
            type="button"
            key={viewport}
            role="tab"
            aria-selected={viewport === selected}
            aria-pressed={viewport === selected}
            onClick={() => onSelect(viewport)}
          >
            {viewport}
            {count > 0 ? ` · ${count}` : ''}
          </button>
        );
      })}
    </div>
  );
}
