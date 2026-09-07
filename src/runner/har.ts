/**
 * HAR handling (spec §6 "Git boundary", §7 "Network", D9).
 *
 * HAR files are committed for cross-machine determinism, so they are scrubbed on record:
 * `Authorization`, `Cookie` and `Set-Cookie` are always dropped, along with any header, cookie or
 * query field named in `network.redact`. Writing an unscrubbed HAR requires an explicit
 * `--no-scrub`, which is why scrubbing is the default path and the flag only skips this call.
 */

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

import { DEFAULTS } from '../types.js';

/** Placeholder left in place of a redacted value, so the shape of the request survives. */
export const REDACTED = '__REDACTED__';

export interface ScrubOptions {
  /** Extra header/cookie/query names to redact, from `config.network.redact`. */
  redact?: readonly string[];
  /**
   * Literal values to redact wherever they appear — URLs, query strings, post bodies, response
   * bodies. The resolved `${VAR}` values a flow typed into a form (auth spec §3): a login body is
   * exactly what a recorded HAR would otherwise commit. Empty strings are ignored.
   */
  values?: readonly string[];
}

export interface ScrubResult {
  har: string;
  /** Number of values replaced. */
  redacted: number;
}

interface NameValue {
  name?: unknown;
  value?: unknown;
}

function namesToRedact(options: ScrubOptions): Set<string> {
  const set = new Set<string>(DEFAULTS.alwaysRedactHeaders.map((name) => name.toLowerCase()));
  for (const name of options.redact ?? []) set.add(name.toLowerCase());
  return set;
}

function scrubList(list: unknown, names: Set<string>, drop: boolean): number {
  if (!Array.isArray(list)) return 0;
  let count = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i] as NameValue | undefined;
    if (entry === undefined || typeof entry.name !== 'string') continue;
    if (!names.has(entry.name.toLowerCase())) continue;
    if (drop) list.splice(i, 1);
    else entry.value = REDACTED;
    count += 1;
  }
  return count;
}

/**
 * Scrub a parsed HAR in place. Headers and cookies named in the redact set are removed outright
 * (leaving a placeholder header would still leak its presence-shaped metadata into the repo);
 * query and post parameters keep their name with a `__REDACTED__` value, because a missing query
 * parameter changes the request identity that replay matches on.
 */
export function scrubHarObject(har: unknown, options: ScrubOptions = {}): number {
  const names = namesToRedact(options);
  const values = (options.values ?? []).filter((value) => value !== '');
  let redacted = 0;
  const log = (har as { log?: { entries?: unknown } } | undefined)?.log;
  const entries = log?.entries;
  if (!Array.isArray(entries)) return 0;

  for (const entry of entries) {
    const record = entry as {
      request?: { headers?: unknown; cookies?: unknown; queryString?: unknown; postData?: unknown };
      response?: { headers?: unknown; cookies?: unknown };
    };
    if (record.request !== undefined) {
      redacted += scrubList(record.request.headers, names, true);
      redacted += scrubList(record.request.cookies, names, true);
      redacted += scrubList(record.request.queryString, names, false);
      const postData = record.request.postData as { params?: unknown } | undefined;
      if (postData !== undefined) redacted += scrubList(postData.params, names, false);
    }
    if (record.response !== undefined) {
      redacted += scrubList(record.response.headers, names, true);
      redacted += scrubList(record.response.cookies, names, true);
    }
    if (values.length > 0) redacted += scrubValues(entry as Record<string, unknown>, values);
  }
  return redacted;
}

/**
 * Replace every occurrence of a secret value in the places a request or response can carry it.
 * Counted per field, not per occurrence: the number answers "how many fields held a secret".
 */
function scrubValues(entry: Record<string, unknown>, values: readonly string[]): number {
  let redacted = 0;
  const scrubText = (holder: Record<string, unknown> | undefined, key: string): void => {
    const text = holder?.[key];
    if (typeof text !== 'string') return;
    let next = text;
    for (const value of values) next = next.split(value).join(REDACTED);
    if (next !== text) {
      (holder as Record<string, unknown>)[key] = next;
      redacted += 1;
    }
  };
  const scrubEntries = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) scrubText(item as Record<string, unknown>, 'value');
  };
  const request = entry.request as Record<string, unknown> | undefined;
  const response = entry.response as Record<string, unknown> | undefined;
  scrubText(request, 'url');
  scrubEntries(request?.queryString);
  const postData = request?.postData as Record<string, unknown> | undefined;
  scrubText(postData, 'text');
  scrubEntries(postData?.params);
  scrubText(response?.content as Record<string, unknown> | undefined, 'text');
  return redacted;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;

/** True for a URL served by a dev server on this machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Point a recorded HAR at the origin this run is actually using.
 *
 * A spawned dev server gets a fresh ephemeral port every run (spec §7), and Playwright's
 * `routeFromHAR` matches on the request URL — so a HAR recorded on port A serves *nothing* on port
 * B, every request becomes a HAR miss, and the frozen network D9 promises silently stops working.
 * Rewriting the loopback authority (never the path, never a real host) is what makes a committed
 * HAR portable across runs and across machines, which is the whole reason §6 commits it.
 */
