import { describe, expect, it } from 'vitest';

import { ScreencastIndex } from './frames.js';
import type { ScreencastFrameEvent } from './events.js';

function frame(
  sha1: string,
  timestamp: number,
  frameSwapWallTime?: number,
  pageId = 'page@1',
): ScreencastFrameEvent {
  const event: ScreencastFrameEvent = {
    type: 'screencast-frame',
    pageId,
    sha1,
    // The event reports the logical viewport; the JPEG behind it is 798x532.
    width: 900,
    height: 600,
    timestamp,
  };
  if (frameSwapWallTime !== undefined) event.frameSwapWallTime = frameSwapWallTime;
  return event;
}

describe('ScreencastIndex', () => {
  it('prefers wall-clock swap time when both the frames and the target carry one', () => {
    const index = new ScreencastIndex();
    index.add(frame('a.jpeg', 10, 1000));
    index.add(frame('b.jpeg', 20, 2000));
    index.add(frame('c.jpeg', 30, 3000));
    const match = index.closest('page@1', { wallTime: 2400, timestamp: 10 });
    expect(match?.frame.sha1).toBe('b.jpeg');
    expect(match?.skewMs).toBe(-400);
  });

  it('falls back to the monotonic timestamp when no swap times were recorded', () => {
    const index = new ScreencastIndex();
    index.add(frame('a.jpeg', 10));
    index.add(frame('b.jpeg', 40));
    const match = index.closest('page@1', { wallTime: 999_999, timestamp: 33 });
    expect(match?.frame.sha1).toBe('b.jpeg');
    expect(match?.skewMs).toBe(7);
  });

  it('chooses a frame recorded after the target when that one is nearer', () => {
    // Measured skews on a real trace ran from -22 ms to +11 ms: the nearest frame is frequently
    // taken after the snapshot it illustrates, and ordering is not a constraint.
    const index = new ScreencastIndex();
    index.add(frame('before.jpeg', 10, 1000));
    index.add(frame('after.jpeg', 20, 1030));
    const match = index.closest('page@1', { wallTime: 1025, timestamp: 15 });
    expect(match?.frame.sha1).toBe('after.jpeg');
    expect(match?.skewMs).toBe(5);
  });

  it('lets several targets resolve to the same frame', () => {
    // Many-to-one is by design: a ten-action trace served seventeen snapshot points from five
    // distinct frames.
    const index = new ScreencastIndex();
    index.add(frame('only.jpeg', 10, 1000));
    const first = index.closest('page@1', { wallTime: 1001, timestamp: 10 });
    const second = index.closest('page@1', { wallTime: 1200, timestamp: 12 });
    expect(first?.frame.sha1).toBe('only.jpeg');
    expect(second?.frame.sha1).toBe('only.jpeg');
  });

  it('resolves an exact tie the way the trace viewer does — to the later frame', () => {
    // Matching Playwright's own `findClosest` matters because the shot we pick is the one a user
    // sees next to the same step in the trace viewer, and that is the only thing they can check.
    const index = new ScreencastIndex();
    index.add(frame('before.jpeg', 10, 1000));
    index.add(frame('after.jpeg', 20, 1020));
    const match = index.closest('page@1', { wallTime: 1010, timestamp: 15 });
    expect(match?.frame.sha1).toBe('after.jpeg');
    expect(match?.skewMs).toBe(10);
  });

  it('keeps pages apart', () => {
    const index = new ScreencastIndex();
    index.add(frame('one.jpeg', 10, 1000, 'page@1'));
    index.add(frame('two.jpeg', 11, 1001, 'page@2'));
    expect(index.closest('page@2', { wallTime: 1000, timestamp: 10 })?.frame.sha1).toBe('two.jpeg');
    expect(index.pageIds).toEqual(['page@1', 'page@2']);
    expect(index.count).toBe(2);
  });

  it('has no answer for a page that recorded no frames', () => {
    const index = new ScreencastIndex();
    index.add(frame('a.jpeg', 10, 1000));
    expect(index.closest('page@absent', { timestamp: 10 })).toBeUndefined();
    expect(index.framesFor('page@absent')).toEqual([]);
  });

  it('sorts frames by timestamp however they arrived', () => {
    const index = new ScreencastIndex();
    index.add(frame('late.jpeg', 90, 9000));
    index.add(frame('early.jpeg', 10, 1000));
    expect(index.framesFor('page@1').map((item) => item.sha1)).toEqual(['early.jpeg', 'late.jpeg']);
    expect(index.all()).toHaveLength(2);
  });

  it('records the viewport the event reported, not an image size', () => {
    const index = new ScreencastIndex();
    index.add(frame('a.jpeg', 10, 1000));
    expect(index.framesFor('page@1')[0]?.viewport).toEqual({ w: 900, h: 600 });
  });
});
