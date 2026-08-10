/**
 * `e2e/` — reading a JPEG's real dimensions.
 *
 * This is the single most consequential correction the trace format forces on §4. A
 * `screencast-frame` event carries `width` and `height`, and they are *not* the image's size: they
 * are the logical viewport. Playwright downscales every screencast frame to fit an 800x800 box —
 *
 *     scale = min(1, 800 / max(viewport.width, viewport.height))
 *
 * — and then lets the browser aspect-fit the request, so the delivered size does not even reliably
 * equal that formula (a 400x900 viewport asks for 354x800 and is handed 354x797, an odd height).
 * `deviceScaleFactor` is discarded entirely: 900x600 at dsf 1 and at dsf 2 both produce 798x532.
 *
 * A reader that trusts the event, or reimplements the formula, mis-sizes every shot. So we read the
 * frame header, which is the only source that cannot be wrong.
 */

export interface JpegSize {
  width: number;
  height: number;
}

const SOI = 0xffd8;

/**
 * Markers that carry a frame header. All the SOF variants (baseline, progressive, lossless,
 * arithmetic) share the layout; the four excluded codes in the 0xC0–0xCF range are not frame
 * headers at all: DHT (C4), JPG (C8), DAC (CC), and the RSTn markers live elsewhere.
 */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xffc0 && marker <= 0xffcf && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc;
}

/**
 * Dimensions of a JPEG, or `null` when the bytes are not a JPEG or carry no frame header.
 *
 * Returning `null` rather than throwing keeps the decision about what an unreadable screenshot
 * means with the caller: for the reader it is a corrupt archive, and it phrases that itself.
 */
export function readJpegSize(bytes: Uint8Array): JpegSize | null {
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== SOI) return null;

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    // Segments are byte-aligned but fill bytes (0xFF) may pad the gap between them.
    if (view.getUint8(offset) !== 0xff) {
      offset += 1;
      continue;
    }
    let markerByte = view.getUint8(offset + 1);
    while (markerByte === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      markerByte = view.getUint8(offset + 1);
    }
    const marker = 0xff00 | markerByte;

    // Standalone markers: no length field follows.
    if (markerByte === 0xd8 || markerByte === 0x01 || (markerByte >= 0xd0 && markerByte <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (markerByte === 0xd9) return null; // EOI before any frame header
    if (offset + 4 > bytes.length) return null;
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;

    if (isFrameMarker(marker)) {
      if (offset + 9 > bytes.length) return null;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    // Entropy-coded data follows SOS and contains no further frame header worth finding.
    if (markerByte === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

/** Whether these bytes begin with the JPEG start-of-image marker. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}
