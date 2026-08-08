import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { REDACTED, scrubHar, scrubHarFile } from './har.js';

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
