/**
 * `e2e/` — trace frames as the store and the diff engine can read them (e2e spec §4).
 *
 * A trace's screenshots are JPEG: CDP's screencast writes `Page.startScreencast({ format: 'jpeg' })`
 * frames and Playwright stores them verbatim. Every other part of this tool reads a shot as
 * `screenshot.png` — `store/paths.ts` names the file, `diff/pixel.ts` decodes it with `pngjs`, and
 * the report serves it — so an ingested frame has to become a PNG somewhere.
 *
 * It happens **here, once, at ingest**, rather than by teaching the diff engine a second codec.
 * Three reasons, in order of how much they matter:
 *
 *  1. The conversion is paid once per frame instead of once per frame per diff, and a frame is
 *     re-read on every pair it takes part in.
 *  2. Nothing downstream changes. A run directory written by ingestion is byte-for-byte the layout
 *     a replayed run has, so the store, the diff engine, the crop writer and the report needed no
 *     e2e-shaped special case — and a `screenshot.png` that is secretly a JPEG would have been one,
 *     in every one of them.
 *  3. The re-encode is lossless *with respect to what the archive holds*. The JPEG's quantisation
 *     already happened inside the browser; decoding it yields the exact pixels the diff would
 *     otherwise compare, and PNG stores them without adding a second generation of loss. Two
 *     ingests of one archive therefore produce identical bytes, which is what makes the idempotency
 *     check in `ingest.ts` a statement about the store and not merely about `meta.json`.
 *
 * The cost is size: a 798×532 screencast frame is ~30 kB as JPEG and ~200 kB as PNG. That is the
 * price of every consumer staying single-codec, and it is bounded by the e2e retention bucket (§7).
 *
 * ### Why `jpeg-js`
 *
 * Node ships no image decoder, `pngjs` encodes PNG only, and the alternative — a hand-written
 * baseline JPEG decoder — is several hundred lines of Huffman and IDCT whose bugs would surface as
 * wrong pixels in a diff rather than as a crash. `jpeg-js` is pure JavaScript, dependency-free, has
 * no install script and no native build, so it does not reintroduce the postinstall that `playwright`
 * was dropped for at v0.2.0.
 */

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { isJpeg, readJpegSize } from './jpeg.js';

/** A decoded frame: RGBA, and the true pixel dimensions read from the image itself. */
export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel, row-major. */
  data: Uint8Array;
}

/**
 * Guardrails on a decode of untrusted bytes.
 *
 * A trace is an archive somebody else's CI produced, so a corrupt or hostile frame must fail rather
 * than allocate without bound. 64 MP and 512 MB are both far above any screencast frame — Playwright
 * scales every one of them to fit an 800×800 box — and far below anything that would take a machine
 * down.
 */
const DECODE_LIMITS = { maxResolutionInMP: 64, maxMemoryUsageInMB: 512 } as const;

/** Thrown when a frame the archive holds is not decodable. Callers turn it into a §8 error. */
export class ImageDecodeError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ImageDecodeError';
  }
}

/** Decode a baseline or progressive JPEG to RGBA. */
export function decodeJpeg(bytes: Uint8Array): DecodedImage {
  if (!isJpeg(bytes)) {
    throw new ImageDecodeError(
      `screencast frame is not a JPEG (first bytes ${describeMagic(bytes)})`,
    );
  }
  let raw: { width: number; height: number; data: Uint8Array };
  try {
    raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, ...DECODE_LIMITS });
  } catch (err) {
    throw new ImageDecodeError(
      `screencast frame could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  // `readJpegSize` reads SOF directly; a decoder that disagreed with the header would mean the two
  // are reading different frames, and every rect downstream would be placed against the wrong one.
  const header = readJpegSize(bytes);
  if (header !== null && (header.width !== raw.width || header.height !== raw.height)) {
    throw new ImageDecodeError(
      `screencast frame header says ${header.width}x${header.height} but it decoded to ` +
        `${raw.width}x${raw.height}`,
    );
  }
  return { width: raw.width, height: raw.height, data: raw.data };
}

/** Encode RGBA to PNG. The inverse half of {@link decodeJpeg}, kept beside it deliberately. */
export function encodePng(image: DecodedImage): Uint8Array {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return new Uint8Array(PNG.sync.write(png));
}

/** One screencast frame, ready to be written as `screenshot.png`. */
export interface ConvertedFrame {
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * A trace's JPEG frame as PNG bytes.
 *
 * Bytes that are already a PNG are passed through untouched: no trace this reader supports stores
 * one, but re-encoding an image that needs no conversion would be a second generation of nothing,
 * and a future reader for another tool's artifacts should not have to know to skip this call.
 */
export function frameToPng(bytes: Uint8Array): ConvertedFrame {
  if (isPng(bytes)) {
    const size = readPngSize(bytes);
    if (size === null) {
      throw new ImageDecodeError('frame claims to be a PNG but carries no IHDR header');
    }
    return { png: bytes, width: size.width, height: size.height };
  }
  const decoded = decodeJpeg(bytes);
  return { png: encodePng(decoded), width: decoded.width, height: decoded.height };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Width and height off a PNG's IHDR, which is always the first chunk. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isPng(bytes) || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return null; // 'IHDR'
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function describeMagic(bytes: Uint8Array): string {
  const head = [...bytes.slice(0, 4)].map((byte) => byte.toString(16).padStart(2, '0'));
  return head.length === 0 ? 'empty' : `0x${head.join('')}`;
}
