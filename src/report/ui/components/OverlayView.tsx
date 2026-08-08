/**
 * Overlay (onion-skin) view: the head image fades in over the base image under a slider.
 * `o` toggles it; the slider lives in the focus-pane toolbar.
 */

import type { ComponentChildren } from 'preact';

export interface OverlayViewProps {
  baseUrl: string | null;
  headUrl: string | null;
  /** Head opacity, 0..1. */
  opacity: number;
  /** Region layer, rendered above the head image. */
  children?: ComponentChildren;
}

export function OverlayView({ baseUrl, headUrl, opacity, children }: OverlayViewProps) {
  if (!baseUrl || !headUrl) {
    return (
      <div class="canvas empty">
        overlay needs both sides — this step exists in only one run
      </div>
    );
  }
  return (
    <div class="canvas overlay-stack">
      <img src={baseUrl} alt="base" />
      <div class="over" style={`opacity:${opacity}`}>
        <img src={headUrl} alt="head" />
      </div>
      {children}
    </div>
  );
}
