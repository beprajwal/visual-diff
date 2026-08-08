/**
 * Network isolation (spec §11.5): "Record a HAR, replay with real network blocked at the context
 * level; assert zero outbound requests and identical output."
 *
 * Every request the browser makes is recorded in `network.json` with its HAR verdict, so "zero
 * outbound" is checkable rather than asserted: during replay, a request that was not served from
 * the HAR would be a `miss` or a `bypassed`, and there are none — the document included.
 *
 * It also pins the two rules around the HAR that are easy to lose:
 *  - the recorded file is scrubbed (spec §6), because it is committed;
 *  - replay never falls through to the live network (spec §7): an entry that is missing is an
 *    aborted request recorded as a HAR miss, never a silent fetch.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NetworkEntry, RunResult } from '../../src/types.js';
import { paths } from '../../src/store/index.js';
import { runFlow } from '../../src/runner/index.js';

function chromiumAvailable(): boolean {
  try {
    const { chromium } = require('playwright') as typeof import('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const describeIfBrowser = chromiumAvailable() ? describe : describe.skip;

/** Serves the page and one API route that sets a cookie and takes secret headers. */
const SERVER = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
createServer((req, res) => {
  if (req.url && req.url.startsWith('/api/cart')) {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=secret; Path=/' });
    res.end(JSON.stringify({ items: 2, total: '42.00' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>cart</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:24px}</style></head>
<body>
  <h1 data-test="title">Cart</h1>
  <p data-test="total">loading…</p>
  <script>
    fetch('/api/cart', { headers: { authorization: 'Bearer super-secret', 'x-api-key': 'k-1' } })
      .then((r) => r.json())
      .then((data) => {
        document.querySelector('[data-test=total]').textContent = 'total ' + data.total;
      });
  </script>
</body></html>
`;

const CONFIG = `app:
  dev: node server.mjs
  readyOn: http://127.0.0.1:$PORT/
  readyTimeout: 60s
network:
  redact: ["x-api-key"]
`;

const FLOW = `version: 1
flow: cart
viewports: [400x300]
network: { mode: replay, har: cart.har }
steps:
  - id: cart
    goto: /
    waitFor: "[data-test=total]"
    expect:
      - selector: "[data-test=total]"
        text: "total 42.00"
    shoot: true
`;

let root: string;
let recorded: RunResult;
let replayed: RunResult;
/** Requests the browser made while recording — every one of them reached the dev server. */
let requestsWhileRecording = 0;
/** Requests during replay that were NOT served from the HAR, i.e. requests that escaped. */
let requestsThatEscaped = 0;

async function networkLog(run: RunResult, step: string): Promise<NetworkEntry[]> {
  return JSON.parse(
    await readFile(join(run.runDir, 'steps', step, 'network.json'), 'utf8'),
  ) as NetworkEntry[];
}

beforeAll(async () => {
  if (!chromiumAvailable()) return;
  root = await mkdtemp(join(tmpdir(), 'vdiff-network-'));
  await mkdir(paths.flowsDir(root), { recursive: true });
  await writeFile(paths.configFile(root), CONFIG, 'utf8');
  await writeFile(paths.flowFile(root, 'cart'), FLOW, 'utf8');
  await writeFile(join(root, 'server.mjs'), SERVER, 'utf8');
  await writeFile(join(root, 'index.html'), HTML, 'utf8');

  // First run of a flow records (spec §7); the second serves from the HAR.
  recorded = await runFlow({ flow: 'cart', cwd: root });
  requestsWhileRecording = (await networkLog(recorded, 'cart')).length;
  replayed = await runFlow({ flow: 'cart', cwd: root });
  requestsThatEscaped = (await networkLog(replayed, 'cart')).filter(
    (entry) => entry.harMatch !== 'hit',
  ).length;
}, 240_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describeIfBrowser('HAR record', () => {
  it('records on the first run of a flow and writes the committed file', async () => {
    expect(recorded.meta.network).toBe('record');
    expect(recorded.meta.status).toBe('ok');
    expect(requestsWhileRecording).toBeGreaterThan(0);

    const har = await readFile(paths.harFile(root, 'cart.har'), 'utf8');
    expect(har).toContain('/api/cart');
    expect(recorded.meta.warnings.map((warning) => warning.kind)).toContain('har-recorded');
  });

  it('scrubs the recorded HAR: no Authorization, no Set-Cookie, no redacted header (spec §6)', async () => {
    const text = await readFile(paths.harFile(root, 'cart.har'), 'utf8');
    const har = JSON.parse(text) as {
      log: {
        entries: Array<{
          request: { headers: Array<{ name: string }> };
          response: { headers: Array<{ name: string }> };
        }>;
      };
    };

    const headerNames = har.log.entries
      .flatMap((entry) => [...entry.request.headers, ...entry.response.headers])
      .map((header) => header.name.toLowerCase());

    expect(headerNames).not.toContain('authorization');
    expect(headerNames).not.toContain('set-cookie');
    expect(headerNames).not.toContain('cookie');
    // Named in config.network.redact, so it goes too.
    expect(headerNames).not.toContain('x-api-key');
    // The cookie value only ever existed in that Set-Cookie header.
    expect(text).not.toContain('sid=secret');
    // The response body is still there: that is what replay serves.
    expect(text).toContain('42.00');
  });
});

describeIfBrowser('HAR replay', () => {
  it('serves every request from the HAR — zero requests reach the dev server', () => {
    expect(replayed.meta.network).toBe('replay');
    expect(replayed.meta.status).toBe('ok');
    expect(replayed.meta.harHits).toBeGreaterThan(0);
    expect(replayed.meta.harMisses).toBe(0);
    // Every recorded request was a hit: nothing fell through to the live network.
    expect(requestsThatEscaped).toBe(0);
    expect(replayed.meta.warnings.map((warning) => warning.kind)).not.toContain('har-miss');
  });

  it('produces the same page, so a replayed pair is comparable', async () => {
    const [before, after] = await Promise.all([
      readFile(join(recorded.runDir, 'steps/cart/400x300/screenshot.png')),
      readFile(join(replayed.runDir, 'steps/cart/400x300/screenshot.png')),
    ]);
    expect(after.equals(before)).toBe(true);
  });

  it('records the HAR match verdict per request (spec §6 network.json)', async () => {
    const entries = await networkLog(replayed, 'cart');
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((entry) => entry.harMatch))).toEqual(new Set(['hit']));
    expect(entries.some((entry) => entry.url.includes('/api/cart'))).toBe(true);
  });
});
