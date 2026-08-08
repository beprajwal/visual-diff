import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { publishDirAtomic, writeFileAtomic, writeJsonAtomic } from './atomic.js';
import { listDirNames } from './fs.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-atomic-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates missing parent directories', async () => {
    const target = path.join(tmp, 'a', 'b', 'c.json');
    await writeFileAtomic(target, 'hello');
    expect(await fsp.readFile(target, 'utf8')).toBe('hello');
  });

  it('replaces an existing file wholesale', async () => {
    const target = path.join(tmp, 'meta.json');
    await writeFileAtomic(target, 'first-version-which-is-long');
    await writeFileAtomic(target, 'second');
    expect(await fsp.readFile(target, 'utf8')).toBe('second');
  });

  it('leaves no temp file behind', async () => {
    const target = path.join(tmp, 'meta.json');
    await writeJsonAtomic(target, { b: 1, a: 2 });
    expect(await listDirNames(tmp)).toEqual(['meta.json']);
    expect(await fsp.readFile(target, 'utf8')).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });
});

describe('publishDirAtomic', () => {
  it('makes the whole directory visible in one step', async () => {
    const staging = path.join(tmp, '.tmp-run');
    await fsp.mkdir(path.join(staging, 'steps', 'pay-form'), { recursive: true });
    await fsp.writeFile(path.join(staging, 'meta.json'), '{}');
    await fsp.writeFile(path.join(staging, 'steps', 'pay-form', 'step.json'), '{}');

    const final = path.join(tmp, '0007');
    // Before the rename the final name does not exist at all: a partial run is never visible.
    expect(await listDirNames(tmp)).toEqual(['.tmp-run']);

    await publishDirAtomic(staging, final);

    expect(await listDirNames(tmp)).toEqual(['0007']);
    expect(await fsp.readFile(path.join(final, 'steps', 'pay-form', 'step.json'), 'utf8')).toBe('{}');
  });

  it('refuses to overwrite an existing run directory', async () => {
    const staging = path.join(tmp, '.tmp-run');
    await fsp.mkdir(staging, { recursive: true });
    await fsp.writeFile(path.join(staging, 'meta.json'), '{}');
    const final = path.join(tmp, '0007');
    await fsp.mkdir(final);
    await fsp.writeFile(path.join(final, 'meta.json'), 'original');

    await expect(publishDirAtomic(staging, final)).rejects.toThrow(/already exists/);
    expect(await fsp.readFile(path.join(final, 'meta.json'), 'utf8')).toBe('original');
  });
});
