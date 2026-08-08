/**
 * Report server contract (spec §11.7): "API contract, SSE delivery on new run, feedback append."
 *
 * The server is started for real, over a real store on disk written by the store's own fixture
 * writer, and driven over HTTP — no route handler is called directly. That is the point: the seams
 * between store, diff engine and server are what this test is protecting, and every one of them is
 * exercised through the same interface the browser uses.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  Config,
  DiffResponse,
  DiffResult,
  FeedbackEntry,
  FlowsResponse,
  RunsResponse,
} from '../../src/types.js';
import { DEFAULTS, DIFF_ENGINE_VERSION } from '../../src/types.js';
import { openStore, paths } from '../../src/store/index.js';
import { writeFixtureRun } from '../../src/store/fixtures.js';
import { serveReport } from '../../src/report/index.js';
import type { ReportServer } from '../../src/report/index.js';

let root: string;
let server: ReportServer;
let base: string;
let token: string;

function configFor(projectRoot: string): Config {
  return {
    root: projectRoot,
    dir: paths.vdiffDir(projectRoot),
    app: {
      dev: 'node -e ""',
      readyOn: 'http://127.0.0.1:$PORT/',
      readyTimeoutMs: DEFAULTS.readyTimeoutMs,
    },
    diff: {
      minRegionArea: DEFAULTS.diff.minRegionArea,
      maxRegions: DEFAULTS.diff.maxRegions,
      antialiasTolerance: DEFAULTS.diff.antialiasTolerance,
      ignore: [],
    },
    network: { redact: [], scrub: true },
    retention: { keepRuns: DEFAULTS.retention.keepRuns },
  };
}

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as T };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vdiff-report-api-'));
  await mkdir(paths.flowsDir(root), { recursive: true });
  await writeFile(paths.flowFile(root, 'checkout'), 'version: 1\nflow: checkout\n', 'utf8');

  await writeFixtureRun({ root, flow: 'checkout', steps: [{ id: 'cart' }, { id: 'pay-form' }] });
  await writeFixtureRun({ root, flow: 'checkout', steps: [{ id: 'cart' }, { id: 'pay-form' }] });

  server = await serveReport(configFor(root), {});
  base = `http://127.0.0.1:${server.info.port}`;
  token = server.info.token;
});

afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

describe('the session token gate (spec §9)', () => {
  it('refuses a request with no token', async () => {
    const response = await fetch(`${base}/api/flows`);
    expect(response.status).toBe(401);
  });

  it('refuses a request with the wrong token', async () => {
    const response = await fetch(`${base}/api/flows?token=not-the-token`);
    expect([401, 403]).toContain(response.status);
  });

  it('writes serve.json with the url and the token', async () => {
    const info = JSON.parse(await readFile(paths.serveInfoFile(root), 'utf8')) as {
      url: string;
      token: string;
      port: number;
    };
    expect(info.token).toBe(token);
    expect(info.url).toContain(`127.0.0.1:${server.info.port}`);
    expect(info.url).toContain('token=');
  });
});

describe('GET /api/flows', () => {
  it('lists flows with their run counts', async () => {
    const { status, body } = await api<FlowsResponse>('/api/flows');
    expect(status).toBe(200);
    expect(body.flows).toEqual([{ name: 'checkout', runs: 2, latest: '0001' }]);
  });
});

describe('GET /api/runs/:flow', () => {
  it('returns the timeline, oldest first', async () => {
    const { status, body } = await api<RunsResponse>('/api/runs/checkout');
    expect(status).toBe(200);
    expect(body.flow).toBe('checkout');
    expect(body.runs.map((run) => run.runId)).toEqual(['0000', '0001']);
    expect(body.runs[0]).toMatchObject({ flow: 'checkout', pinned: false, pruned: false });
  });

  it('404s an unknown flow rather than inventing an empty one', async () => {
    const { status } = await api('/api/runs/nope');
    expect(status).toBe(404);
  });
});

describe('GET /api/diff/:base..:head', () => {
  it('computes the pair on demand and caches it in the store', async () => {
    const { status, body } = await api<DiffResponse>('/api/diff/0000..0001?flow=checkout');
    expect(status).toBe(200);
    const result = body as DiffResult;
    expect(result.engineVersion).toBe(DIFF_ENGINE_VERSION);
    expect(result.pair).toEqual({ base: '0000', head: '0001' });
    // Two identical fixture runs: the structural diff matches every step and nothing changed.
    expect(result.flowDiff.map((entry) => entry.status)).toEqual(['matched', 'matched']);
    expect(result.summary.totalFindings).toBe(0);

    const stored = await openStore(configFor(root)).readDiff({
      flow: 'checkout',
      base: '0000',
      head: '0001',
    });
    expect(stored?.pair).toEqual({ base: '0000', head: '0001' });
  });

  it('rejects a malformed pair', async () => {
    const { status } = await api('/api/diff/0000?flow=checkout');
    expect(status).toBe(400);
  });
});

describe('blobs', () => {
  it('serves a screenshot from the store', async () => {
    const response = await fetch(
      `${base}/api/blob/runs/checkout/0000/steps/cart/1280x800/screenshot.png?token=${token}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('refuses to escape the store', async () => {
    const response = await fetch(`${base}/api/blob/..%2F..%2Fetc%2Fpasswd?token=${token}`);
    expect([400, 403, 404]).toContain(response.status);
  });
});

describe('POST /api/feedback', () => {
  it('appends one line to feedback/pending.jsonl and returns the stored entry', async () => {
    const { status, body } = await api<FeedbackEntry>('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flow: 'checkout',
        pair: '0000..0001',
        step: 'pay-form',
        viewport: '1280x800',
        findingId: 'f1',
        element: '[data-test=pay]',
        region: { x: 6, y: 56, w: 86, h: 19 },
        text: 'padding is too tight',
      }),
    });

    // 201 Created: the append is a new resource in feedback/pending.jsonl.
    expect(status).toBe(201);
    expect(body).toMatchObject({
      flow: 'checkout',
      pair: '0000..0001',
      step: 'pay-form',
      text: 'padding is too tight',
      status: 'pending',
    });
    expect(body.id).toMatch(/^fb_/);

    const lines = (await readFile(paths.feedbackPendingFile(root), 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] as string) as FeedbackEntry).text).toBe('padding is too tight');
  });

  it('rejects a body that is not a feedback entry', async () => {
    const { status } = await api('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(status).toBe(400);
  });
});

describe('GET /api/events (SSE)', () => {
  it('delivers a hello frame and then a run announcement', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events?token=${token}`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = '';

    const readUntil = async (predicate: (text: string) => boolean): Promise<string> => {
      const deadline = Date.now() + 10_000;
      while (!predicate(buffered) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
      }
      return buffered;
    };

    await readUntil((text) => text.includes('hello'));
    expect(buffered).toContain('hello');

    // The watcher fires on a completed run; emitting through the hub is the same code path the
    // watcher uses, and keeps the test off filesystem-event timing.
    const runs = await api<RunsResponse>('/api/runs/checkout');
    const announced = { ...(runs.body.runs[0] as RunsResponse['runs'][number]), runId: '0002' };
    server.emit({ type: 'run', ts: new Date().toISOString(), flow: 'checkout', run: announced });
    await readUntil((text) => text.includes('0002'));
    expect(buffered).toContain('"runId":"0002"');

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});
