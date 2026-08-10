import { describe, expect, it } from 'vitest';

import { STYLE_PROPS } from '../types.js';
import { fakeJpeg } from './testkit.js';
import { toDomSnapshot, toShotPayload, toShotPayloads, UNAVAILABLE_STYLES } from './to-shots.js';
import type { E2eShot, E2eStep, E2eTest } from './types.js';

function shot(overrides: Partial<E2eShot> = {}): E2eShot {
  return {
    resource: 'resources/page@1-1700000000200.jpeg',
    bytes: fakeJpeg(798, 532),
    encoding: 'jpeg',
    width: 798,
    height: 532,
    viewport: { w: 900, h: 600 },
    scale: 0.8867,
    capturedAt: '2026-08-10T16:39:18.900Z',
    skewMs: -1.5,
    shared: false,
    ...overrides,
  };
}

function step(overrides: Partial<E2eStep> = {}): E2eStep {
  return {
    id: 'open-the-dashboard',
    title: 'open the dashboard',
    index: 0,
    origin: { callId: 'call@8', class: 'Tracing', method: 'tracingGroup', titleSource: 'group' },
    startedAt: '2026-08-10T16:39:18.800Z',
    finishedAt: '2026-08-10T16:39:18.900Z',
    durationMs: 100,
    status: 'ok',
    url: 'http://localhost:3000/',
    shot: shot(),
    dom: {
      name: 'after@call@10',
      url: 'http://localhost:3000/',
      viewport: { w: 900, h: 600 },
      capturedAt: '2026-08-10T16:39:18.890Z',
      nodes: [
        { path: 'html', parent: null, depth: 0, tag: 'html', attrs: {} },
        {
          path: 'html>body>h1',
          parent: 'html>body',
          depth: 2,
          tag: 'h1',
          attrs: { id: 'title', class: 'headline', style: 'color: red', 'data-testid': 'title' },
          testId: 'title',
          text: 'Weather',
        },
      ],
    },
    console: [],
    network: [],
    ...overrides,
  };
}

describe('toShotPayload', () => {
  it('carries the screenshot through as the JPEG the trace stored', () => {
    const payload = toShotPayload(step(), '900x600');
    expect(payload?.step).toBe('open-the-dashboard');
    expect(payload?.viewport).toBe('900x600');
    expect(payload?.screenshotExtension).toBe('jpg');
    expect(payload?.width).toBe(798);
    expect(payload?.height).toBe(532);
    expect(payload?.screenshot).toHaveLength(fakeJpeg(798, 532).length);
  });

  it('reports the image-to-CSS-pixel ratio the diff engine needs', () => {
    // Screencast frames are downscaled to fit an 800x800 box, so this is below 1, not above.
    expect(toShotPayload(step(), '900x600')?.deviceScaleFactor).toBe(0.8867);
  });

  it('has no accessibility tree, because a trace has none', () => {
    expect(toShotPayload(step(), '900x600')?.a11y).toBeNull();
  });

  it('skips a step with no screenshot rather than writing an empty shot', () => {
    expect(toShotPayload(step({ shot: null }), '900x600')).toBeNull();
  });
});

describe('toDomSnapshot', () => {
  it('fills every computed style with the empty string', () => {
    // §4's gap. Empty is the one value that behaves: two e2e runs compare equal and produce no
    // property-level findings, which is exactly the truth about what was captured.
    const dom = toDomSnapshot(step(), '900x600', shot());
    const node = dom.nodes[1];
    expect(Object.keys(node?.styles ?? {})).toEqual([...STYLE_PROPS]);
    expect(Object.values(node?.styles ?? {}).every((value) => value === '')).toBe(true);
    expect(node?.styles).toBe(UNAVAILABLE_STYLES);
  });

  it('produces the same styles for two runs, so no property finding can be manufactured', () => {
    const a = toDomSnapshot(step(), '900x600', shot());
    const b = toDomSnapshot(step({ id: 'other' }), '900x600', shot());
    expect(a.nodes[1]?.styles).toEqual(b.nodes[1]?.styles);
  });

  it('gives every node a zero rect, because a snapshot carries no geometry', () => {
    const dom = toDomSnapshot(step(), '900x600', shot());
    expect(dom.nodes.map((node) => node.rect)).toEqual([
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 0, y: 0, w: 0, h: 0 },
    ]);
    // Each node gets its own object: a shared frozen rect would be mutated by any consumer.
    expect(dom.nodes[0]?.rect).not.toBe(dom.nodes[1]?.rect);
  });

  it('keeps only the attributes the diff engine defines findings over', () => {
    const dom = toDomSnapshot(step(), '900x600', shot());
    expect(dom.nodes[1]?.attrs).toEqual({
      id: 'title',
      class: 'headline',
      'data-testid': 'title',
    });
    expect(dom.nodes[1]?.testId).toBe('title');
    expect(dom.nodes[1]?.text).toBe('Weather');
  });

  it('records the document size, url and node count from the snapshot', () => {
    const dom = toDomSnapshot(step(), '900x600', shot());
    expect(dom.document).toEqual({ w: 900, h: 600 });
    expect(dom.url).toBe('http://localhost:3000/');
    expect(dom.nodeCount).toBe(2);
    expect(dom.truncated).toBe(false);
    expect(dom.masks).toEqual([]);
    expect(dom.capturedAt).toBe('2026-08-10T16:39:18.890Z');
  });

  it('degrades to an empty node list when the trace recorded no DOM snapshots', () => {
    // `tracing.start({ snapshots: false })` is a legitimate configuration; it leaves screenshots.
    const dom = toDomSnapshot(step({ dom: null }), '900x600', shot());
    expect(dom.nodes).toEqual([]);
    expect(dom.nodeCount).toBe(0);
    expect(dom.document).toEqual({ w: 900, h: 600 });
    expect(dom.capturedAt).toBe('2026-08-10T16:39:18.900Z');
  });
});

describe('toShotPayloads', () => {
  const test = (steps: E2eStep[], viewport: string | null): E2eTest => ({
    title: 'weather.spec.ts:12 › weather › shows the forecast',
    titleKey: 'weather.spec.ts › weather › shows the forecast',
    flow: 'weather',
    flowSource: 'derived',
    steps,
    viewport,
    startedAt: '2026-08-10T16:39:18.800Z',
    finishedAt: '2026-08-10T16:39:19.000Z',
  });

  it('converts every step that has a shot, in order', () => {
    const payloads = toShotPayloads(
      test([step(), step({ id: 'run-the-search', index: 1 }), step({ id: 'no-shot', shot: null })], '900x600'),
    );
    expect(payloads.map((payload) => payload.step)).toEqual(['open-the-dashboard', 'run-the-search']);
  });

  it('falls back to the shot viewport when the archive recorded none', () => {
    const payloads = toShotPayloads(test([step()], null));
    expect(payloads[0]?.viewport).toBe('900x600');
  });
});
