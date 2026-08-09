#!/usr/bin/env node
/**
 * Record the fixture HAR from the live Open-Meteo API.
 *
 *   npm run fixture:record            (from fixtures/app)
 *   npm run fixture:record -w fixtures/app   (from the repository root)
 *
 * This is the **only** thing in the repository that touches the network, and it is never part of
 * `npm test`. Tests replay `.visual-diff/flows/weather.har`; running them offline, on a plane, or
 * during an Open-Meteo outage must produce exactly the same pixels as running them online. That is
 * the guarantee the whole tool sells, so the recording step is deliberate, manual, and separate.
 *
 * Flags:
 *   --out <file>   write somewhere else (default .visual-diff/flows/weather.har)
 *   --dry-run      fetch and report, write nothing
 *   --json         print the summary as JSON
 *
 * What is written is a HAR 1.2 log, scrubbed the way `src/runner/har.ts` scrubs a recording made by
 * `vdiff run --record`: `Authorization`, `Cookie` and `Set-Cookie` are dropped from both sides of
 * every entry. Open-Meteo sends none of them today — it needs no API key at all — but the scrub is
 * unconditional, because a fixture recorder that only scrubs when it expects to find something is
 * a recorder that leaks the first time an endpoint changes.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_ORIGINS } from '../src/api.js';
import { recordingPlan } from '../src/recording.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = resolve(HERE, '..');
export const DEFAULT_OUT = join(APP_DIR, '.visual-diff', 'flows', 'weather.har');

/** Mirrors `DEFAULTS.alwaysRedactHeaders` in `src/types.ts`. Asserted equal by `tests/har.test.ts`. */
export const ALWAYS_REDACT_HEADERS = ['authorization', 'cookie', 'set-cookie'];

/**
 * Response headers that describe the *transfer*, not the payload.
 *
 * A HAR stores the decoded body in `content.text`. Replaying it while still claiming
 * `content-encoding: gzip` hands the browser a plaintext body it will try to inflate, and a stale
 * `content-length` truncates it. Both fail in ways that look like a corrupt fixture rather than a
 * corrupt header, so they are dropped at record time.
 */
const TRANSFER_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

/** Polite spacing between calls to a free public API. */
const REQUEST_SPACING_MS = 250;

const USER_AGENT = 'visual-diff-fixture-recorder (https://github.com/beprajwal/visual-diff)';

/**
 * Open-Meteo only emits its CORS headers when the request carries an `Origin`, and a replayed
 * response without `access-control-allow-origin` is blocked by the browser — every screen becomes
 * the error state and the recording looks corrupt for a reason nothing in it mentions.
 *
 * The value sent here is arbitrary because the answer is not: the API replies `*`, which is what
 * makes one committed recording valid on every ephemeral dev-server port. `assertUsableResponse`
 * below refuses to write a recording where that stops being true.
 */
const RECORD_ORIGIN = 'http://127.0.0.1';

const CORS_HEADER = 'access-control-allow-origin';

/**
 * Reject a response that would replay differently from how it was recorded.
 *
 * Both checks exist because their failure mode is silent: a wildcard that became an echo would
 * serve on the recorder's origin and nowhere else, and a `vary: origin` would mean the recording is
 * only one of several answers the API gives.
 */
function assertUsableResponse(headers) {
  const allowOrigin = headers.get(CORS_HEADER);
  if (allowOrigin === null) return `response has no ${CORS_HEADER}; the browser would block the replayed response`;
  if (allowOrigin.trim() !== '*') {
    return `${CORS_HEADER} is '${allowOrigin}', not '*'; the recording would only replay on one origin`;
  }
  return null;
}

function sleep(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function headerPairs(headers, { drop }) {
  const pairs = [];
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (drop.has(lower)) continue;
    pairs.push({ name: lower, value });
  }
  pairs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return pairs;
}

function queryString(url) {
  return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
}

