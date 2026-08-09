import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { REDACTED, indexHar, indexHarFile, scrubHar, scrubHarFile } from './har.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdiff-har-'));
  dirs.push(dir);
  return dir;
}

function har(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    log: {
      version: '1.2',
      entries: [
        {
          request: {
            method: 'GET',
            url: 'https://api.example.com/cart?session=abc&page=2',
            headers: [
              { name: 'Authorization', value: 'Bearer secret' },
              { name: 'X-Api-Key', value: 'k-123' },
              { name: 'Accept', value: 'application/json' },
            ],
            cookies: [{ name: 'Cookie', value: 'sid=1' }],
            queryString: [
              { name: 'session', value: 'abc' },
              { name: 'page', value: '2' },
            ],
            postData: { params: [{ name: 'x-api-key', value: 'k-123' }] },
          },
          response: {
            status: 200,
            headers: [
              { name: 'Set-Cookie', value: 'sid=1; HttpOnly' },
              { name: 'Content-Type', value: 'application/json' },
            ],
            cookies: [],
          },
        },
      ],
      ...overrides,
    },
  });
}

describe('scrubHar', () => {
  it('drops the always-redacted headers, whatever their casing', () => {
    const { har: text, redacted } = scrubHar(har());
    const parsed = JSON.parse(text) as {
      log: { entries: Array<{ request: { headers: Array<{ name: string }> }; response: { headers: Array<{ name: string }> } }> };
    };
    const entry = parsed.log.entries[0];
    expect(entry?.request.headers.map((h) => h.name)).toEqual(['X-Api-Key', 'Accept']);
    expect(entry?.response.headers.map((h) => h.name)).toEqual(['Content-Type']);
    expect(redacted).toBeGreaterThan(0);
  });

  it('drops headers named in network.redact as well', () => {
    const { har: text } = scrubHar(har(), { redact: ['x-api-key'] });
    const parsed = JSON.parse(text) as {
      log: { entries: Array<{ request: { headers: Array<{ name: string }> } }> };
    };
    expect(parsed.log.entries[0]?.request.headers.map((h) => h.name)).toEqual(['Accept']);
  });

  it('keeps redacted query and post fields present, so replay still matches the request', () => {
    const { har: text } = scrubHar(har(), { redact: ['session', 'x-api-key'] });
    const parsed = JSON.parse(text) as {
      log: {
        entries: Array<{
          request: { queryString: Array<{ name: string; value: string }>; postData: { params: Array<{ name: string; value: string }> } };
        }>;
      };
    };
    const request = parsed.log.entries[0]?.request;
    expect(request?.queryString).toEqual([
      { name: 'session', value: REDACTED },
      { name: 'page', value: '2' },
    ]);
    expect(request?.postData.params).toEqual([{ name: 'x-api-key', value: REDACTED }]);
  });

  it('refuses to rewrite a HAR it cannot parse, rather than emptying it', () => {
    const result = scrubHar('{not json');
    expect(result).toEqual({ har: '{not json', redacted: 0 });
  });

  it('rewrites the file on disk and reports the count', async () => {
    const dir = await tempDir();
    const file = join(dir, 'checkout.har');
    await writeFile(file, har(), 'utf8');

    const redacted = await scrubHarFile(file, { redact: ['x-api-key'] });
    // Authorization, X-Api-Key, the request cookie, Set-Cookie, and the x-api-key post param.
    expect(redacted).toBe(5);
    expect(await readFile(file, 'utf8')).not.toContain('Bearer secret');
  });

  it('is a no-op on a missing file', async () => {
    const dir = await tempDir();
    await expect(scrubHarFile(join(dir, 'nope.har'))).resolves.toBe(0);
  });
});

/* ---------------------------------------------------- recorded response index (mocking §5, §8) */

interface IndexEntry {
  method?: string;
  url: string;
  status?: number;
  mimeType?: string;
  text?: string;
  encoding?: string;
  headers?: Array<{ name: string; value: string }>;
}

function indexable(entries: IndexEntry[]): string {
  return JSON.stringify({
    log: {
      version: '1.2',
      entries: entries.map((entry) => ({
        request: { method: entry.method ?? 'GET', url: entry.url },
        response: {
          status: entry.status ?? 200,
          headers: entry.headers ?? [{ name: 'Content-Type', value: entry.mimeType ?? 'application/json' }],
          content: {
            ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
            ...(entry.text === undefined ? {} : { text: entry.text }),
            ...(entry.encoding === undefined ? {} : { encoding: entry.encoding }),
          },
        },
      })),
    },
  });
}

