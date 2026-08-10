import { describe, expect, it } from 'vitest';

import { isE2eError } from '../errors.js';
import { discoverTracePrefixes, parseNetworkEvents, parseTraceEvents } from './parse.js';

const FILE = '/tmp/traces/checkout.zip';

describe('discoverTracePrefixes', () => {
  it('finds the single prefix of a library archive', () => {
    expect(
      discoverTracePrefixes(['trace.trace', 'trace.network', 'trace.stacks', 'resources/a.jpeg']),
    ).toEqual(['trace']);
  });

  it('finds every context prefix of a runner archive, plus the runner trace itself', () => {
    // A runner archive has one numbered prefix per BrowserContext and a `test.trace` with no
    // .network or .stacks sibling at all.
    expect(
      discoverTracePrefixes([
        'resources/src@abc.txt',
        'test.trace',
        '1-trace.trace',
        '1-trace.network',
        '1-trace.stacks',
        '0-trace.trace',
        '0-trace.network',
        '0-trace.stacks',
        'resources/page@x-1.jpeg',
      ]),
    ).toEqual(['0-trace', '1-trace', 'test']);
  });

  it('orders numbered prefixes numerically, not lexically', () => {
    const names = ['10-trace.trace', '2-trace.trace', '1-trace.trace', 'test.trace'];
    expect(discoverTracePrefixes(names)).toEqual(['1-trace', '2-trace', '10-trace', 'test']);
  });

  it('ignores entries inside directories', () => {
    expect(discoverTracePrefixes(['resources/nested.trace', 'trace.trace'])).toEqual(['trace']);
  });

  it('returns nothing for an archive with no trace entry', () => {
    expect(discoverTracePrefixes(['README.md', 'resources/a.jpeg'])).toEqual([]);
  });
});

describe('parseTraceEvents', () => {
  it('parses one event per line and skips blank ones', () => {
    const text = '{"type":"context-options","version":8}\n\n{"type":"before","callId":"call@1"}\n';
    const events = parseTraceEvents(FILE, 'trace.trace', text);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('context-options');
  });

  it('returns nothing for the zero-byte file a snapshot-less trace writes', () => {
    expect(parseTraceEvents(FILE, 'trace.network', '')).toEqual([]);
  });

  it('keeps events of a type this build does not model', () => {
    const events = parseTraceEvents(FILE, 'trace.trace', '{"type":"invented-later","x":1}');
    expect(events[0]?.type).toBe('invented-later');
  });

  it('names the entry and line when a line is not JSON', () => {
    const text = '{"type":"context-options"}\nnot json at all\n';
    const error = catchError(() => parseTraceEvents(FILE, 'trace.trace', text));
    expect(error.message).toBe(
      `corrupt trace archive: ${FILE} (trace.trace line 2 is not valid JSON)`,
    );
    expect(error.code).toBe('e2e-trace-corrupt');
    expect(error.exitCode).toBe(2);
  });

  it('rejects a line that is valid JSON but not an event object', () => {
    const error = catchError(() => parseTraceEvents(FILE, 'trace.trace', '[1,2,3]'));
    expect(error.message).toBe(
      `corrupt trace archive: ${FILE} (trace.trace line 1 is not a trace event object)`,
    );
  });

  it('rejects an object with no type', () => {
    const error = catchError(() => parseTraceEvents(FILE, '0-trace.trace', '{"callId":"call@1"}'));
    expect(error.message).toBe(
      `corrupt trace archive: ${FILE} (0-trace.trace line 1 has no 'type': it is not a trace event)`,
    );
  });
});

describe('parseNetworkEvents', () => {
  it('keeps resource snapshots and ignores anything else', () => {
    const text = [
      '{"type":"resource-snapshot","snapshot":{"request":{"url":"http://x/"}}}',
      '{"type":"resource-snapshot"}',
      '{"type":"something-else"}',
    ].join('\n');
    const entries = parseNetworkEvents(FILE, 'trace.network', text);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.snapshot.request?.url).toBe('http://x/');
  });

  it('is empty for the zero-byte file `snapshots: false` produces', () => {
    // Network is gated on DOM snapshots: there is no way to record one without the other.
    expect(parseNetworkEvents(FILE, 'trace.network', '')).toEqual([]);
  });
});

function catchError(fn: () => unknown): { message: string; code: string; exitCode: number } {
  try {
    fn();
  } catch (error) {
    if (isE2eError(error)) return error;
    throw error;
  }
  throw new Error('expected the parse to throw');
}
