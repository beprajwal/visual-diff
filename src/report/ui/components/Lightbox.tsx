/**
 * Fullscreen screenshot viewer: one shot filling the window, zoomable and pannable.
 *
 * The focus pane shows base and head side by side, which is the right default and the wrong way to
 * judge a four-pixel shift — at half the window each, scaled down to fit, the thing under review is
 * smaller than it ever is in a browser. This is the escape hatch: the same image at full size,
 * magnified up to 8× about the cursor, with the region boxes still on it (and still clickable, so a
 * comment can be left from here) unless the reviewer has switched the annotations off.
 *
 * Zoom arithmetic lives in `zoom.ts`; this file is the DOM and the gestures.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import type { Region, Size } from '../../../types.js';
import {
  FIT,
  SCALE_STEP,
  fitInside,
  isCrisp,
  isFit,
  panBy,
  transform,
  wheelFactor,
  zoomBy,
  zoomLabel,
  zoomTo,
  type Zoom,
} from '../zoom.js';
import { RegionLayer } from './RegionLayer.js';

export interface LightboxProps {
  /** What is being shown: `base`, `head`, `pixel mask`. */
  label: string;
  src: string;
  /** Natural pixel size of the shot, when the diff knows it. */
  imageSize: Size | null;
  regions: Region[];
  showRegions: boolean;
  selectedRegionId: string | null;
  onSelectRegion: (region: Region) => void;
  onClose: () => void;
}

/** Arrow-key pan distance, in viewport pixels. Shift makes it a coarse jump. */
const KEY_PAN = 40;

/** Movement below this is a click on whatever is under the pointer, not the start of a drag. */
const DRAG_SLOP = 4;

export function Lightbox(props: LightboxProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; captured: boolean } | null>(null);

  const [frame, setFrame] = useState<Size>({ w: 0, h: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const [zoom, setZoom] = useState<Zoom>(FIT);

  // The diff reports the shot's size for most pairs; `onLoad` covers the ones it does not (a step
  // captured on one side only has no measured pair to report a size from).
  const source = props.imageSize ?? natural;
  const fitted = source ? fitInside(source, frame) : { w: 0, h: 0 };

  // Keys reach the dialog rather than whatever was focused behind it.
  useEffect(() => {
    host.current?.focus();
  }, []);

  // A new shot (another step, the other side) opens fitted rather than inheriting a magnification
  // aimed at pixels that are no longer there.
  useEffect(() => {
    setZoom(FIT);
    setNatural(null);
  }, [props.src]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = (): void => {
      const box = element.getBoundingClientRect();
      setFrame({ w: box.width, h: box.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** A pointer position as an offset from the stage centre, which is what the zoom math wants. */
  const focusOf = useCallback((clientX: number, clientY: number) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2) };
  }, []);

  const onWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      const focus = focusOf(event.clientX, event.clientY);
      setZoom((current) => zoomBy(current, wheelFactor(event.deltaY), frame, fitted, focus));
    },
    [focusOf, frame, fitted],
  );

  const onPointerDown = useCallback((event: PointerEvent) => {
    drag.current = { x: event.clientX, y: event.clientY, captured: false };
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const from = drag.current;
      if (!from || event.buttons === 0) return;
      // The pointer is captured on the first real movement rather than on the press: capturing
      // straight away retargets the click too, and the region boxes would stop being clickable.
      if (!from.captured && Math.abs(event.clientX - from.x) + Math.abs(event.clientY - from.y) < DRAG_SLOP) {
        return;
      }
      if (!from.captured) {
        (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
        from.captured = true;
      }
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      drag.current = { x: event.clientX, y: event.clientY, captured: true };
      setZoom((current) => panBy(current, dx, dy, frame, fitted));
    },
    [frame, fitted],
  );

  const onPointerUp = useCallback((event: PointerEvent) => {
    if (drag.current?.captured) {
      (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
    }
    drag.current = null;
  }, []);

  const onDoubleClick = useCallback(
    (event: MouseEvent) => {
      const focus = focusOf(event.clientX, event.clientY);
      setZoom((current) =>
        current.scale > 1 ? FIT : zoomTo(current, 2, frame, fitted, focus),
      );
    },
    [focusOf, frame, fitted],
  );

  const step = useCallback(
    (factor: number) => setZoom((current) => zoomBy(current, factor, frame, fitted)),
    [frame, fitted],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const distance = event.shiftKey ? KEY_PAN * 4 : KEY_PAN;
      const pan = (dx: number, dy: number): void => {
        event.preventDefault();
        setZoom((current) => panBy(current, dx, dy, frame, fitted));
      };
      switch (event.key) {
        case '+':
        case '=':
          event.preventDefault();
          step(SCALE_STEP);
          break;
        case '-':
        case '_':
          event.preventDefault();
          step(1 / SCALE_STEP);
          break;
        case '0':
          event.preventDefault();
          setZoom(FIT);
          break;
        case 'ArrowLeft':
          pan(distance, 0);
          break;
        case 'ArrowRight':
          pan(-distance, 0);
          break;
        case 'ArrowUp':
          pan(0, distance);
          break;
        case 'ArrowDown':
          pan(0, -distance);
          break;
        default:
          break;
      }
    },
    [frame, fitted, step],
  );

  const magnified = zoom.scale > 1;

  return (
    <div
      class="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${props.label} screenshot, fullscreen`}
      tabIndex={-1}
      ref={host}
      onKeyDown={onKeyDown}
    >
      <div class="lightbox-bar">
        <strong>{props.label}</strong>
        <span class="note">{source ? `${source.w}×${source.h}` : '—'}</span>
        <span class="spacer" />
        <div class="group" role="group" aria-label="zoom">
          <button type="button" title="zoom out (−)" onClick={() => step(1 / SCALE_STEP)}>
            −
          </button>
          <span class="note">{zoomLabel(zoom)}</span>
          <button type="button" title="zoom in (+)" onClick={() => step(SCALE_STEP)}>
            +
          </button>
          <button
            type="button"
            title="fit to the window (0)"
            disabled={isFit(zoom)}
            onClick={() => setZoom(FIT)}
          >
            fit
          </button>
        </div>
        <button type="button" title="close (esc or z)" onClick={props.onClose}>
          close
        </button>
      </div>

      <div
        class={`lightbox-stage${magnified ? ' grabbable' : ''}`}
        ref={stage}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDblClick={onDoubleClick}
      >
        <div
          class={`lightbox-frame${isCrisp(zoom) ? ' crisp' : ''}`}
          style={
            fitted.w > 0
              ? `width:${fitted.w}px;height:${fitted.h}px;transform:${transform(zoom)}`
              : undefined
          }
        >
          <img
            src={props.src}
            alt={props.label}
            draggable={false}
            onLoad={(event: Event) => {
              const image = event.currentTarget as HTMLImageElement;
              setNatural({ w: image.naturalWidth, h: image.naturalHeight });
            }}
          />
          {props.showRegions ? (
            <RegionLayer
              regions={props.regions}
              imageSize={source}
              selectedRegionId={props.selectedRegionId}
              onSelect={props.onSelectRegion}
            />
          ) : null}
        </div>
      </div>

      <div class="lightbox-hint note">
        scroll or ± to zoom · drag to pan · double-click to toggle · 0 fits · esc closes
      </div>
    </div>
  );
}
