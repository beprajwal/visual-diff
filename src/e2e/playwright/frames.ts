/**
 * `e2e/playwright` — screencast frames, and which one belongs to a step.
 *
 * Frames are not per-action. They come from a CDP screencast throttled to about 5 fps, with a
 * 500 ms unthrottle window opened around each call, and a frame is emitted only when the compositor
 * actually swaps — so an action that changes nothing visually produces no frame at all, and several
 * consecutive actions routinely resolve to one image. In a measured ten-action trace, seventeen
 * snapshot points were served by five distinct frames.
 *
 * That has two consequences the rest of e2e mode has to accept rather than work around:
 *
 * 1. **The mapping is many-to-one by design.** `E2eShot.shared` marks it, so the report can say so
 *    instead of presenting a repeated image as a defect.
 * 2. **"Closest" means closest in either direction.** Playwright's own association picks the nearest
 *    frame by wall-clock swap time regardless of ordering, and measured skews run from -22 ms to
 *    +11 ms — the chosen frame is frequently *after* the snapshot it illustrates. `E2eShot.skewMs`
 *    records it rather than hiding it, because this, and not pixel noise, is where e2e alignment
 *    error comes from.
 *
 * The association below is deliberately identical to `SnapshotRenderer.closestScreenshot`: matching
 * Playwright's choice means our shot is the one its trace viewer shows for the same step, which is
 * the only thing a user can check us against.
 */

import type { ScreencastFrameEvent } from './events.js';
import type { Size } from '../../types.js';

export interface ScreencastFrame {
  pageId: string;
  /** Entry name of the JPEG inside the archive, once prefixed with `resources/`. */
  sha1: string;
  /** The logical viewport — see `../jpeg.ts` for why this is not the image size. */
  viewport: Size;
  /** Monotonic milliseconds. */
  timestamp: number;
  /** Epoch milliseconds of the compositor swap, when the recorder provided one. */
  frameSwapWallTime?: number;
}

/** A time to look up a frame for: a snapshot's, or an action's end. */
export interface FrameTarget {
  /** Epoch milliseconds, preferred when the frames carry swap times. */
  wallTime?: number;
  /** Monotonic milliseconds, the fallback. */
  timestamp: number;
}

export interface FrameMatch {
  frame: ScreencastFrame;
  /** Chosen frame's time minus the target's, in milliseconds. Negative: the frame came first. */
  skewMs: number;
}

export class ScreencastIndex {
  private readonly byPage = new Map<string, ScreencastFrame[]>();
  private sorted = false;

  add(event: ScreencastFrameEvent): void {
    const frame: ScreencastFrame = {
      pageId: event.pageId,
      sha1: event.sha1,
      viewport: { w: event.width, h: event.height },
      timestamp: event.timestamp,
    };
    if (event.frameSwapWallTime !== undefined) frame.frameSwapWallTime = event.frameSwapWallTime;
    const frames = this.byPage.get(event.pageId);
    if (frames === undefined) this.byPage.set(event.pageId, [frame]);
    else frames.push(frame);
    this.sorted = false;
  }

  get pageIds(): string[] {
    return [...this.byPage.keys()];
  }

  get count(): number {
    let total = 0;
    for (const frames of this.byPage.values()) total += frames.length;
    return total;
  }

  framesFor(pageId: string): readonly ScreencastFrame[] {
    this.ensureSorted();
    return this.byPage.get(pageId) ?? [];
  }

  /** Every frame in the archive, whichever page it came from. */
  all(): ScreencastFrame[] {
    this.ensureSorted();
    return [...this.byPage.values()].flat();
  }

  /**
   * The frame nearest the target, by swap wall time when available and by monotonic timestamp
   * otherwise — the same two-key rule Playwright applies, including its preference test.
   */
  closest(pageId: string, target: FrameTarget): FrameMatch | undefined {
    const frames = this.framesFor(pageId);
    if (frames.length === 0) return undefined;
    const useWallTime = target.wallTime !== undefined && frames[0]?.frameSwapWallTime !== undefined;
    const metric = (frame: ScreencastFrame): number =>
      useWallTime ? (frame.frameSwapWallTime as number) : frame.timestamp;
    const goal = useWallTime ? (target.wallTime as number) : target.timestamp;

    // Playwright's `findClosest`, verbatim in behaviour: walk in order and stop at the first frame
    // strictly nearer than its successor, taking the last frame if none is. Written this way rather
    // than as a plain minimum so that an exact tie resolves the way the trace viewer resolves it.
    let best = frames[frames.length - 1] as ScreencastFrame;
    for (let index = 0; index < frames.length - 1; index += 1) {
      const frame = frames[index] as ScreencastFrame;
      const next = frames[index + 1] as ScreencastFrame;
      if (Math.abs(metric(frame) - goal) < Math.abs(metric(next) - goal)) {
        best = frame;
        break;
      }
    }
    return { frame: best, skewMs: round3(metric(best) - goal) };
  }

  private ensureSorted(): void {
    if (this.sorted) return;
    for (const frames of this.byPage.values()) frames.sort((a, b) => a.timestamp - b.timestamp);
    this.sorted = true;
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
