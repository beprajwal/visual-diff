import { describe, expect, it } from 'vitest';

import { isJpeg, readJpegSize } from './jpeg.js';
import { fakeJpeg } from './testkit.js';

describe('readJpegSize', () => {
  it('reads the frame header rather than trusting anything else', () => {
    // The four sizes measured from real traces, none of which equals its logical viewport:
    // 900x600 dsf1 and dsf2 both deliver 798x532, 1600x1200 delivers 800x600, 400x900 delivers
    // 354x797 — an odd height the downscale formula does not predict.
    expect(readJpegSize(fakeJpeg(798, 532))).toEqual({ width: 798, height: 532 });
    expect(readJpegSize(fakeJpeg(800, 600))).toEqual({ width: 800, height: 600 });
    expect(readJpegSize(fakeJpeg(354, 797))).toEqual({ width: 354, height: 797 });
  });

  it('skips application and comment segments before the frame header', () => {
    const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0', 'ascii'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const comment = Buffer.from([0xff, 0xfe, 0x00, 0x06, 0x61, 0x62, 0x63, 0x64]);
    const image = fakeJpeg(640, 480);
    const withSegments = Buffer.concat([
      image.subarray(0, 2),
      jfif,
      comment,
      image.subarray(2),
    ]);
    expect(readJpegSize(withSegments)).toEqual({ width: 640, height: 480 });
  });

  it('tolerates 0xFF fill bytes between segments', () => {
    const image = fakeJpeg(320, 240);
    const padded = Buffer.concat([image.subarray(0, 2), Buffer.from([0xff, 0xff]), image.subarray(2)]);
    expect(readJpegSize(padded)).toEqual({ width: 320, height: 240 });
  });

  it('reads a progressive frame header too', () => {
    const baseline = fakeJpeg(120, 90);
    const progressive = Buffer.from(baseline);
    progressive[3] = 0xc2; // SOF2
    expect(readJpegSize(progressive)).toEqual({ width: 120, height: 90 });
  });

  it('returns null for bytes that are not a JPEG', () => {
    expect(readJpegSize(Buffer.from('\x89PNG\r\n\x1a\n'))).toBeNull();
    expect(readJpegSize(Buffer.from('not an image at all'))).toBeNull();
    expect(readJpegSize(new Uint8Array(0))).toBeNull();
  });

  it('returns null for a JPEG that ends before any frame header', () => {
    expect(readJpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });

  it('returns null for a frame header claiming a zero dimension', () => {
    expect(readJpegSize(fakeJpeg(0, 532))).toBeNull();
  });
});

describe('isJpeg', () => {
  it('recognises the start-of-image marker only', () => {
    expect(isJpeg(fakeJpeg(10, 10))).toBe(true);
    expect(isJpeg(Buffer.from('\x89PNG'))).toBe(false);
    expect(isJpeg(new Uint8Array([0xff]))).toBe(false);
  });
});