const FORECAST = 'https://api.example.test/v1/forecast?lat=1&lon=2';

describe('indexHar', () => {
  it('finds a recorded response by method and full URL, decoded and ready to patch', () => {
    const index = indexHar(indexable([{ url: FORECAST, text: '{"ok":true}' }]));
    expect(index.size).toBe(1);
    expect(index.find('GET', FORECAST)).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      mediaType: 'application/json',
      text: '{"ok":true}',
    });
  });

  it('matches the method case-insensitively but the URL exactly', () => {
    const index = indexHar(indexable([{ method: 'post', url: FORECAST, text: '{}' }]));
    expect(index.find('POST', FORECAST)).toBeDefined();
    expect(index.find('GET', FORECAST)).toBeUndefined();
    expect(index.find('POST', 'https://api.example.test/v1/forecast')).toBeUndefined();
  });

  /* A fetch that builds its query in a different order is the same request to every server, and a
   * patch rule silently finding no body because of it would fail a run for no real reason. */
  it('still matches when the query parameters were recorded in another order', () => {
    const index = indexHar(indexable([{ url: FORECAST, text: '{}' }]));
    expect(index.find('GET', 'https://api.example.test/v1/forecast?lon=2&lat=1')).toBeDefined();
  });

  it('decodes a base64-encoded body', () => {
    const index = indexHar(
      indexable([
        { url: FORECAST, text: Buffer.from('{"ok":true}', 'utf8').toString('base64'), encoding: 'base64' },
      ]),
    );
    expect(index.find('GET', FORECAST)?.text).toBe('{"ok":true}');
  });

  it('lower-cases header names and strips content-type parameters from the media type', () => {
    const index = indexHar(
      indexable([
        {
          url: FORECAST,
          text: '{}',
          headers: [
            { name: 'Content-Type', value: 'Application/JSON; charset=UTF-8' },
            { name: 'X-Cache', value: 'HIT' },
          ],
        },
      ]),
    );
    const recorded = index.find('GET', FORECAST);
    expect(recorded?.mediaType).toBe('application/json');
    expect(recorded?.headers).toEqual({
      'content-type': 'Application/JSON; charset=UTF-8',
      'x-cache': 'HIT',
    });
  });

  it('falls back to the content-type header when the entry declares no mimeType', () => {
    const index = indexHar(
      indexable([
        { url: FORECAST, text: 'plain', headers: [{ name: 'content-type', value: 'text/plain' }] },
      ]),
    );
    expect(index.find('GET', FORECAST)?.mediaType).toBe('text/plain');
  });

  it('records no body when the entry has none, so a patch fails rather than patching ""', () => {
    const index = indexHar(indexable([{ url: FORECAST }]));
    expect(index.find('GET', FORECAST)?.text).toBeUndefined();
  });

  /* Per-viewport positional replay would make two concurrent viewports patch different bodies,
   * which is exactly the determinism the mocking spec §10.1 requires to survive this layer. */
  it('serves the first recorded response for a repeated request, deterministically', () => {
    const index = indexHar(
      indexable([
        { url: FORECAST, text: '{"n":1}' },
        { url: FORECAST, text: '{"n":2}' },
      ]),
    );
    expect(index.find('GET', FORECAST)?.text).toBe('{"n":1}');
    expect(index.find('GET', FORECAST)?.text).toBe('{"n":1}');
  });

  it('is empty rather than throwing for a HAR it cannot parse or that has no entries', () => {
    expect(indexHar('{not json').size).toBe(0);
    expect(indexHar('{"log":{}}').find('GET', FORECAST)).toBeUndefined();
    expect(indexHar(JSON.stringify({ log: { entries: [{ request: {} }] } })).size).toBe(0);
  });
});

describe('indexHarFile', () => {
  it('indexes a HAR on disk', async () => {
    const dir = await tempDir();
    const file = join(dir, 'forecast.har');
    await writeFile(file, indexable([{ url: FORECAST, text: '{"ok":true}' }]), 'utf8');
    expect((await indexHarFile(file)).find('GET', FORECAST)?.text).toBe('{"ok":true}');
  });

  it('is an empty index — never a throw — for a file that is not there', async () => {
    const dir = await tempDir();
    expect((await indexHarFile(join(dir, 'nope.har'))).size).toBe(0);
  });
});