export function retargetHar(source: string, targetOrigin: string): { har: string; rewritten: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { har: source, rewritten: 0 };
  }
  const entries = (parsed as { log?: { entries?: unknown } } | undefined)?.log?.entries;
  if (!Array.isArray(entries)) return { har: source, rewritten: 0 };

  let target: URL;
  try {
    target = new URL(targetOrigin);
  } catch {
    return { har: source, rewritten: 0 };
  }

  let rewritten = 0;
  for (const entry of entries) {
    const request = (entry as { request?: { url?: unknown } }).request;
    if (request === undefined || typeof request.url !== 'string') continue;
    if (!isLoopbackUrl(request.url)) continue;
    const url = new URL(request.url);
    if (url.host === target.host && url.protocol === target.protocol) continue;
    url.protocol = target.protocol;
    url.host = target.host;
    request.url = url.toString();
    rewritten += 1;
  }
  return { har: serializeHar(parsed), rewritten };
}

/** The in-place half of `retargetHar`: rewrite loopback URLs on the parsed object, count them. */
function retargetHarObject(parsed: unknown, targetOrigin: string): number {
  const entries = (parsed as { log?: { entries?: unknown } } | undefined)?.log?.entries;
  if (!Array.isArray(entries)) return 0;
  let target: URL;
  try {
    target = new URL(targetOrigin);
  } catch {
    return 0;
  }
  let rewritten = 0;
  for (const entry of entries) {
    const request = (entry as { request?: { url?: unknown } }).request;
    if (request === undefined || typeof request.url !== 'string') continue;
    if (!isLoopbackUrl(request.url)) continue;
    const url = new URL(request.url);
    if (url.host === target.host && url.protocol === target.protocol) continue;
    url.protocol = target.protocol;
    url.host = target.host;
    request.url = url.toString();
    rewritten += 1;
  }
  return rewritten;
}

/**
 * Write a run-local copy of `file` whose loopback URLs point at `targetOrigin`, and return its
 * path — or the original path when nothing needed rewriting. The committed HAR is never modified.
 */
export async function retargetHarFile(
  file: string,
  targetOrigin: string,
  outFile: string,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return file;
  }
  if (retargetHarObject(parsed, targetOrigin) === 0) return file;
  await writeHarFile(outFile, parsed);
  return outFile;
}

/* ---------------------------------------------------------- recorded responses (mocking §5, §8) */

/**
 * One recorded response, decoded far enough for a scenario `patch` to be applied to it.
 *
 * Playwright's `routeFromHAR` still serves every passthrough request, so this index is *not* a
 * second replay engine: it is consulted only where a `patch`/`patchOps` rule matched and needs the
 * body it is patching. Keeping the two apart is deliberate — replay fidelity stays Playwright's,
 * and a rule that matched a request the recording does not contain fails the run naming the rule
 * (mocking spec §8) rather than quietly inventing a response.
 *
 * The shape is identical to `mocking/response.ts`'s `RecordedResponse`, restated rather than
 * imported so the dependency runs one way — runner → mocking — and the engine stays free of the
 * runner. An index result is handed to the engine with no adapter.
 */
export interface RecordedResponse {
  status: number;
  /** Header names lower-cased, so a lookup never depends on the recorder's casing. */
  headers: Record<string, string>;
  /** Lower-cased media type with parameters stripped, e.g. `application/json`. */
  mediaType: string;
  /** Decoded body text, or `undefined` when the entry recorded no body at all. */
  text: string | undefined;
}

export interface HarIndex {
  /** The first recorded response for this request, or `undefined`. */
  find(method: string, url: string): RecordedResponse | undefined;
  /** Number of indexed entries, so a caller can tell "empty HAR" from "no match". */
  readonly size: number;
}

