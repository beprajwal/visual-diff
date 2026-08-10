/**
 * Expanding `--from trace <path|glob>` (e2e spec §6).
 *
 * Two properties matter more than the pattern syntax itself. **Order is stable**, because ingestion
 * order decides run ids and two machines ingesting one CI run's output must produce the same
 * timeline. And **a pattern that names nothing comes back empty rather than throwing**, because §6
 * turns that into an exit-2 message naming the pattern, and a thrown ENOENT from inside a walk would
 * name a directory the user never typed.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { discoverArchives, hasMagic, segmentMatcher } from './discover.js';

const roots: string[] = [];

async function tree(files: readonly string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vdiff-discover-'));
  roots.push(root);
  for (const file of files) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'x');
  }
  return root;
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe('hasMagic', () => {
  it('is true only for the three constructs this module compiles', () => {
    expect(hasMagic('test-results/**/trace.zip')).toBe(true);
    expect(hasMagic('trace-?.zip')).toBe(true);
    expect(hasMagic('test-results/a/trace.zip')).toBe(false);
    // No brace expansion and no character classes: both are literal, not silently half-supported.
    expect(hasMagic('trace{1,2}.zip')).toBe(false);
    expect(hasMagic('trace[12].zip')).toBe(false);
  });
});

describe('segmentMatcher', () => {
  it('matches `*` within one segment and never across a separator', () => {
    const match = segmentMatcher('*.zip');
    expect(match('trace.zip')).toBe(true);
    expect(match('a/trace.zip')).toBe(false);
  });

  it('treats regex metacharacters in a literal as literal', () => {
    const match = segmentMatcher('a+b*.zip');
    expect(match('a+b1.zip')).toBe(true);
    expect(match('aab1.zip')).toBe(false);
  });

  it('matches exactly one character for `?`', () => {
    const match = segmentMatcher('trace-?.zip');
    expect(match('trace-1.zip')).toBe(true);
    expect(match('trace-12.zip')).toBe(false);
  });
});

describe('discoverArchives', () => {
  it('returns a file named directly, magic or not', async () => {
    const root = await tree(['out/trace.zip']);
    expect(await discoverArchives('out/trace.zip', root)).toEqual([path.join(root, 'out/trace.zip')]);
  });

  it('is empty for a path that does not exist, so the caller owns the message', async () => {
    const root = await tree(['out/trace.zip']);
    expect(await discoverArchives('missing/trace.zip', root)).toEqual([]);
    expect(await discoverArchives('missing/**/*.zip', root)).toEqual([]);
  });

  it('expands a directory to every archive beneath it, because that is what people type', async () => {
    const root = await tree([
      'test-results/a/trace.zip',
      'test-results/b/deep/trace.zip',
      'test-results/a/video.webm',
    ]);
    expect(await discoverArchives('test-results', root)).toEqual([
      path.join(root, 'test-results/a/trace.zip'),
      path.join(root, 'test-results/b/deep/trace.zip'),
    ]);
  });

  it('spans zero or more directories for `**`', async () => {
    const root = await tree([
      'out/trace.zip',
      'out/a/trace.zip',
      'out/a/b/trace.zip',
      'out/a/other.zip',
    ]);
    expect(await discoverArchives('out/**/trace.zip', root)).toEqual([
      path.join(root, 'out/a/b/trace.zip'),
      path.join(root, 'out/a/trace.zip'),
      path.join(root, 'out/trace.zip'),
    ]);
  });

  it('sorts results, so two machines ingesting one CI run agree on run ids', async () => {
    const root = await tree(['out/c.zip', 'out/a.zip', 'out/b.zip']);
    expect(await discoverArchives('out/*.zip', root)).toEqual([
      path.join(root, 'out/a.zip'),
      path.join(root, 'out/b.zip'),
      path.join(root, 'out/c.zip'),
    ]);
  });

  it('resolves a relative pattern against the given cwd, not the process one', async () => {
    const root = await tree(['out/trace.zip']);
    expect(await discoverArchives('./out/*.zip', root)).toEqual([
      path.join(root, 'out/trace.zip'),
    ]);
  });

  it('accepts an absolute pattern', async () => {
    const root = await tree(['out/trace.zip']);
    expect(await discoverArchives(path.join(root, 'out/*.zip'), '/nowhere')).toEqual([
      path.join(root, 'out/trace.zip'),
    ]);
  });

  it('never descends node_modules, which holds no test output and is large', async () => {
    const root = await tree(['out/trace.zip', 'node_modules/pkg/fixture.zip']);
    expect(await discoverArchives('**/*.zip', root)).toEqual([path.join(root, 'out/trace.zip')]);
  });

  it('does not follow a symlinked directory, so a cycle cannot hang an ingest', async () => {
    const root = await tree(['out/trace.zip']);
    await symlink(path.join(root, 'out'), path.join(root, 'loop'), 'dir');
    expect(await discoverArchives('**/*.zip', root)).toEqual([path.join(root, 'out/trace.zip')]);
  });

  it('does not return a directory that happens to match the final segment', async () => {
    const root = await tree(['out/trace.zip/inner.txt']);
    expect(await discoverArchives('out/*.zip', root)).toEqual([]);
  });
});
