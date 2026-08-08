/**
 * Region boxes drawn over the head image (spec §9). Rectangles come from the diff in screenshot
 * pixel space, so they are positioned as percentages of the head image's own size — that keeps them
 * aligned at any rendered width without measuring the DOM.
 */

import type { Region, Size } from '../../../types.js';

export interface RegionLayerProps {
  regions: Region[];
  /** Size of the head screenshot in the same pixel space as the region rects. */
  imageSize: Size | null;
  selectedRegionId: string | null;
  onSelect: (region: Region) => void;
}

function pct(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%';
  return `${((value / total) * 100).toFixed(4)}%`;
}

export function RegionLayer({
  regions,
  imageSize,
  selectedRegionId,
  onSelect,
}: RegionLayerProps) {
  if (!imageSize || regions.length === 0) return null;

  return (
    <div class="regions">
      {regions.map((region) => {
        const selected = region.id === selectedRegionId;
        return (
          <button
            type="button"
            key={region.id}
            class={`region${selected ? ' selected' : ''}`}
            style={`left:${pct(region.rect.x, imageSize.w)};top:${pct(
              region.rect.y,
              imageSize.h,
            )};width:${pct(region.rect.w, imageSize.w)};height:${pct(region.rect.h, imageSize.h)}`}
            title={`${region.id} — ${region.rect.w}×${region.rect.h}px, ${region.changedPixels} changed pixels`}
            aria-pressed={selected}
            onClick={(event: Event) => {
              event.stopPropagation();
              onSelect(region);
            }}
          >
            {selected ? <span class="tag">{region.id}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
