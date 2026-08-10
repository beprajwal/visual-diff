/**
 * `e2e/` — test support: synthesizing trace archives.
 *
 * §9 puts committed fixture traces at the top of the testing list, and they are the right way to
 * prove the reader handles what real suites produce. They are not a way to prove the §8 *error*
 * matrix: a trace declaring version 9, a v7 archive using the pre-rename `apiName` field, an
 * archive with zero screencast frames, a zip with no `.trace` entry, a truncated file. Those cannot
 * be recorded — they have to be constructed.
 *
 * So this module writes zips. The writer is deliberately small (stored and deflate, no Zip64
 * writing) and was checked against Playwright's own reader before being trusted here. It exists
 * only for tests, and is a non-test file for the same reason `diff/testkit.ts` is: colocated test
 * files import it, and `tsconfig.json` excludes it from the published build by excluding tests, not
 * by excluding this file — so it is written to the same standard as the rest.
 */

import { deflateRawSync } from 'node:zlib';

import jpeg from 'jpeg-js';

import { crc32 } from './zip.js';

export interface ZipInput {
  name: string;
  data: Uint8Array | string;
  /** `stored` keeps the bytes verbatim, which is what Playwright uses for screenshots. */
  method?: 'stored' | 'deflate';
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Builds a zip in memory. Entries appear in the central directory in the order given. */
export function buildZip(inputs: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const input of inputs) {
    const name = Buffer.from(input.name, 'utf8');
    const raw = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : Buffer.from(input.data);
    const deflated = input.method === 'deflate';
    const body = deflated ? deflateRawSync(raw) : raw;
    const method = deflated ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(inputs.length, 8);
  eocd.writeUInt16LE(inputs.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

/* ------------------------------------------------------------------ JPEG */

/**
 * The smallest thing that is honestly a JPEG for dimension-reading purposes: SOI, a baseline SOF0
 * carrying the size, then EOI. The reader only ever looks at the frame header, so a real encoder
 * would add nothing but bytes.
 */
export function fakeJpeg(width: number, height: number, filler = 0): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2); // segment length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9); // components
  for (let i = 0; i < 3; i += 1) {
    sof.writeUInt8(i + 1, 10 + i * 3);
    sof.writeUInt8(0x11, 11 + i * 3);
    sof.writeUInt8(0, 12 + i * 3);
  }
  const padding = Buffer.alloc(filler, 0x5a);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, padding, Buffer.from([0xff, 0xd9])]);
}

/**
 * A JPEG that actually decodes, unlike {@link fakeJpeg}.
 *
 * The reader only ever reads the frame header, so a header-only file is enough for it. **Ingestion
 * decodes**: `image.ts` turns every frame into the PNG the diff engine reads, so an archive built
 * for an ingest test has to carry real entropy-coded data or the conversion fails — which is the
 * one thing an ingest test must not be fooled about.
 *
 * The fill is a solid colour with a single contrasting band, so two archives built with different
 * colours produce genuinely different pixels and a diff over them is a diff of something.
 */
export function realJpeg(
  width: number,
  height: number,
  colour: readonly [number, number, number] = [200, 210, 220],
  band?: { y: number; h: number; colour: readonly [number, number, number] },
): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const inBand = band !== undefined && y >= band.y && y < band.y + band.h;
    const [r, g, b] = inBand ? band.colour : colour;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = r as number;
      data[offset + 1] = g as number;
      data[offset + 2] = b as number;
      data[offset + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ width, height, data }, 90).data);
}

/* ------------------------------------------------------------------ trace archives */

export type TraceLine = Record<string, unknown>;

export interface TracePrefixInput {
  /** `trace` for a library archive; `0-trace`, `1-trace`, `test` for a runner one. */
  prefix: string;
  events: readonly TraceLine[];
  /** Lines of `trace.network`; omit for the zero-byte file a snapshot-less trace writes. */
  network?: readonly TraceLine[];
  stacks?: unknown;
}

export interface TraceArchiveInput {
  prefixes: readonly TracePrefixInput[];
  resources?: Readonly<Record<string, Uint8Array | string>>;
  /** Compress the trace entries, as Playwright does. */
  deflate?: boolean;
}

