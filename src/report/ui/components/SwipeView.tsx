/**
 * Swipe view: the head image is revealed left-of-divider over the base image, with a divider the
 * reviewer drags. Pointer events are used directly (rather than a range input) so the whole image
 * area is the drag surface; arrow keys move the divider for keyboard users.
 */

import type { ComponentChildren } from 'preact';
import { useCallback, useRef } from 'preact/hooks';

export interface SwipeViewProps {
  baseUrl: string | null;
  headUrl: string | null;
  /** Divider position, 0..1 from the left edge. */
  at: number;
  onChange: (at: number) => void;
  children?: ComponentChildren;
}

export function SwipeView({ baseUrl, headUrl, at, onChange, children }: SwipeViewProps) {
  const host = useRef<HTMLDivElement | null>(null);

  const positionFrom = useCallback((clientX: number): number => {
    const element = host.current;
    if (!element) return 0.5;
    const box = element.getBoundingClientRect();
    if (box.width <= 0) return 0.5;
    const ratio = (clientX - box.left) / box.width;
    return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent) => {
      const target = event.currentTarget as HTMLElement | null;
      target?.setPointerCapture?.(event.pointerId);
      onChange(positionFrom(event.clientX));
    },
    [onChange, positionFrom],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      // buttons === 0 means the pointer is hovering, not dragging.
      if (event.buttons === 0) return;
      onChange(positionFrom(event.clientX));
    },
    [onChange, positionFrom],
  );

  const onPointerUp = useCallback((event: PointerEvent) => {
    const target = event.currentTarget as HTMLElement | null;
    target?.releasePointerCapture?.(event.pointerId);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onChange(at - step);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        onChange(at + step);
      } else if (event.key === 'Home') {
        event.preventDefault();
        onChange(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        onChange(1);
      }
    },
    [at, onChange],
  );

  if (!baseUrl || !headUrl) {
    return (
      <div class="canvas empty">swipe needs both sides — this step exists in only one run</div>
    );
  }

  const percent = `${(at * 100).toFixed(3)}%`;

  return (
    <div
      class="canvas swipe"
      ref={host}
      role="slider"
      tabIndex={0}
      aria-label="swipe divider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(at * 100)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <img src={baseUrl} alt="base" draggable={false} />
      <div class="clip" style={`clip-path:inset(0 ${(100 - at * 100).toFixed(3)}% 0 0)`}>
        <img src={headUrl} alt="head" draggable={false} />
      </div>
      <div class="divider" style={`left:${percent}`} />
      {children}
    </div>
  );
}
