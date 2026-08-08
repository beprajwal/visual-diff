/**
 * The diff cache (spec §8).
 *
 * The defect these tests exist for: the key was `(baseRunId, headRunId, engineVersion)` only, so it
 * ignored the configuration the engine ran with. `engineVersion` versions the code, not the config —
 * widen the `ignore` semantics, drop a selector, raise `minRegionArea`, and every pair diffed before
 * the change kept returning its old findings forever, under an unchanged engine version.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DIFF_ENGINE_VERSION, type DiffResult, type RunId } from '../types.js';
import { defaultDiffOptions } from './engine.js';
import {
  diffCacheKey,
  diffConfigFingerprint,
  diffDirFor,
  isCacheHit,
  pairId,
  readCachedDiff,
  writeDiff,
  type CachedDiffResult,
  type DiffCacheOptions,
} from './cache.js';

const dirs: string[] = [];

async function outDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdiff-diffcache-'));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const BASE: RunId = '0003';
const HEAD: RunId = '0007';

function options(overrides: Partial<DiffCacheOptions> = {}): DiffCacheOptions {
  return { ...defaultDiffOptions(), ignore: ['.timestamp'], ...overrides };
}

function result(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    engineVersion: DIFF_ENGINE_VERSION,
    flow: 'checkout',
    pair: { base: BASE, head: HEAD },
    computedAt: '2026-08-08T10:00:00.000Z',
    baseMeta: { runId: BASE } as DiffResult['baseMeta'],
    headMeta: { runId: HEAD } as DiffResult['headMeta'],
    flowDiff: [],
    steps: [],
    summary: { totalFindings: 3 } as DiffResult['summary'],
    warnings: [],
    ...overrides,
  };
}

describe('pairId / diffDirFor', () => {
  it('names the pair and its spec §6 directory', () => {
    expect(pairId(BASE, HEAD)).toBe('0003..0007');
    expect(diffDirFor('/tmp/.visual-diff', 'checkout', BASE, HEAD)).toBe(
      join('/tmp/.visual-diff', 'diffs', 'checkout', '0003..0007'),
    );
  });
});

describe('diffCacheKey', () => {
  it('carries the pair, the engine version and a configuration fingerprint', () => {
    const key = diffCacheKey(BASE, HEAD, options());
    expect(key.startsWith(`0003..0007@${DIFF_ENGINE_VERSION}#`)).toBe(true);
    expect(key.endsWith(diffConfigFingerprint(options()))).toBe(true);
  });

  it('does not depend on the order the caller built its options object in', () => {
    const a: DiffCacheOptions = {
      engineVersion: '1',
      ignore: ['.a'],
      minRegionArea: 64,
      maxRegions: 40,
      antialiasTolerance: 0.1,
      deviceScaleFactor: 2,
    };
    const b: DiffCacheOptions = {
      deviceScaleFactor: 2,
      antialiasTolerance: 0.1,
      maxRegions: 40,
      minRegionArea: 64,
      ignore: ['.a'],
      engineVersion: '1',
    };
    expect(diffCacheKey(BASE, HEAD, a)).toBe(diffCacheKey(BASE, HEAD, b));
  });

  it('ignores `force`, which selects whether the cache is consulted, not what is computed', () => {
    const withForce = { ...options(), force: true };
    expect(diffCacheKey(BASE, HEAD, withForce)).toBe(diffCacheKey(BASE, HEAD, options()));
  });
});

describe('readCachedDiff', () => {
  it('hits when the pair, the engine version and the whole configuration are unchanged', async () => {
    const dir = await outDir();
    await writeDiff(dir, result(), options());

    const cached = await readCachedDiff(dir, BASE, HEAD, options());
    expect(cached).not.toBeNull();
    expect(cached?.summary.totalFindings).toBe(3);
  });

  /*
   * One case per field the engine consumes. Each mutation changes what the engine would emit, so
   * each must bust the cache: `ignore` and `minRegionArea` decide which regions survive at all,
   * `maxRegions` decides how many are kept, `antialiasTolerance` decides which pixels count as
   * different, and `deviceScaleFactor` converts DOM rects into image space for attribution.
   */
  it.each<[string, Partial<DiffCacheOptions>]>([
    ['a widened ignore list', { ignore: ['.timestamp', '.session-id'] }],
    ['a narrowed ignore list', { ignore: [] }],
    ['a rewritten ignore selector', { ignore: ['.timestamps'] }],
    ['a reordered ignore list', { ignore: ['.timestamp', '.b'] }],
    ['minRegionArea', { minRegionArea: 128 }],
    ['maxRegions', { maxRegions: 10 }],
    ['antialiasTolerance', { antialiasTolerance: 0.3 }],
    ['deviceScaleFactor', { deviceScaleFactor: 1 }],
    ['engineVersion', { engineVersion: `${DIFF_ENGINE_VERSION}-next` }],
  ])('misses after %s changed', async (_label, change) => {
    const dir = await outDir();
    await writeDiff(dir, result(), options());

    expect(await readCachedDiff(dir, BASE, HEAD, options(change))).toBeNull();
    // …and the unchanged configuration still hits, so the miss is the change, not the write.
    expect(await readCachedDiff(dir, BASE, HEAD, options())).not.toBeNull();
  });

  it('reordering the ignore list busts the cache on purpose: it reorders the emitted warnings', async () => {
    const first = options({ ignore: ['.a', '.b'] });
    const swapped = options({ ignore: ['.b', '.a'] });
    expect(diffCacheKey(BASE, HEAD, first)).not.toBe(diffCacheKey(BASE, HEAD, swapped));
  });

  it('misses when the stored result is for a different pair', async () => {
    const dir = await outDir();
    await writeDiff(dir, result(), options());
    expect(await readCachedDiff(dir, '0002' as RunId, HEAD, options())).toBeNull();
    expect(await readCachedDiff(dir, BASE, '0008' as RunId, options())).toBeNull();
  });

  /*
   * Everything written before the key covered configuration is unattributable: its findings could
   * have come from any ignore list. Reading it as a hit is exactly the stale-forever bug.
   */
  it('misses on a findings.json written before the key was stamped', async () => {
    const dir = await outDir();
    await writeFile(join(dir, 'findings.json'), `${JSON.stringify(result(), null, 2)}\n`, 'utf8');
    expect(await readCachedDiff(dir, BASE, HEAD, options())).toBeNull();
  });

  it('misses on an empty cacheKey rather than treating it as a wildcard', () => {
    const stored: CachedDiffResult = { ...result(), cacheKey: '' };
    expect(isCacheHit(stored, BASE, HEAD, options())).toBe(false);
  });

  it('is null, never a throw, for a missing or corrupt findings.json', async () => {
    const dir = await outDir();
    expect(await readCachedDiff(dir, BASE, HEAD, options())).toBeNull();
    await writeFile(join(dir, 'findings.json'), '{ not json', 'utf8');
    expect(await readCachedDiff(dir, BASE, HEAD, options())).toBeNull();
  });
});

