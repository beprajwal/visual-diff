import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Browser } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';

import { capturePreview, PREVIEW_FILES, type PreviewScheme } from './preview.js';

const FINGERPRINT = 'a'.repeat(64);
const MANIFEST = 'images/preview.json';
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function bundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdiff-preview-stamp-'));
  dirs.push(dir);
  await mkdir(join(dir, 'images'));
  await writeFile(join(dir, MANIFEST), JSON.stringify({ diffFingerprint: FINGERPRINT }));
  return dir;
}

/** The browser boundary is faked; the capture's PNG and manifest writes use the real filesystem. */
function browserFor(
  outDir: string,
  options: {
    fingerprints?: Partial<Record<PreviewScheme, string | null>>;
    failScheme?: PreviewScheme;
  } = {},
): Browser {
  return {
    async newContext({ colorScheme }: { colorScheme: PreviewScheme }) {
      return {
        async newPage() {
          return {
            async goto() {},
            async waitForSelector() {},
            async waitForFunction() {},
            async evaluate() {
              const value = options.fingerprints?.[colorScheme];
              return value === undefined ? FINGERPRINT : value;
            },
            async screenshot({ path }: { path: string }) {
              // A matching stamp must never exist while a previous PNG may still be on disk.
              await expect(access(join(outDir, MANIFEST))).rejects.toMatchObject({ code: 'ENOENT' });
              await writeFile(path, `${colorScheme} capture`);
              if (options.failScheme === colorScheme) throw new Error(`${colorScheme} capture failed`);
            },
          };
        },
        async close() {},
      };
    },
    async close() {},
  } as unknown as Browser;
}

describe('preview fingerprint binding', () => {
  it('stamps the rendered fingerprint only after both theme screenshots finish', async () => {
    const outDir = await bundle();
    const report = await capturePreview({ outDir, launch: async () => browserFor(outDir) });
    expect(report.files).toEqual([PREVIEW_FILES.light, PREVIEW_FILES.dark]);
    expect(await readFile(join(outDir, PREVIEW_FILES.light), 'utf8')).toBe('light capture');
    expect(await readFile(join(outDir, PREVIEW_FILES.dark), 'utf8')).toBe('dark capture');
    expect(JSON.parse(await readFile(join(outDir, MANIFEST), 'utf8'))).toEqual({
      diffFingerprint: FINGERPRINT,
    });
  });

  it.each([null, '', 'not-a-fingerprint'])('captures an old/custom page without stamping metadata %s', async (fingerprint) => {
    const outDir = await bundle();
    const report = await capturePreview({
      outDir,
      page: 'custom.html',
      launch: async () => browserFor(outDir, {
        fingerprints: { light: fingerprint, dark: fingerprint },
      }),
    });
    expect(report.files).toEqual([PREVIEW_FILES.light, PREVIEW_FILES.dark]);
    await expect(access(join(outDir, MANIFEST))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not bind two screenshots of different rendered diffs', async () => {
    const outDir = await bundle();
    await capturePreview({
      outDir,
      launch: async () => browserFor(outDir, { fingerprints: { dark: 'b'.repeat(64) } }),
    });
    await expect(access(join(outDir, MANIFEST))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['light', 'dark'] as const)('invalidates stale metadata when the %s screenshot fails', async (failScheme) => {
    const outDir = await bundle();
    await expect(capturePreview({
      outDir,
      launch: async () => browserFor(outDir, { failScheme }),
    })).rejects.toThrow(`${failScheme} capture failed`);
    await expect(access(join(outDir, MANIFEST))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('invalidates stale metadata before even trying to launch the browser', async () => {
    const outDir = await bundle();
    await expect(capturePreview({
      outDir,
      launch: async () => {
        await expect(access(join(outDir, MANIFEST))).rejects.toMatchObject({ code: 'ENOENT' });
        throw new Error('no browser installed');
      },
    })).rejects.toThrow('no browser installed');
    await expect(access(join(outDir, MANIFEST))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
