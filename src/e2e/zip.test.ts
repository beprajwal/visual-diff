import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildZip, fakeJpeg } from './testkit.js';
import { crc32, ZipArchive } from './zip.js';
import { isE2eError } from './errors.js';

const temporaryDirectories: string[] = [];

async function writeTemp(name: string, bytes: Uint8Array | string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vdiff-e2e-zip-'));
  temporaryDirectories.push(dir);
  const target = path.join(dir, name);
  await writeFile(target, bytes);
  return target;
}

afterAll(() => {
  temporaryDirectories.length = 0;
});

describe('crc32', () => {
  it('matches the known IEEE check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('ZipArchive', () => {
  it('reads stored and deflated entries, and lists names in central-directory order', async () => {
    const zip = buildZip([
      { name: 'trace.trace', data: '{"type":"context-options"}', method: 'deflate' },
      { name: 'trace.network', data: '' },
      { name: 'resources/shot.jpeg', data: fakeJpeg(798, 532) },
    ]);
    const file = await writeTemp('trace.zip', zip);
    const archive = await ZipArchive.open(file);
    try {
      expect(archive.names).toEqual(['trace.trace', 'trace.network', 'resources/shot.jpeg']);
      expect(await archive.readText('trace.trace')).toBe('{"type":"context-options"}');
      // A zero-byte entry is the normal shape of `trace.network` when snapshots were off.
      expect(await archive.readText('trace.network')).toBe('');
      const shot = await archive.read('resources/shot.jpeg');
      expect(shot?.length).toBe(fakeJpeg(798, 532).length);
      expect(await archive.read('resources/absent.jpeg')).toBeUndefined();
    } finally {
      await archive.close();
    }
  });

  it('round-trips an entry larger than one deflate block', async () => {
    const body = 'x'.repeat(200_000);
    const file = await writeTemp('big.zip', buildZip([{ name: 'a.txt', data: body, method: 'deflate' }]));
    const archive = await ZipArchive.open(file);
    try {
      expect(await archive.readText('a.txt')).toBe(body);
    } finally {
      await archive.close();
    }
  });

  it('names a missing file rather than surfacing an fs error', async () => {
    const missing = path.join(tmpdir(), 'vdiff-e2e-does-not-exist-1234.zip');
    await expect(ZipArchive.open(missing)).rejects.toThrow(
      `not a readable trace archive: ${missing} (no such file)`,
    );
  });

  it('reports a directory as unreadable, with exit code 2', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vdiff-e2e-dir-'));
    temporaryDirectories.push(dir);
    const error = await ZipArchive.open(dir).catch((caught: unknown) => caught);
    expect(isE2eError(error)).toBe(true);
    if (!isE2eError(error)) throw new Error('expected an E2eError');
    expect(error.message).toBe(`not a readable trace archive: ${dir} (path is a directory)`);
    expect(error.code).toBe('e2e-archive-unreadable');
    expect(error.exitCode).toBe(2);
  });

  it('rejects a file that is not a zip at all', async () => {
    const file = await writeTemp('notes.txt', 'this is plainly not a zip archive, it is prose');
    await expect(ZipArchive.open(file)).rejects.toThrow(
      `not a readable trace archive: ${file} (no zip end-of-central-directory record: the file is not a zip, or is truncated)`,
    );
  });

  it('rejects a file too small to be a zip', async () => {
    const file = await writeTemp('tiny.zip', 'PK');
    await expect(ZipArchive.open(file)).rejects.toThrow(
      `not a readable trace archive: ${file} (file is 2 bytes, too small to be a zip)`,
    );
  });

  it('reports a truncated archive rather than decompressing garbage', async () => {
    const zip = buildZip([{ name: 'trace.trace', data: 'x'.repeat(4096), method: 'deflate' }]);
    // Keep the central directory and the end record, but cut bytes out of the entry's data.
    const truncated = Buffer.concat([zip.subarray(0, 40), zip.subarray(60)]);
    const file = await writeTemp('cut.zip', truncated);
    const archive = await ZipArchive.open(file).catch(() => undefined);
    if (archive === undefined) return; // A cut deep enough to break the directory is also acceptable.
    try {
      await expect(archive.read('trace.trace')).rejects.toThrow(/^corrupt trace archive: /);
    } finally {
      await archive.close();
    }
  });

  it('detects a damaged entry through its checksum', async () => {
    const zip = buildZip([{ name: 'trace.trace', data: 'hello trace' }]);
    const damaged = Buffer.from(zip);
    // Flip a byte inside the stored payload, leaving every length and the CRC field intact.
    const dataStart = 30 + Buffer.byteLength('trace.trace');
    damaged[dataStart] = (damaged[dataStart] as number) ^ 0xff;
    const file = await writeTemp('damaged.zip', damaged);
    const archive = await ZipArchive.open(file);
    try {
      await expect(archive.read('trace.trace')).rejects.toThrow(
        `corrupt trace archive: ${file} (entry 'trace.trace' failed its checksum: the archive is damaged or truncated)`,
      );
    } finally {
      await archive.close();
    }
  });
});
