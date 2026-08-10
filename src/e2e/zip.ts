/**
 * `e2e/` — a read-only zip reader for trace archives.
 *
 * ### Why this exists rather than a dependency, or Playwright's own extractor
 *
 * The root package ships `playwright-core`, not `playwright`, and that is load-bearing: the full
 * package's postinstall downloads browsers, and it was removed so `npx @beprajwal/visual-diff`
 * stays a small install. `playwright-core` does bundle a trace loader, but it lives in a bundled
 * file with no semver guarantee and no types, and its failure messages talk about "the viewer" — a
 * program the user is not running. §8 requires *our* messages, asserted by test, so the reader is
 * ours and the format is read directly.
 *
 * A trace archive is a plain zip: stored or deflated entries, a central directory, and — for the
 * large archives a CI run produces — possibly Zip64. Entries are read on demand through a file
 * handle rather than by slurping the archive, because a runner trace with a few hundred screenshots
 * is tens of megabytes and only a fraction of it is ever needed.
 *
 * CRC is verified on every read. That is what turns "the file was truncated mid-upload" from a
 * confusing parse failure deep in the NDJSON reader into the §8 message naming the archive.
 */

import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

import { archiveUnreadable, isE2eError, traceCorrupt } from './errors.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const EOCD_MIN_SIZE = 22;
/** The comment field is 16 bits, so the record can start at most 65535 + 22 bytes from the end. */
const EOCD_MAX_SEARCH = 0xffff + EOCD_MIN_SIZE;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  crc32: number;
}

/**
 * An open archive. Always `close()` it — every reader that opens one does so in a `try/finally`.
 */
export class ZipArchive {
  readonly path: string;
  private readonly handle: FileHandle;
  private readonly byName: Map<string, ZipEntry>;

  private constructor(path: string, handle: FileHandle, entries: ZipEntry[]) {
    this.path = path;
    this.handle = handle;
    this.byName = new Map(entries.map((entry) => [entry.name, entry]));
  }

  /** Entry names in central-directory order. */
  get names(): string[] {
    return [...this.byName.keys()];
  }

