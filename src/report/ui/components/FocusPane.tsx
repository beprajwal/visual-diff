/**
 * Focus pane (spec §9, D7): side-by-side by default, toggleable to overlay (onion-skin with a
 * slider) and swipe (draggable divider). Region boxes are drawn over the head image in every mode
 * and are clickable.
 */

import { useState } from 'preact/hooks';

import type { Region, ViewportDiff } from '../../../types.js';
import type { FilmstripCell } from '../derive.js';
import type { ViewMode } from '../route.js';
import { OverlayView } from './OverlayView.js';
import { RegionLayer } from './RegionLayer.js';
import { SwipeView } from './SwipeView.js';

export interface FocusPaneProps {
  cell: FilmstripCell | undefined;
  viewportDiff: ViewportDiff | undefined;
  view: ViewMode;
  overlayOpacity: number;
  swipeAt: number;
  baseUrl: string | null;
  headUrl: string | null;
  pixelUrl: string | null;
  selectedRegionId: string | null;
  onSetView: (view: ViewMode) => void;
  onSetOverlayOpacity: (value: number) => void;
  onSetSwipe: (value: number) => void;
  onSelectRegion: (region: Region) => void;
}

const VIEW_LABELS: Array<{ view: ViewMode; label: string; hint: string }> = [
  { view: 'side-by-side', label: 'side by side', hint: 'base and head next to each other' },
  { view: 'overlay', label: 'overlay', hint: 'onion-skin (o)' },
  { view: 'swipe', label: 'swipe', hint: 'draggable divider' },
];

export function FocusPane(props: FocusPaneProps) {
  const [showPixels, setShowPixels] = useState(false);
  const { cell, viewportDiff: vd } = props;

  const regions = vd?.regions ?? [];
  const headSize = vd?.headSize ?? null;
  const layer = (
    <RegionLayer
      regions={regions}
      imageSize={headSize}
      selectedRegionId={props.selectedRegionId}
      onSelect={props.onSelectRegion}
    />
  );

  const missing = vd?.missing;
  const basePane = showPixels && props.pixelUrl ? props.pixelUrl : props.baseUrl;

  return (
    <>
      <div class="toolbar">
        <div class="group tabs" role="group" aria-label="view mode">
          {VIEW_LABELS.map((entry) => (
            <button
              type="button"
              key={entry.view}
              aria-pressed={props.view === entry.view}
              title={entry.hint}
              onClick={() => props.onSetView(entry.view)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {props.view === 'overlay' ? (
          <label class="group">
            head
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(props.overlayOpacity * 100)}
              aria-label="onion-skin opacity"
              onInput={(event: Event) => {
                const value = Number((event.currentTarget as HTMLInputElement).value);
                props.onSetOverlayOpacity(value / 100);
              }}
            />
            <span class="note">{Math.round(props.overlayOpacity * 100)}%</span>
          </label>
        ) : null}

        {props.view === 'side-by-side' && props.pixelUrl ? (
          <button
            type="button"
            aria-pressed={showPixels}
            title="replace the base pane with the pixel change mask"
            onClick={() => setShowPixels(!showPixels)}
          >
            pixel mask
          </button>
        ) : null}

        <span class="spacer" />

        {cell ? (
          <span class="note">
            {cell.id} · {cell.findingsCount} finding{cell.findingsCount === 1 ? '' : 's'}
            {vd ? ` · ${(vd.pixelChangedRatio * 100).toFixed(2)}% pixels` : ''}
            {regions.length > 0 ? ` · ${regions.length} region${regions.length === 1 ? '' : 's'}` : ''}
          </span>
        ) : null}
      </div>

      <div class="stage">
        {!cell ? (
          <p class="notice">No step selected.</p>
        ) : (
          <>
            {vd?.dimensionsChanged ? (
              <p class="notice">
                Page size changed: {formatSize(vd.baseSize)} → {formatSize(vd.headSize)}. Comparison
                continues on the common area.
              </p>
            ) : null}
            {cell.status === 'failed' ? (
              <p class="notice error">
                This step failed in the head run; downstream steps are blocked.
              </p>
            ) : null}
            {cell.status === 'spec-changed' && cell.detail ? (
              <p class="notice">Step definition drifted: {cell.detail}</p>
            ) : null}

            {props.view === 'overlay' ? (
              <OverlayView
                baseUrl={props.baseUrl}
                headUrl={props.headUrl}
                opacity={props.overlayOpacity}
              >
                {layer}
              </OverlayView>
            ) : props.view === 'swipe' ? (
              <SwipeView
                baseUrl={props.baseUrl}
                headUrl={props.headUrl}
                at={props.swipeAt}
                onChange={props.onSetSwipe}
              >
                {layer}
              </SwipeView>
            ) : (
              <div class={`pair${missing ? ' single' : ''}`}>
                {missing === 'base' || missing === 'both' ? null : (
                  <figure class="shot">
                    <figcaption>
                      <span>{showPixels ? 'pixel mask' : 'base'}</span>
                      <span>{formatSize(vd?.baseSize ?? null)}</span>
                    </figcaption>
                    <div class="canvas">
                      {basePane ? (
                        <img src={basePane} alt="base" />
                      ) : (
                        <span class="note">no shot</span>
                      )}
                    </div>
                  </figure>
                )}
                {missing === 'head' || missing === 'both' ? null : (
                  <figure class="shot">
                    <figcaption>
                      <span>head</span>
                      <span>{formatSize(vd?.headSize ?? null)}</span>
                    </figcaption>
                    <div class="canvas">
                      {props.headUrl ? (
                        <img src={props.headUrl} alt="head" />
                      ) : (
                        <span class="note">no shot</span>
                      )}
                      {layer}
                    </div>
                  </figure>
                )}
                {missing ? (
                  <p class="notice">
                    {missing === 'both'
                      ? 'Neither run captured this step.'
                      : missing === 'base'
                        ? 'This step is new in the head run — nothing to compare against.'
                        : 'This step existed only in the base run.'}
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function formatSize(size: { w: number; h: number } | null): string {
  return size ? `${size.w}×${size.h}` : '—';
}
