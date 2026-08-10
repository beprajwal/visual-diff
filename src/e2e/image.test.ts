/**
 * Trace frames become the PNGs every other layer reads (e2e spec §4).
 *
 * The load-bearing claims are that the conversion is *lossless with respect to the archive* — two
 * ingests of one archive must produce identical bytes, or the idempotency check in `ingest.ts` would
 * be a statement about `meta.json` and not about the store — and that a frame which is not decodable
 * fails with a sentence naming what was wrong rather than with a stack from inside a codec.
 */

import { describe, expect, it } from 'vitest';

import { readJpegSize } from './jpeg.js';
import { ImageDecodeError, decodeJpeg, encodePng, frameToPng, isPng, readPngSize } from './image.js';
import { fakeJpeg, realJpeg } from './testkit.js';

describe('decodeJpeg', () => {
  it('decodes a real frame to RGBA at the size its header declares', () => {
    const bytes = realJpeg(32, 16);
    expect(readJpegSize(bytes)).toEqual({ width: 32, height: 16 });
    const decoded = decodeJpeg(bytes);
    expect(decoded.width).toBe(32);
    expect(decoded.height).toBe(16);
    expect(decoded.data.length).toBe(32 * 16 * 4);
    expect(decoded.data[3]).toBe(255);
  });

  it('names the bytes it was given when they are not a JPEG at all', () => {
    expect(() => decodeJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrowError(
      'screencast frame is not a JPEG (first bytes 0x89504e47)',
    );
  });

  it('reports an empty frame as empty rather than as an unreadable magic number', () => {
    expect(() => decodeJpeg(new Uint8Array())).toThrowError(
      'screencast frame is not a JPEG (first bytes empty)',
    );
  });

  it('fails with the codec message for a JPEG that carries a header and no image', () => {
    // `fakeJpeg` is what the *reader* tests use: enough for a dimension read, nothing to decode.
    // Ingestion must not accept it silently, because a run of empty screenshots diffs as unchanged.
    let thrown: unknown;
    try {
      decodeJpeg(fakeJpeg(10, 10));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ImageDecodeError);
    expect((thrown as Error).message).toMatch(/^screencast frame could not be decoded: /);
  });
});

describe('frameToPng', () => {
  it('produces a PNG of the same pixel size as the JPEG it was handed', () => {
    const frame = frameToPng(realJpeg(24, 12));
    expect(frame.width).toBe(24);
    expect(frame.height).toBe(12);
    expect(isPng(frame.png)).toBe(true);
    expect(readPngSize(frame.png)).toEqual({ width: 24, height: 12 });
  });

  it('is deterministic: the same frame converts to the same bytes every time', () => {
    const bytes = realJpeg(24, 12, [10, 20, 30], { y: 4, h: 3, colour: [200, 30, 30] });
    const first = frameToPng(bytes);
    const second = frameToPng(bytes);
    expect(Buffer.from(second.png).equals(Buffer.from(first.png))).toBe(true);
  });

  it('passes PNG bytes through untouched rather than re-encoding what needs no conversion', () => {
    const png = encodePng({ width: 4, height: 2, data: new Uint8Array(4 * 2 * 4).fill(200) });
    const frame = frameToPng(png);
    expect(frame.png).toBe(png);
    expect(frame.width).toBe(4);
    expect(frame.height).toBe(2);
  });

  it('refuses a truncated PNG rather than reporting a zero-sized frame', () => {
    const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(() => frameToPng(truncated)).toThrowError(
      'frame claims to be a PNG but carries no IHDR header',
    );
  });
});

describe('readPngSize', () => {
  it('is null for anything that is not a PNG, so a caller never reads a size off a JPEG', () => {
    expect(readPngSize(realJpeg(8, 8))).toBeNull();
    expect(isPng(realJpeg(8, 8))).toBe(false);
  });
});
