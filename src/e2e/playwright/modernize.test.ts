import { describe, expect, it } from 'vitest';

import { modernizeEvents } from './modernize.js';
import type { AnyTraceEvent, BeforeActionEvent } from './events.js';

const v7Before = {
  type: 'before',
  callId: 'call@20',
  startTime: 100,
  class: 'Frame',
  method: 'click',
  // Version 7 stores the title here. A reader that only looks at `title` sees nothing.
  apiName: 'Click getByRole(\'button\', { name: \'Fetch\' })',
  params: { selector: 'internal:role=button[name="Fetch"i]' },
} as unknown as AnyTraceEvent;

describe('modernizeEvents', () => {
  it("moves a version 7 action's apiName into title", () => {
    const { events, changed } = modernizeEvents([v7Before], 7);
    const before = events[0] as BeforeActionEvent;
    expect(before.title).toBe("Click getByRole('button', { name: 'Fetch' })");
    expect(changed).toBe(true);
  });

  it('defaults a version 7 stepId to the callId', () => {
    const { events } = modernizeEvents([v7Before], 7);
    expect((events[0] as BeforeActionEvent).stepId).toBe('call@20');
  });

  it('keeps a stepId the archive already carried', () => {
    const withStep = { ...(v7Before as object), stepId: 'test.step@96' } as AnyTraceEvent;
    const { events } = modernizeEvents([withStep], 7);
    expect((events[0] as BeforeActionEvent).stepId).toBe('test.step@96');
  });

  it('prefers an existing title over apiName', () => {
    const both = { ...(v7Before as object), title: 'open the dashboard' } as AnyTraceEvent;
    const { events } = modernizeEvents([both], 7);
    expect((events[0] as BeforeActionEvent).title).toBe('open the dashboard');
  });

  it('leaves a version 8 archive untouched', () => {
    const v8: AnyTraceEvent = {
      type: 'before',
      callId: 'call@20',
      startTime: 100,
      class: 'Frame',
      method: 'click',
      title: 'open the dashboard',
      stepId: 'test.step@96',
    } as BeforeActionEvent;
    const { events, changed } = modernizeEvents([v8], 8);
    expect(changed).toBe(false);
    expect(events[0]).toBe(v8);
  });

  it('passes non-action events through unchanged', () => {
    const events: AnyTraceEvent[] = [
      { type: 'after', callId: 'call@20', endTime: 120 },
      { type: 'screencast-frame', pageId: 'page@1', sha1: 'a.jpeg', width: 900, height: 600, timestamp: 1 },
      { type: 'something-a-newer-version-added', payload: 1 } as AnyTraceEvent,
    ];
    const result = modernizeEvents(events, 7);
    expect(result.events).toEqual(events);
    expect(result.changed).toBe(false);
  });

  it('reports no change when a version 7 action already looks like version 8', () => {
    const already: AnyTraceEvent = {
      type: 'before',
      callId: 'call@20',
      startTime: 1,
      class: 'Frame',
      method: 'goto',
      title: 'go',
      stepId: 'call@20',
    } as BeforeActionEvent;
    expect(modernizeEvents([already], 7).changed).toBe(false);
  });
});