function mediaTypeOf(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * A second lookup key that survives query-parameter reordering.
 *
 * `?b=2&a=1` and `?a=1&b=2` are the same request to every server and to Playwright's own HAR
 * matcher, but they are different strings — and a `patch` rule silently failing to find its body
 * because a fetch built its query in a different order would fail the run for no real reason.
 */
function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.hash = '';
  const params = [...parsed.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  parsed.search = '';
  for (const [name, value] of params) parsed.searchParams.append(name, value);
  return parsed.toString();
}

function keyOf(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

interface HarContent {
  text?: unknown;
  encoding?: unknown;
  mimeType?: unknown;
}

function decodeContent(content: HarContent | undefined): string | undefined {
  if (content === undefined || typeof content.text !== 'string') return undefined;
  if (content.encoding === 'base64') {
    try {
      return Buffer.from(content.text, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }
  return content.text;
}

function headersOf(list: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!Array.isArray(list)) return headers;
  for (const item of list) {
    const entry = item as NameValue | undefined;
    if (entry === undefined || typeof entry.name !== 'string' || typeof entry.value !== 'string') continue;
    headers[entry.name.toLowerCase()] = entry.value;
  }
  return headers;
}

/**
 * Index a HAR's responses by `(method, url)`.
 *
 * First entry wins for a repeated request. Playwright's replay serves repeats positionally, but
 * this index exists only to hand a patch rule the body it is rewriting, and a positional index
 * would have to be per-viewport and stateful — which is precisely how two concurrent viewports
 * would end up patching different bodies and breaking the determinism guarantee (mocking §10.1).
 */
export function indexHar(source: string): HarIndex {
  const exact = new Map<string, RecordedResponse>();
  const normalized = new Map<string, RecordedResponse>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { find: () => undefined, size: 0 };
  }
  const entries = (parsed as { log?: { entries?: unknown } } | undefined)?.log?.entries;
  if (!Array.isArray(entries)) return { find: () => undefined, size: 0 };

  for (const item of entries) {
    const entry = item as {
      request?: { method?: unknown; url?: unknown };
      response?: { status?: unknown; headers?: unknown; content?: unknown };
    };
    const method = entry.request?.method;
    const url = entry.request?.url;
    const response = entry.response;
    if (typeof method !== 'string' || typeof url !== 'string' || response === undefined) continue;

    const headers = headersOf(response.headers);
    const content = response.content as HarContent | undefined;
    const mimeType = typeof content?.mimeType === 'string' ? content.mimeType : (headers['content-type'] ?? '');
    const recorded: RecordedResponse = {
      status: typeof response.status === 'number' ? response.status : 200,
      headers,
      mediaType: mediaTypeOf(mimeType),
      text: decodeContent(content),
    };

    const key = keyOf(method, url);
    if (!exact.has(key)) exact.set(key, recorded);
    const loose = keyOf(method, normalizeUrl(url));
    if (!normalized.has(loose)) normalized.set(loose, recorded);
  }

  return {
    size: exact.size,
    find(method: string, url: string): RecordedResponse | undefined {
      return exact.get(keyOf(method, url)) ?? normalized.get(keyOf(method, normalizeUrl(url)));
    },
  };
}

/** Index the responses in a HAR file. A file that cannot be read indexes as empty, never throws. */
export async function indexHarFile(file: string): Promise<HarIndex> {
  try {
    return indexHar(await readFile(file, 'utf8'));
  } catch {
    return { find: () => undefined, size: 0 };
  }
}

export function scrubHar(source: string, options: ScrubOptions = {}): ScrubResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // A HAR we cannot parse is a HAR we cannot promise is clean: refuse to rewrite it.
    return { har: source, redacted: 0 };
  }
  const redacted = scrubHarObject(parsed, options);
  return { har: serializeHar(parsed), redacted };
}

/**
 * A HAR as one compact line per entry — no indentation, because a recording is read by
 * `routeFromHAR` and never by a person, and pretty-printing a 400 MB recording doubles the string
 * the serializer has to hold. `writeHarFile` is the streaming form of the same layout.
 */
export function serializeHar(parsed: unknown): string {
  const chunks: string[] = [];
  for (const chunk of harChunks(parsed)) chunks.push(chunk);
  return chunks.join('');
}

/**
 * The HAR document as a sequence of strings, entries one at a time. What lets a recording bigger
 * than the JS heap has room for as a single string still be written: nothing here ever holds more
 * than one entry's JSON at once, on top of the parsed object itself.
 */
function* harChunks(parsed: unknown): Generator<string> {
  const doc = parsed as { log?: Record<string, unknown> } | null;
  const log = doc?.log;
  const entries = log?.['entries'];
  if (doc === null || typeof doc !== 'object' || log === undefined || !Array.isArray(entries)) {
    yield `${JSON.stringify(parsed)}\n`;
    return;
  }
  yield '{';
  let first = true;
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'log') continue;
    yield `${first ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(value)}`;
    first = false;
  }
  yield `${first ? '' : ','}"log":{`;
  let firstLogKey = true;
  for (const [key, value] of Object.entries(log)) {
    if (key === 'entries') continue;
    yield `${firstLogKey ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(value)}`;
    firstLogKey = false;
  }
  yield `${firstLogKey ? '' : ','}"entries":[`;
  for (let index = 0; index < entries.length; index += 1) {
    yield `${index === 0 ? '' : ','}${JSON.stringify(entries[index])}`;
  }
  yield ']}}\n';
}

/** Stream a parsed HAR to `file`, entry by entry, honouring backpressure. */
export async function writeHarFile(file: string, parsed: unknown): Promise<void> {
  const stream = createWriteStream(file, { encoding: 'utf8' });
  try {
    for (const chunk of harChunks(parsed)) {
      if (!stream.write(chunk)) await once(stream, 'drain');
    }
    stream.end();
    await finished(stream);
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

/** Scrub a HAR that Playwright just wrote. Returns the number of redacted values. */
export async function scrubHarFile(file: string, options: ScrubOptions = {}): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // Missing, or a HAR we cannot parse — and one we cannot promise is clean: leave it be.
    return 0;
  }
  const redacted = scrubHarObject(parsed, options);
  // Rewritten even when nothing was redacted: Playwright's pretty-printed file becomes the compact
  // layout every later read expects, and the write is the same streaming path either way.
  await writeHarFile(file, parsed);
  return redacted;
}