  get entries(): ZipEntry[] {
    return [...this.byName.values()];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  entry(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /** Decompressed bytes of one entry, or `undefined` when the archive has no such entry. */
  async read(name: string): Promise<Uint8Array | undefined> {
    const entry = this.byName.get(name);
    if (entry === undefined) return undefined;
    return this.readEntry(entry);
  }

  /** Decompressed bytes of one entry, decoded as UTF-8. */
  async readText(name: string): Promise<string | undefined> {
    const bytes = await this.read(name);
    return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
  }

  async readEntry(entry: ZipEntry): Promise<Uint8Array> {
    const header = await this.readAt(entry.localHeaderOffset, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== SIG_LOCAL) {
      throw traceCorrupt(this.path, `entry '${entry.name}' has no local header`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const raw = await this.readAt(dataOffset, entry.compressedSize);
    if (raw.length !== entry.compressedSize) {
      throw traceCorrupt(
        this.path,
        `entry '${entry.name}' is truncated: expected ${entry.compressedSize} bytes, found ${raw.length}`,
      );
    }

    let data: Buffer;
    if (entry.compressionMethod === METHOD_STORED) {
      data = raw;
    } else if (entry.compressionMethod === METHOD_DEFLATE) {
      try {
        data = inflateRawSync(raw);
      } catch (cause) {
        throw traceCorrupt(this.path, `entry '${entry.name}' failed to decompress`, cause);
      }
    } else {
      throw traceCorrupt(
        this.path,
        `entry '${entry.name}' uses unsupported compression method ${entry.compressionMethod}; only stored and deflate are read`,
      );
    }

    // A zero CRC with a zero length is the empty entry, which every trace has: `trace.network` is a
    // zero-byte file whenever snapshots were off.
    if (data.length !== 0 || entry.crc32 !== 0) {
      const actual = crc32(data);
      if (actual !== entry.crc32) {
        throw traceCorrupt(
          this.path,
          `entry '${entry.name}' failed its checksum: the archive is damaged or truncated`,
        );
      }
    }
    return data;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private async readAt(position: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }

  /**
   * Opens an archive, reading its central directory.
   *
   * Every failure here is `archiveUnreadable`: at this point we know nothing about the file except
   * that it did not parse as a zip, which is precisely §8's "path is not a readable trace archive".
   */
  static async open(archivePath: string): Promise<ZipArchive> {
    let handle: FileHandle;
    try {
      handle = await open(archivePath, 'r');
    } catch (cause) {
      const code = (cause as { code?: string } | null)?.code;
      const detail =
        code === 'ENOENT'
          ? 'no such file'
          : code === 'EISDIR'
            ? 'path is a directory'
            : code === 'EACCES'
              ? 'permission denied'
              : `cannot open: ${describe(cause)}`;
      throw archiveUnreadable(archivePath, detail, cause);
    }

    try {
      const stats = await handle.stat();
      // A directory opens happily on macOS and Linux and only fails on the first read, which would
      // surface as EISDIR from somewhere deep in the parser rather than as the §8 message.
      if (stats.isDirectory()) throw archiveUnreadable(archivePath, 'path is a directory');
      const size = stats.size;
      if (size < EOCD_MIN_SIZE) {
        throw archiveUnreadable(archivePath, `file is ${size} bytes, too small to be a zip`);
      }
      const tailLength = Math.min(size, EOCD_MAX_SEARCH);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, size - tailLength);

      const eocdOffset = findSignatureFromEnd(tail, SIG_EOCD);
      if (eocdOffset < 0) {
        throw archiveUnreadable(
          archivePath,
          'no zip end-of-central-directory record: the file is not a zip, or is truncated',
        );
      }

      let entryCount = tail.readUInt16LE(eocdOffset + 10);
      let centralOffset = tail.readUInt32LE(eocdOffset + 16);
      let centralSize = tail.readUInt32LE(eocdOffset + 12);

      if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
        const zip64 = await readZip64Locator(handle, tail, eocdOffset, size, archivePath);
        entryCount = zip64.entryCount;
        centralOffset = zip64.centralOffset;
        centralSize = zip64.centralSize;
      }

      if (centralOffset + centralSize > size) {
        throw archiveUnreadable(
          archivePath,
          'the zip central directory points past the end of the file: the archive is truncated',
        );
      }

      const central = Buffer.alloc(centralSize);
      await handle.read(central, 0, centralSize, centralOffset);
      const entries = parseCentralDirectory(central, entryCount, archivePath);
      return new ZipArchive(archivePath, handle, entries);
    } catch (error) {
      await handle.close().catch(() => {});
      if (isE2eError(error)) throw error;
      // Anything else that happened while parsing a zip is still "this file is not a readable
      // archive"; surfacing a raw errno through the §8 boundary would defeat the point of having one.
      throw archiveUnreadable(archivePath, `cannot read: ${describe(error)}`, error);
    }
  }
}

/* ------------------------------------------------------------------ parsing */

function parseCentralDirectory(
  central: Buffer,
  entryCount: number,
  archivePath: string,
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw archiveUnreadable(
        archivePath,
        `zip central directory ends after ${index} of ${entryCount} entries`,
      );
    }
    const compressionMethod = central.readUInt16LE(offset + 10);
    const crc = central.readUInt32LE(offset + 16);
    let compressedSize = central.readUInt32LE(offset + 20);
    let uncompressedSize = central.readUInt32LE(offset + 24);
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    let localHeaderOffset = central.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = central.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const extra = central.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const zip64 = readZip64Extra(extra, {
        uncompressedSize,
        compressedSize,
        localHeaderOffset,
      });
      compressedSize = zip64.compressedSize;
      uncompressedSize = zip64.uncompressedSize;
      localHeaderOffset = zip64.localHeaderOffset;
    }

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      crc32: crc,
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZip64Locator(
  handle: FileHandle,
  tail: Buffer,
  eocdOffset: number,
  size: number,
  archivePath: string,
): Promise<{ entryCount: number; centralOffset: number; centralSize: number }> {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0 || tail.readUInt32LE(locatorOffset) !== SIG_ZIP64_LOCATOR) {
    throw archiveUnreadable(archivePath, 'zip declares Zip64 sizes but carries no Zip64 locator');
  }
  const recordOffset = Number(tail.readBigUInt64LE(locatorOffset + 8));
  if (recordOffset < 0 || recordOffset + 56 > size) {
    throw archiveUnreadable(archivePath, 'the Zip64 end-of-central-directory record is out of range');
  }
  const record = Buffer.alloc(56);
  await handle.read(record, 0, 56, recordOffset);
  if (record.readUInt32LE(0) !== SIG_ZIP64_EOCD) {
    throw archiveUnreadable(archivePath, 'the Zip64 end-of-central-directory record is missing');
  }
  return {
    entryCount: Number(record.readBigUInt64LE(32)),
    centralSize: Number(record.readBigUInt64LE(40)),
    centralOffset: Number(record.readBigUInt64LE(48)),
  };
}

/** The 0x0001 extra field, whose members appear only for the values that were 0xFFFFFFFF. */
function readZip64Extra(
  extra: Buffer,
  defaults: { uncompressedSize: number; compressedSize: number; localHeaderOffset: number },
): { uncompressedSize: number; compressedSize: number; localHeaderOffset: number } {
  let offset = 0;
  const out = { ...defaults };
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const body = extra.subarray(offset + 4, offset + 4 + size);
    if (id === 0x0001) {
      let cursor = 0;
      if (defaults.uncompressedSize === 0xffffffff && cursor + 8 <= body.length) {
        out.uncompressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (defaults.compressedSize === 0xffffffff && cursor + 8 <= body.length) {
        out.compressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (defaults.localHeaderOffset === 0xffffffff && cursor + 8 <= body.length) {
        out.localHeaderOffset = Number(body.readBigUInt64LE(cursor));
      }
      return out;
    }
    offset += 4 + size;
  }
  return out;
}

function findSignatureFromEnd(buffer: Buffer, signature: number): number {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ crc32 */

/**
 * CRC-32 (IEEE), table-driven.
 *
 * `zlib.crc32` would do this, but it landed in Node 20.15 while `package.json` declares
 * `engines: { node: ">=20" }`. Fifteen lines here keep the declared range honest.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < data.length; i += 1) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ (data[i] as number)) & 0xff] as number);
  }
  return (crc ^ -1) >>> 0;
}