export function ndjson(lines: readonly TraceLine[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

/** Assembles a trace archive from raw event lines. */
export function buildTraceArchive(input: TraceArchiveInput): Buffer {
  const method: ZipInput['method'] = input.deflate ? 'deflate' : 'stored';
  const entries: ZipInput[] = [];
  for (const prefix of input.prefixes) {
    entries.push({ name: `${prefix.prefix}.trace`, data: ndjson(prefix.events), method });
    if (prefix.network !== undefined) {
      entries.push({ name: `${prefix.prefix}.network`, data: ndjson(prefix.network), method });
    }
    if (prefix.stacks !== undefined) {
      entries.push({
        name: `${prefix.prefix}.stacks`,
        data: JSON.stringify(prefix.stacks),
        method,
      });
    }
  }
  for (const [name, data] of Object.entries(input.resources ?? {})) {
    entries.push({ name, data, method: 'stored' });
  }
  return buildZip(entries);
}

/* ------------------------------------------------------------------ event builders */

export interface ContextOptionsInput {
  version?: number;
  origin?: 'library' | 'testRunner';
  title?: string;
  browserName?: string;
  playwrightVersion?: string;
  platform?: string;
  wallTime?: number;
  monotonicTime?: number;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  channel?: string;
  colorScheme?: string;
  locale?: string;
}

export function contextOptions(input: ContextOptionsInput = {}): TraceLine {
  const options: Record<string, unknown> = {
    viewport: input.viewport ?? { width: 900, height: 600 },
    deviceScaleFactor: input.deviceScaleFactor ?? 1,
  };
  if (input.colorScheme !== undefined) options.colorScheme = input.colorScheme;
  if (input.locale !== undefined) options.locale = input.locale;
  if (input.channel !== undefined) options.channel = input.channel;
  const line: TraceLine = {
    version: input.version ?? 8,
    type: 'context-options',
    origin: input.origin ?? 'library',
    browserName: input.browserName ?? 'chromium',
    playwrightVersion: input.playwrightVersion ?? '1.62.1',
    platform: input.platform ?? 'darwin',
    wallTime: input.wallTime ?? 1_786_379_958_761,
    monotonicTime: input.monotonicTime ?? 395.227,
    sdkLanguage: 'javascript',
    options,
  };
  if (input.title !== undefined) line.title = input.title;
  return line;
}

export interface ActionInput {
  callId: string;
  class?: string;
  method?: string;
  title?: string;
  /** The pre-v8 spelling of `title`, for building a version 7 archive. */
  apiName?: string;
  stepId?: string;
  parentId?: string;
  pageId?: string;
  params?: Record<string, unknown>;
  startTime: number;
  endTime?: number;
  beforeSnapshot?: string;
  afterSnapshot?: string;
  error?: { error?: { message?: string; stack?: string } } | { message?: string };
}

/** A `before`/`after` pair, which is how one action appears in a trace. */
export function action(input: ActionInput): TraceLine[] {
  const before: TraceLine = {
    type: 'before',
    callId: input.callId,
    startTime: input.startTime,
    class: input.class ?? 'Frame',
    method: input.method ?? 'click',
    params: input.params ?? {},
  };
  if (input.title !== undefined) before.title = input.title;
  if (input.apiName !== undefined) before.apiName = input.apiName;
  if (input.stepId !== undefined) before.stepId = input.stepId;
  if (input.parentId !== undefined) before.parentId = input.parentId;
  if (input.pageId !== undefined) before.pageId = input.pageId;
  if (input.beforeSnapshot !== undefined) before.beforeSnapshot = input.beforeSnapshot;

  const after: TraceLine = {
    type: 'after',
    callId: input.callId,
    endTime: input.endTime ?? input.startTime + 10,
  };
  if (input.afterSnapshot !== undefined) after.afterSnapshot = input.afterSnapshot;
  if (input.error !== undefined) after.error = input.error;
  return [before, after];
}

export interface ScreencastFrameInput {
  pageId: string;
  sha1: string;
  /** The *logical viewport*, which is what the event carries — never the image size. */
  width?: number;
  height?: number;
  timestamp: number;
  frameSwapWallTime?: number;
}

export function screencastFrame(input: ScreencastFrameInput): TraceLine {
  const line: TraceLine = {
    type: 'screencast-frame',
    pageId: input.pageId,
    sha1: input.sha1,
    width: input.width ?? 900,
    height: input.height ?? 600,
    timestamp: input.timestamp,
  };
  if (input.frameSwapWallTime !== undefined) line.frameSwapWallTime = input.frameSwapWallTime;
  return line;
}

export interface FrameSnapshotInput {
  callId: string;
  snapshotName: string;
  pageId: string;
  frameId?: string;
  frameUrl?: string;
  html: unknown;
  viewport?: { width: number; height: number };
  timestamp: number;
  wallTime?: number;
  isMainFrame?: boolean;
}

export function frameSnapshot(input: FrameSnapshotInput): TraceLine {
  return {
    type: 'frame-snapshot',
    snapshot: {
      callId: input.callId,
      snapshotName: input.snapshotName,
      pageId: input.pageId,
      frameId: input.frameId ?? `frame@${input.pageId}`,
      frameUrl: input.frameUrl ?? 'http://localhost/',
      html: input.html,
      viewport: input.viewport ?? { width: 900, height: 600 },
      timestamp: input.timestamp,
      wallTime: input.wallTime ?? 1_786_379_958_900,
      collectionTime: 1.5,
      resourceOverrides: [],
      isMainFrame: input.isMainFrame ?? true,
    },
  };
}

export function consoleEvent(input: {
  messageType?: string;
  text: string;
  time: number;
  pageId?: string;
  url?: string;
  lineNumber?: number;
}): TraceLine {
  return {
    type: 'console',
    messageType: input.messageType ?? 'log',
    text: input.text,
    args: [],
    location: {
      url: input.url ?? 'http://localhost/',
      lineNumber: input.lineNumber ?? 1,
      columnNumber: 1,
    },
    time: input.time,
    ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
  };
}

export function resourceSnapshot(input: {
  url: string;
  method?: string;
  status?: number;
  resourceType?: string;
  monotonicTime: number;
  time?: number;
  pageref?: string;
  startedDateTime?: string;
}): TraceLine {
  return {
    type: 'resource-snapshot',
    snapshot: {
      pageref: input.pageref ?? 'page@1',
      startedDateTime: input.startedDateTime ?? '2026-08-10T16:39:18.901Z',
      time: input.time ?? 5.697,
      request: { method: input.method ?? 'GET', url: input.url, headers: [] },
      response: { status: input.status ?? 200, headers: [], content: { size: 10 } },
      _monotonicTime: input.monotonicTime,
      _resourceType: input.resourceType ?? 'document',
    },
  };
}
