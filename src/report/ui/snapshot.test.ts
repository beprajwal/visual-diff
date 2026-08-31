/**
 * The snapshot client is the exported page's stand-in for the report API (CI spec D38). What is
 * pinned here is the contract the App relies on: the one embedded pair is answerable, everything
 * else refuses with a sentence rather than a fetch, and `blob()` resolves through the image map.
 */

import { describe, expect, it } from 'vitest';

import { makeDiff } from './test-fixtures.js';
import { createSnapshotClient, type ReportSnapshot } from './snapshot.js';

function fixtureSnapshot(): ReportSnapshot {
  const diff = makeDiff({});
  return {
    flow: diff.flow,
    base: diff.pair.base,
    head: diff.pair.head,
    diff,
    runs: [],
    images: {
      'runs/checkout/0003/steps/pay-form/1280x800/screenshot.png': 'images/pay-form/1280x800/base.png',
    },
    version: '0.7.0',
    generatedAt: '2026-08-31T00:00:00.000Z',
  };
}

describe('createSnapshotClient', () => {
  it('serves the embedded flow, runs and pair, and only those', async () => {
    const snapshot = fixtureSnapshot();
    const client = createSnapshotClient(snapshot);

    const flows = await client.flows();
    expect(flows.flows).toEqual([{ name: snapshot.flow, runs: 0, latest: snapshot.head }]);
    await expect(client.runs(snapshot.flow)).resolves.toEqual({ flow: snapshot.flow, runs: [] });
    await expect(client.diff(snapshot.flow, snapshot.base, snapshot.head)).resolves.toBe(
      snapshot.diff,
    );

    await expect(client.runs('other')).rejects.toThrow(/not in this bundle/);
    await expect(client.diff(snapshot.flow, snapshot.head, snapshot.head)).rejects.toThrow(
      /only .* is in this bundle/,
    );
  });

  it('resolves blobs through the image map, and passes unknown paths through untouched', () => {
    const client = createSnapshotClient(fixtureSnapshot());
    expect(client.blob('runs/checkout/0003/steps/pay-form/1280x800/screenshot.png')).toBe(
      'images/pay-form/1280x800/base.png',
    );
    expect(client.blob('runs/checkout/0009/steps/gone/800x600/screenshot.png')).toBe(
      'runs/checkout/0009/steps/gone/800x600/screenshot.png',
    );
  });

  it('refuses feedback with a sentence that names the live report', async () => {
    const client = createSnapshotClient(fixtureSnapshot());
    await expect(
      client.postFeedback({ flow: 'checkout', pair: '0003..0007', text: 'nope' }),
    ).rejects.toThrow(/vdiff serve/);
  });

  it('has no live channel: subscribe is a no-op that still returns an unsubscriber', () => {
    const client = createSnapshotClient(fixtureSnapshot());
    const unsubscribe = client.subscribe({ onEvent: () => undefined });
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    expect(client.token).toBeNull();
  });
});
