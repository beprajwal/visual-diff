/**
 * The variant file layout (variants spec §4 "Storage"), tested exactly as the scenario layout is in
 * `mocking/paths.test.ts` — the two are the same shape and any difference between them would be a
 * bug in one rather than a design.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listVariants, variantFile, variantsDir } from './paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vdiff-variant-paths-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeVariant(name: string, body = 'version: 1\n'): Promise<void> {
  await mkdir(variantsDir(root), { recursive: true });
  await writeFile(path.join(variantsDir(root), name), body, 'utf8');
}

describe('variant file layout', () => {
  it('puts variants beside flows and scenarios under .visual-diff', () => {
    expect(variantsDir('/project')).toBe('/project/.visual-diff/variants');
  });

  it('names one variant file after the variant', () => {
    expect(variantFile('/project', 'denser-forecast')).toBe(
      '/project/.visual-diff/variants/denser-forecast.yaml',
    );
  });

  it('normalizes a root with a trailing separator rather than doubling it', () => {
    expect(variantFile('/project/', 'wide-chart')).toBe(
      '/project/.visual-diff/variants/wide-chart.yaml',
    );
  });
});

describe('listVariants', () => {
  it('is empty for a project that has never written a variant, not an error', async () => {
    await expect(listVariants(root)).resolves.toEqual([]);
  });

  it('is empty for an existing but empty variants directory', async () => {
    await mkdir(variantsDir(root), { recursive: true });
    await expect(listVariants(root)).resolves.toEqual([]);
  });

  it('lists variant names sorted, without their extension', async () => {
    await writeVariant('wide-chart.yaml');
    await writeVariant('denser-forecast.yaml');
    await expect(listVariants(root)).resolves.toEqual(['denser-forecast', 'wide-chart']);
  });

  it('accepts .yml as well as .yaml', async () => {
    await writeVariant('promote-upsell.yml');
    await expect(listVariants(root)).resolves.toEqual(['promote-upsell']);
  });

  it('ignores files that are not YAML', async () => {
    await writeVariant('denser-forecast.yaml');
    await writeVariant('NOTES.md');
    await expect(listVariants(root)).resolves.toEqual(['denser-forecast']);
  });

  it('ignores a directory that happens to end in .yaml', async () => {
    await mkdir(path.join(variantsDir(root), 'nested.yaml'), { recursive: true });
    await writeVariant('real.yaml');
    await expect(listVariants(root)).resolves.toEqual(['real']);
  });

  it('ignores a bare extension with no name in front of it', async () => {
    await writeVariant('.yaml');
    await expect(listVariants(root)).resolves.toEqual([]);
  });

  /**
   * `none` is reserved (§7) and can never be selected, and it is listed anyway: a file present on
   * disk but absent from the listing is indistinguishable from one that was never written, so the
   * listing shows it and the parse step reports why it cannot be used.
   */
  it('lists the reserved name so the caller can report why it cannot be used', async () => {
    await writeVariant('none.yaml');
    await expect(listVariants(root)).resolves.toEqual(['none']);
  });

  it('lists a symlinked variant file rather than skipping it silently', async () => {
    const outside = path.join(root, 'shared.yaml');
    await writeFile(outside, 'version: 1\n', 'utf8');
    await mkdir(variantsDir(root), { recursive: true });
    await symlink(outside, path.join(variantsDir(root), 'shared.yaml'));
    await expect(listVariants(root)).resolves.toEqual(['shared']);
  });
});
