/**
 * The two response values the overlay engine deals in (mocking spec §5).
 *
 * They are deliberately asymmetric, because the two directions are not symmetric:
 *
 * - {@link RecordedResponse} is what the *recording* holds. It is always decoded text, because the
 *   only reason the engine ever reads a recorded body is to patch it, and `patch`/`patchOps` are
 *   valid against JSON content types alone (§5). Its shape mirrors `runner/har.ts` exactly so the
 *   runner hands its index's result straight to the engine with no adapter and no import from the
 *   runner into this module — the dependency runs one way, runner → mocking.
 * - {@link MockResponse} is what the engine asks the runner to *serve*. That may be binary, because
 *   `respond.body` accepts `{ base64: … }`, so it carries an explicit encoding.
 *
 * Neither type touches Playwright or Node's http layer: this module is pure data, which is what
 * lets the golden tests run with no browser (§10.3).
 */

import type { Base64Body, JsonValue, RespondSpec, ResponseBody } from '../types.js';

/**
 * One recorded response, decoded far enough for a scenario `patch` to be applied to it.
 * Structurally identical to `runner/har.ts`'s type of the same name.
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

/** A response the engine wants served in place of whatever the network would have produced. */
export interface MockResponse {
  status: number;
  /** Lowercased header names; see {@link normalizeHeaders}. */
  headers: Record<string, string>;
  /** UTF-8 text, or base64 when `encoding` is `'base64'`. Absent means no body at all. */
  body?: string;
  encoding?: 'base64';
}

/** Header names whose recorded value stops being true the moment the body is rewritten. */
const BODY_DEPENDENT_HEADERS = ['content-length', 'content-encoding'] as const;

export function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  return out;
}

/** The media type of a `content-type` value: lowercased, parameters stripped. */
export function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * True for the content types `patch` and `patchOps` are valid against (§5). `application/json`,
 * `text/json` and the `+json` structured suffix (`application/vnd.api+json`) all qualify;
 * `text/plain` deliberately does not, because a body that merely happens to parse as JSON is not a
 * body the server said was JSON — and patching one would produce a response the application's own
 * parser never sees as the engine saw it.
 */
export function isJsonMediaType(mediaType: string | undefined): boolean {
  const type = mediaTypeOf(mediaType);
  if (type === 'application/json' || type === 'text/json') return true;
  return type.endsWith('+json') && type.includes('/');
}

export type JsonBodyResult =
  | { ok: true; value: JsonValue }
  | { ok: false; empty: boolean; detail: string };

/** Parse a recorded body as JSON, reporting *why* it could not be parsed rather than throwing. */
export function jsonBody(recorded: RecordedResponse): JsonBodyResult {
  const text = recorded.text;
  if (text === undefined || text.trim() === '') {
    return { ok: false, empty: true, detail: 'the recorded response has no body to patch' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, empty: false, detail: `the recorded body is not valid JSON (${reason})` };
  }
}

/**
 * The recorded response, re-expressed as something to serve. Used when a `delay`-only rule matched
 * in a mode where the engine must hand the body back itself.
 */
export function mockFromRecorded(recorded: RecordedResponse): MockResponse {
  const headers = normalizeHeaders(recorded.headers);
  const response: MockResponse = { status: recorded.status, headers };
  if (recorded.text !== undefined) response.body = recorded.text;
  return response;
}

/**
 * Serve a JSON document in place of a recorded body, dropping the headers that described the old
 * bytes. A stale `content-length` makes the browser truncate or hang and a `content-encoding: gzip`
 * left on a body handed over as text makes it undecodable — both are silent failures that look like
 * the patch itself misbehaved.
 */
export function withJsonBody(recorded: RecordedResponse, value: JsonValue): MockResponse {
  const headers = normalizeHeaders(recorded.headers);
  for (const name of BODY_DEPENDENT_HEADERS) delete headers[name];
  if (headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  return { status: recorded.status, headers, body: JSON.stringify(value) };
}

function isBase64Body(body: ResponseBody): body is Base64Body {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && 'base64' in body;
}

/**
 * Build the response a `respond` verb describes (§5). `body` accepts an object (serialized as
 * JSON), a string (sent verbatim), or `{ base64: … }` for binary. A `content-type` the rule did not
 * state is inferred from which of those three it was, so the common case — a JSON object — renders
 * as JSON without the header being spelled out.
 */
export function responseFromSpec(spec: RespondSpec): MockResponse {
  const headers = normalizeHeaders(spec.headers);

  if (spec.body === undefined) return { status: spec.status, headers };

  if (isBase64Body(spec.body)) {
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/octet-stream';
    return { status: spec.status, headers, body: spec.body.base64, encoding: 'base64' };
  }

  if (typeof spec.body === 'string') {
    if (headers['content-type'] === undefined) headers['content-type'] = 'text/plain; charset=utf-8';
    return { status: spec.status, headers, body: spec.body };
  }

  if (headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  return { status: spec.status, headers, body: JSON.stringify(spec.body) };
}

/** The bytes a {@link MockResponse} delivers. */
export function bodyBytes(response: MockResponse | undefined): Buffer {
  if (response?.body === undefined) return Buffer.alloc(0);
  return Buffer.from(response.body, response.encoding === 'base64' ? 'base64' : 'utf8');
}

/**
 * Did the page receive different bytes than the recording held? This is `bodyChanged` in the
 * attribution (§8) — a body question only, so a rule that changes nothing but the status answers
 * `false` and the report says "responded", not "response modified".
 */
export function bodyChangedFrom(
  recorded: RecordedResponse | undefined,
  served: MockResponse | undefined,
): boolean {
  const before = Buffer.from(recorded?.text ?? '', 'utf8');
  return !before.equals(bodyBytes(served));
}
