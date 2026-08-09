import { describe, expect, it, vi } from 'vitest';

import { ApiError, createClient, readToken } from './client.js';

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
  } as unknown as Response;
}

function recorder(body: unknown = {}, init?: { status?: number; statusText?: string }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(input), init: requestInit });
    return jsonResponse(body, init ?? {});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('readToken', () => {
  it('prefers the token in the query string', () => {
    expect(readToken('?token=abc123')).toBe('abc123');
  });

  it('returns null when the URL has no token and nothing was remembered', () => {
    try {
      globalThis.sessionStorage?.clear();
    } catch {
      // No storage in this environment; the fallback path is what is under test anyway.
    }
    expect(readToken('')).toBeNull();
    expect(readToken('?other=1')).toBeNull();
  });
});

describe('createClient', () => {
  it('attaches the session token to every request', async () => {
    const { calls, fetchImpl } = recorder({ flows: [] });
    const client = createClient({ token: 'tok', fetchImpl });

    await client.flows();
    await client.runs('checkout');
    await client.diff('checkout', '0003', '0007');

    expect(calls.map((c) => c.url)).toEqual([
      '/api/flows?token=tok',
      '/api/runs/checkout?token=tok',
      '/api/diff/0003..0007?flow=checkout&token=tok',
    ]);
  });

  it('omits the token parameter entirely when there is none', async () => {
    const { calls, fetchImpl } = recorder({ flows: [] });
    await createClient({ token: null, fetchImpl }).flows();
    expect(calls[0]?.url).toBe('/api/flows');
  });

  it('escapes flow names in the path', async () => {
    const { calls, fetchImpl } = recorder({ flow: 'a b', runs: [] });
    await createClient({ token: null, fetchImpl }).runs('a b');
    expect(calls[0]?.url).toBe('/api/runs/a%20b');
  });

  it('posts feedback as JSON and returns the stored entry', async () => {
    const entry = {
      id: 'fb_01',
      ts: '2026-08-08T10:12:00Z',
      flow: 'checkout',
      pair: '0003..0007',
      text: 'too tight',
      status: 'pending' as const,
    };
    const { calls, fetchImpl } = recorder(entry);
    const result = await createClient({ token: 'tok', fetchImpl }).postFeedback({
      flow: 'checkout',
      pair: '0003..0007',
      step: 'pay-form',
      text: 'too tight',
    });

    expect(result).toEqual(entry);
    const call = calls[0];
    expect(call?.url).toBe('/api/feedback?token=tok');
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      flow: 'checkout',
      pair: '0003..0007',
      step: 'pay-form',
      text: 'too tight',
    });
  });

  it('raises ApiError carrying the status and the server message', async () => {
    const { fetchImpl } = recorder({ message: 'bad token' }, { status: 401, statusText: 'no' });
    await expect(createClient({ token: 'x', fetchImpl }).flows()).rejects.toBeInstanceOf(ApiError);
    await expect(createClient({ token: 'x', fetchImpl }).flows()).rejects.toThrow('bad token');
  });

  it('falls back to the status line when the error body has no message', async () => {
    const { fetchImpl } = recorder(null, { status: 500, statusText: 'Server Error' });
    await expect(createClient({ token: null, fetchImpl }).flows()).rejects.toThrow(
      '500 Server Error',
    );
  });

  it('returns the pruned-pair backfill payload rather than throwing', async () => {
    const backfill = {
      error: 'pruned',
      message: 'run 0003 was pruned',
      backfill: ['vdiff run checkout --at 9f8e7d6'],
    };
    const { fetchImpl } = recorder(backfill);
    const result = await createClient({ token: null, fetchImpl }).diff('checkout', '0003', '0007');
    expect(result).toEqual(backfill);
  });

  it('builds token-bearing blob urls', () => {
    const client = createClient({ token: 'tok', fetchImpl: recorder().fetchImpl });
    expect(client.blob('runs/checkout/0007/steps/pay/1280x800/screenshot.png')).toBe(
      '/api/blob/runs/checkout/0007/steps/pay/1280x800/screenshot.png?token=tok',
    );
  });
});

describe('subscribe', () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;

    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }

    close(): void {
      this.closed = true;
      this.readyState = 2;
    }
  }

  it('opens the events route with the token and forwards parsed events', () => {
    FakeEventSource.instances = [];
    const events: unknown[] = [];
    let opened = false;

    const client = createClient({
      token: 'tok',
      fetchImpl: recorder().fetchImpl,
      eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    });
    const unsubscribe = client.subscribe({
      onEvent: (e) => events.push(e),
      onOpen: () => {
        opened = true;
      },
    });

    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe('/api/events?token=tok');

    source?.onopen?.();
    expect(opened).toBe(true);

    source?.onmessage?.({ data: '{"type":"hello","ts":"now","flows":["checkout"]}' } as MessageEvent);
    expect(events).toEqual([{ type: 'hello', ts: 'now', flows: ['checkout'] }]);

    // A malformed frame is dropped rather than tearing the channel down.
    source?.onmessage?.({ data: 'not json' } as MessageEvent);
    expect(events).toHaveLength(1);

    unsubscribe();
    expect(source?.closed).toBe(true);
  });

  it('reports the drop and does not reconnect after unsubscribing', () => {
    vi.useFakeTimers();
    try {
      FakeEventSource.instances = [];
      let closes = 0;
      const client = createClient({
        token: null,
        fetchImpl: recorder().fetchImpl,
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      });
      const unsubscribe = client.subscribe({
        onEvent: () => undefined,
        onClose: () => {
          closes += 1;
        },
      });

      const source = FakeEventSource.instances[0];
      if (source) source.readyState = 2;
      source?.onerror?.();
      expect(closes).toBe(1);

      unsubscribe();
      vi.advanceTimersByTime(10_000);
      // The pending reconnect was cancelled; only the original source was ever created.
      expect(FakeEventSource.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createClient — attribution (mocking §8)', () => {
  it('requests /api/attribution/<flow>/<runId> with the session token', async () => {
    const { calls, fetchImpl } = recorder({
      flow: 'forecast',
      runId: '0007',
      scenario: 'empty-forecast',
      steps: [],
    });
    const client = createClient({ token: 'tok', fetchImpl });

    const attribution = await client.attribution('forecast', '0007');

    expect(calls[0]?.url).toBe('/api/attribution/forecast/0007?token=tok');
    expect(attribution.scenario).toBe('empty-forecast');
  });

  it('encodes a flow name that needs it', async () => {
    const { calls, fetchImpl } = recorder({ flow: 'a b', runId: '0007', scenario: 'none', steps: [] });
    await createClient({ token: null, fetchImpl }).attribution('a b', '0007');
    expect(calls[0]?.url).toBe('/api/attribution/a%20b/0007');
  });

  it('surfaces a 404 as an ApiError carrying the server message', async () => {
    const { fetchImpl } = recorder(
      { error: 'unknown-run', message: 'No run 0099 in flow "forecast".' },
      { status: 404, statusText: 'Not Found' },
    );
    const client = createClient({ token: 'tok', fetchImpl });

    await expect(client.attribution('forecast', '0099')).rejects.toBeInstanceOf(ApiError);
    await expect(client.attribution('forecast', '0099')).rejects.toThrow(
      'No run 0099 in flow "forecast".',
    );
  });
});
