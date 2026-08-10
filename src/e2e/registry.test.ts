import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { readerFor, readers, readSource } from './registry.js';
import { buildZip, fakeJpeg } from './testkit.js';
import { E2E_SOURCE_FORMATS } from './types.js';
import type { E2eSourceFormat } from './types.js';

describe('the reader registry (§2)', () => {
  it('ships exactly one reader, and it is the Playwright one', () => {
    expect(readers.map((reader) => reader.format)).toEqual(['playwright']);
    expect([...E2E_SOURCE_FORMATS]).toEqual(['playwright']);
  });

  it('describes each reader in terms callers can put in a message', () => {
    const reader = readerFor('playwright');
    expect(reader.label).toBe('Playwright trace archive');
    expect([...reader.supportedVersions]).toEqual([7, 8]);
  });

  it('refuses a format it has no reader for, naming what it does read', () => {
    expect(() => readerFor('cypress' as E2eSourceFormat)).toThrow(
      "no e2e reader for format 'cypress'; this build reads: playwright",
    );
  });

  it('reads through the interface rather than around it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vdiff-e2e-registry-'));
    const file = path.join(dir, 'photos.zip');
    await writeFile(file, buildZip([{ name: 'a.jpeg', data: fakeJpeg(4, 4) }]));
    // Dispatch reaches the Playwright reader, which raises its own §8 refusal.
    await expect(readSource('playwright', file)).rejects.toThrow(
      `not a Playwright trace archive: ${file} contains no '.trace' entry (1 entry read)`,
    );
  });
});