/** One HAR entry, in the subset of HAR 1.2 that Playwright's `routeFromHAR` reads. */
export function toHarEntry({ url, status, statusText, headers, body, startedDateTime, timeMs }) {
  const drop = new Set([...ALWAYS_REDACT_HEADERS, ...TRANSFER_HEADERS]);
  const mimeType = headers.get('content-type') ?? 'application/json';
  return {
    startedDateTime,
    time: timeMs,
    request: {
      method: 'GET',
      url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [{ name: 'accept', value: 'application/json' }],
      queryString: queryString(url),
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status,
      statusText,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: headerPairs(headers, { drop }),
      content: {
        size: Buffer.byteLength(body, 'utf8'),
        mimeType,
        text: body,
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: Buffer.byteLength(body, 'utf8'),
    },
    cache: {},
    timings: { send: 0, wait: timeMs, receive: 0 },
  };
}

export async function record({ fetchImpl = globalThis.fetch, plan = recordingPlan(), spacingMs = REQUEST_SPACING_MS } = {}) {
  const entries = [];
  const problems = [];

  for (const [index, item] of plan.entries()) {
    if (index > 0 && spacingMs > 0) await sleep(spacingMs);

    const origin = new URL(item.url).origin;
    if (!API_ORIGINS.includes(origin)) {
      problems.push(`${item.label}: refusing to record '${origin}', which is not an Open-Meteo origin`);
      continue;
    }

    const startedAt = Date.now();
    const startedDateTime = new Date(startedAt).toISOString();
    let response;
    try {
      response = await fetchImpl(item.url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, origin: RECORD_ORIGIN },
      });
    } catch (cause) {
      problems.push(`${item.label}: request failed (${cause instanceof Error ? cause.message : String(cause)})`);
      continue;
    }
    const body = await response.text();
    const timeMs = Date.now() - startedAt;

    if (response.status !== item.expectStatus) {
      problems.push(`${item.label}: expected HTTP ${item.expectStatus}, got ${response.status}`);
      continue;
    }

    const unusable = assertUsableResponse(response.headers);
    if (unusable !== null) {
      problems.push(`${item.label}: ${unusable}`);
      continue;
    }

    try {
      JSON.parse(body);
    } catch {
      problems.push(`${item.label}: response body is not JSON`);
      continue;
    }

    entries.push(
      toHarEntry({
        url: item.url,
        status: response.status,
        statusText: response.statusText || (response.status === 200 ? 'OK' : 'Bad Request'),
        headers: response.headers,
        body,
        startedDateTime,
        timeMs,
      }),
    );
  }

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'visual-diff fixture recorder', version: '1' },
      browser: { name: 'node', version: process.versions.node },
      pages: [],
      entries,
      comment:
        'Recorded from the live Open-Meteo API by fixtures/app/scripts/record-har.mjs. ' +
        'Weather data by Open-Meteo.com, licensed CC-BY-4.0. Re-record with `npm run fixture:record`.',
    },
  };

  return { har, problems, recorded: entries.length, planned: plan.length };
}

/** Drop every always-redacted header from both sides of every entry, in place. */
export function scrub(har) {
  const drop = new Set(ALWAYS_REDACT_HEADERS);
  let removed = 0;
  const prune = (list) => {
    if (!Array.isArray(list)) return;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const name = list[i]?.name;
      if (typeof name === 'string' && drop.has(name.toLowerCase())) {
        list.splice(i, 1);
        removed += 1;
      }
    }
  };
  for (const entry of har.log.entries) {
    prune(entry.request.headers);
    prune(entry.request.cookies);
    prune(entry.response.headers);
    prune(entry.response.cookies);
  }
  return removed;
}

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--out needs a path");
      options.out = isAbsolute(value) ? value : resolve(process.cwd(), value);
      i += 1;
    } else throw new Error(`unknown flag '${arg}'`);
  }
  return options;
}

const USAGE = `Usage: npm run fixture:record [-- options]

  --out <file>   where to write the HAR (default .visual-diff/flows/weather.har)
  --dry-run      fetch and report, write nothing
  --json         print the summary as JSON

Calls the live Open-Meteo API. Never run as part of the test suite.
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const result = await record();
  scrub(result.har);

  const summary = {
    out: options.dryRun ? null : options.out,
    planned: result.planned,
    recorded: result.recorded,
    problems: result.problems,
    recordedAt: new Date().toISOString(),
  };

  if (result.problems.length > 0) {
    for (const problem of result.problems) process.stderr.write(`  FAIL ${problem}\n`);
    process.exitCode = 1;
    if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else process.stderr.write(`recorded nothing: ${result.problems.length} request(s) failed\n`);
    return;
  }

  if (!options.dryRun) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(result.har, null, 2)}\n`, 'utf8');
  }

  if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    process.stdout.write(`recorded ${result.recorded}/${result.planned} requests\n`);
    process.stdout.write(options.dryRun ? 'dry run: nothing written\n' : `wrote ${options.out}\n`);
    process.stdout.write('remember to update the recording date in fixtures/app/README.md\n');
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
