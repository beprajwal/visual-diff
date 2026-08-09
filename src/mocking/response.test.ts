import { describe, expect, it } from 'vitest';

import {
  bodyBytes,
  bodyChangedFrom,
  isJsonMediaType,
  jsonBody,
  mediaTypeOf,
  mockFromRecorded,
  normalizeHeaders,
  responseFromSpec,
  withJsonBody,
  type RecordedResponse,
} from './response.js';

const recorded: RecordedResponse = {
  status: 200,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'content-length': '17',
    'content-encoding': 'gzip',
    'cache-control': 'no-store',
  },
  mediaType: 'application/json',
  text: '{"temperature":17}',
};

describe('content types', () => {
  it('strips parameters and lowercases', () => {
    expect(mediaTypeOf('Application/JSON; charset=UTF-8')).toBe('application/json');
    expect(mediaTypeOf(undefined)).toBe('');
  });

  it('accepts json media types, including the +json structured suffix', () => {
    expect(isJsonMediaType('application/json')).toBe(true);
    expect(isJsonMediaType('text/json')).toBe(true);
    expect(isJsonMediaType('application/vnd.api+json; charset=utf-8')).toBe(true);
    expect(isJsonMediaType('application/geo+json')).toBe(true);
  });

  it('rejects everything else, including a text/plain body that happens to parse', () => {
    expect(isJsonMediaType('text/plain')).toBe(false);
    expect(isJsonMediaType('image/png')).toBe(false);
    expect(isJsonMediaType('text/html; charset=utf-8')).toBe(false);
    expect(isJsonMediaType('')).toBe(false);
    expect(isJsonMediaType(undefined)).toBe(false);
    expect(isJsonMediaType('+json')).toBe(false);
  });
});

describe('reading a recorded body', () => {
  it('parses json', () => {
    expect(jsonBody(recorded)).toEqual({ ok: true, value: { temperature: 17 } });
  });

  it('distinguishes an empty body from an unparseable one', () => {
    expect(jsonBody({ ...recorded, text: undefined })).toEqual({
      ok: false,
      empty: true,
      detail: 'the recorded response has no body to patch',
    });
    expect(jsonBody({ ...recorded, text: '   ' }).ok).toBe(false);

    const broken = jsonBody({ ...recorded, text: '{"a":' });
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.empty).toBe(false);
      expect(broken.detail).toMatch(/^the recorded body is not valid JSON \(/);
    }
  });
});

describe('writing a response', () => {
  it('lowercases header names', () => {
    expect(normalizeHeaders({ 'Content-Type': 'application/json', 'X-Trace': '1' })).toEqual({
      'content-type': 'application/json',
      'x-trace': '1',
    });
    expect(normalizeHeaders(undefined)).toEqual({});
  });

  it('drops the headers that described the old bytes when the body is rewritten', () => {
    const served = withJsonBody(recorded, { temperature: 0 });
    expect(served).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: '{"temperature":0}',
    });
  });

  it('adds a json content type when the recording somehow had none', () => {
    const served = withJsonBody({ status: 200, headers: {}, mediaType: '', text: '{}' }, { a: 1 });
    expect(served.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('re-serves a recorded response verbatim', () => {
    expect(mockFromRecorded(recorded)).toEqual({
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': '17',
        'content-encoding': 'gzip',
        'cache-control': 'no-store',
      },
      body: '{"temperature":17}',
    });
    expect(mockFromRecorded({ ...recorded, text: undefined }).body).toBeUndefined();
  });
});

describe('the respond verb (§5)', () => {
  it('serializes an object body as json and infers the content type', () => {
    expect(responseFromSpec({ status: 500, body: { error: 'upstream_unavailable' } })).toEqual({
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: '{"error":"upstream_unavailable"}',
    });
  });

  it('keeps an explicit content type, normalized', () => {
    expect(
      responseFromSpec({
        status: 200,
        headers: { 'Content-Type': 'application/vnd.api+json' },
        body: { data: [] },
      }).headers,
    ).toEqual({ 'content-type': 'application/vnd.api+json' });
  });

  it('sends a string body verbatim as text', () => {
    expect(responseFromSpec({ status: 200, body: '<html>hi</html>' })).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: '<html>hi</html>',
    });
  });

  it('sends a base64 body as binary', () => {
    const response = responseFromSpec({ status: 200, body: { base64: 'AAEC' } });
    expect(response).toEqual({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: 'AAEC',
      encoding: 'base64',
    });
    expect(bodyBytes(response)).toEqual(Buffer.from([0, 1, 2]));
  });

  it('serializes json scalars, including null', () => {
    expect(responseFromSpec({ status: 200, body: null }).body).toBe('null');
    expect(responseFromSpec({ status: 200, body: 42 }).body).toBe('42');
    expect(responseFromSpec({ status: 204 }).body).toBeUndefined();
  });
});

describe('bodyChanged (§8)', () => {
  it('is false when the served bytes equal the recorded ones', () => {
    expect(bodyChangedFrom(recorded, { status: 200, headers: {}, body: recorded.text })).toBe(false);
  });

  it('is true when they differ, and when there was no recording at all', () => {
    expect(bodyChangedFrom(recorded, { status: 200, headers: {}, body: '{}' })).toBe(true);
    expect(bodyChangedFrom(undefined, { status: 200, headers: {}, body: '{}' })).toBe(true);
  });

  it('is false when neither side has a body', () => {
    expect(bodyChangedFrom(undefined, { status: 204, headers: {} })).toBe(false);
    expect(bodyChangedFrom({ ...recorded, text: undefined }, { status: 204, headers: {} })).toBe(
      false,
    );
  });

  it('compares bytes, so an encoding difference alone does not read as a change', () => {
    const base64 = Buffer.from('{"a":1}', 'utf8').toString('base64');
    expect(
      bodyChangedFrom({ ...recorded, text: '{"a":1}' }, {
        status: 200,
        headers: {},
        body: base64,
        encoding: 'base64',
      }),
    ).toBe(false);
  });
});
