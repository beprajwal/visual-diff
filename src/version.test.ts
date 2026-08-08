import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TOOL_VERSION, toolVersion } from './version.js';

describe('TOOL_VERSION', () => {
  it('matches the published package version', async () => {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { version: string };
    expect(TOOL_VERSION).toBe(parsed.version);
  });

  it('is exposed as a function for the runner env block', () => {
    expect(toolVersion()).toBe(TOOL_VERSION);
  });
});
