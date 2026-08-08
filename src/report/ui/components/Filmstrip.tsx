/**
 * Filmstrip: every step of the flow as a thumbnail with a change-count badge (spec §9, D7).
 *
 * Red for failed, green `+` for added, dashed for removed, gray `=` for identical; everything else
 * carries the number of findings. Blocked steps still occupy a cell so the strip stays a full
 * rectangular grid rather than a truncated flow (spec §7).
 */

import type { StepId } from '../../../types.js';
import type { FilmstripCell } from '../derive.js';

export interface FilmstripProps {
  cells: FilmstripCell[];
  selected: StepId | null;
  /** Resolves the thumbnail URL for a cell, or null when that side has no shot. */
  thumbUrl: (cell: FilmstripCell) => string | null;
  onSelect: (step: StepId) => void;
}

const VARIANT_TITLE: Record<FilmstripCell['variant'], string> = {
  failed: 'step failed',
  blocked: 'blocked by an earlier failure',
  added: 'step added in the head run',
  removed: 'step removed since the base run',
  'spec-changed': 'step definition drifted',
  changed: 'visual or semantic change',
  identical: 'identical',
};

export function Filmstrip({ cells, selected, thumbUrl, onSelect }: FilmstripProps) {
  return (
    <nav class="filmstrip" aria-label="flow steps">
      {cells.map((cell) => {
        const url = thumbUrl(cell);
        const severity = cell.topSeverity ? ` s-${cell.topSeverity}` : '';
        const title = cell.detail
          ? `${VARIANT_TITLE[cell.variant]} — ${cell.detail}`
          : VARIANT_TITLE[cell.variant];
        return (
          <button
            type="button"
            key={cell.id}
            class={`cell v-${cell.variant}`}
            aria-current={cell.id === selected ? 'true' : 'false'}
            title={title}
            onClick={() => onSelect(cell.id)}
          >
            {url ? (
              <img class="thumb" src={url} alt="" loading="lazy" decoding="async" />
            ) : (
              <span class="thumb empty">∅</span>
            )}
            <span class={`cell-badge b-${cell.variant}${severity}`}>{cell.badge}</span>
            <span class="name" title={cell.id}>
              {cell.id}
            </span>
            <span class="sub">
              {cell.variant === 'changed' || cell.variant === 'spec-changed'
                ? `${(cell.pixelChangedRatio * 100).toFixed(1)}% px`
                : VARIANT_TITLE[cell.variant]}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