describe('writeDiff', () => {
  it('creates the directory and returns the findings file it wrote', async () => {
    const parent = await outDir();
    const dir = join(parent, 'diffs', 'checkout', pairId(BASE, HEAD));
    const file = await writeDiff(dir, result(), options());

    expect(file).toBe(join(dir, 'findings.json'));
    const stored = JSON.parse(await readFile(file, 'utf8')) as CachedDiffResult;
    expect(stored.cacheKey).toBe(diffCacheKey(BASE, HEAD, options()));
    expect(stored.summary.totalFindings).toBe(3);
  });

  it('leaves no temp file behind, so the cache directory is only ever the real thing', async () => {
    const dir = await outDir();
    await writeDiff(dir, result(), options());
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual(['findings.json']);
  });

  /*
   * `findings.json` has a second writer: `cli/commands/diff.ts` hands the result returned by
   * `computeDiff` to `store.writeDiff`, which re-serializes the same object over the same file. A
   * key stamped only into the bytes written here would be erased by that round trip, and every
   * later read would miss — a cache that never hits is its own defect.
   */
  it('stamps the key on the result itself, so a re-serialization by the store preserves it', async () => {
    const dir = await outDir();
    const computed = result();
    await writeDiff(dir, computed, options());

    // What `store.writeDiff` does: JSON of the very object `computeDiff` returned.
    const roundTripped = join(dir, 'findings.json');
    await writeFile(roundTripped, `${JSON.stringify(computed, null, 2)}\n`, 'utf8');

    expect(await readCachedDiff(dir, BASE, HEAD, options())).not.toBeNull();
  });

  it('re-stamps when the same pair is recomputed under a new configuration', async () => {
    const dir = await outDir();
    await writeDiff(dir, result(), options());
    const widened = options({ ignore: ['.timestamp', '.session-id'] });
    await writeDiff(dir, result({ summary: { totalFindings: 9 } as DiffResult['summary'] }), widened);

    expect(await readCachedDiff(dir, BASE, HEAD, options())).toBeNull();
    const hit = await readCachedDiff(dir, BASE, HEAD, widened);
    expect(hit?.summary.totalFindings).toBe(9);
  });
});

describe('diffConfigFingerprint', () => {
  it('is stable across calls and short enough to read in a key', () => {
    const fingerprint = diffConfigFingerprint(options());
    expect(fingerprint).toBe(diffConfigFingerprint(options()));
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not fold the engine version in — the key names that separately', () => {
    expect(diffConfigFingerprint(options())).toBe(
      diffConfigFingerprint(options({ engineVersion: 'something-else' })),
    );
  });
});

describe('the engine writes through this cache', () => {
  it('mkdir is not required of the caller', async () => {
    const parent = await outDir();
    const nested = join(parent, 'a', 'b', 'c');
    await mkdir(parent, { recursive: true });
    await expect(writeDiff(nested, result(), options())).resolves.toContain('findings.json');
  });
});
