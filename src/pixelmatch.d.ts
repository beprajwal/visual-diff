/**
 * Ambient types for `pixelmatch` v6, which ships no declarations of its own and has no
 * `@types` package tracking v6 (the DefinitelyTyped entry stops at v5 and declares a CommonJS
 * `export =`, which does not describe the ESM-only v6 package).
 *
 * Kept minimal and faithful to the options the diff engine uses (spec §8: antialias tolerance
 * plus a YIQ colour-delta threshold).
 */
declare module 'pixelmatch' {
  interface PixelmatchOptions {
    /** YIQ colour-delta threshold, 0..1. Smaller is more sensitive. Default 0.1. */
    threshold?: number;
    /** When true, antialiased pixels are counted as differences. Default false. */
    includeAA?: boolean;
    /** Opacity of the original image in the diff output, 0..1. Default 0.1. */
    alpha?: number;
    /** RGB of antialiased pixels in the diff output. */
    aaColor?: [number, number, number];
    /** RGB of differing pixels in the diff output. */
    diffColor?: [number, number, number];
    /** RGB of differing pixels that got darker. */
    diffColorAlt?: [number, number, number];
    /** Draw the diff over a transparent background (mask), not over the original. */
    diffMask?: boolean;
  }

  export default function pixelmatch(
    img1: Uint8Array | Uint8ClampedArray,
    img2: Uint8Array | Uint8ClampedArray,
    output: Uint8Array | Uint8ClampedArray | null,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number;
}
