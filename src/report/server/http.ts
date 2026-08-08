/**
 * Small HTTP helpers shared by the report routes. Node's `http` only — no framework, no
 * middleware chain, nothing that could grow an execution surface (spec §9).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Maximum accepted request body. Feedback comments are text; anything larger is a mistake. */
export const MAX_BODY_BYTES = 64 * 1024;

/** An error that carries the status and machine code the client should see. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

/**
 * Headers sent on every response. The report is a local page over plain http; these keep other
 * local pages and mistyped content types from doing anything interesting.
 */
export function baseHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // No Access-Control-Allow-Origin, ever: nothing off-origin may read this server.
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.byteLength),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: HttpError): void {
  const body: { error: string; message: string; hint?: string } = {
    error: err.code,
    message: err.message,
  };
  if (err.hint !== undefined) body.hint = err.hint;
  sendJson(res, err.status, body);
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': contentType,
    'Content-Length': String(body.byteLength),
    ...extraHeaders,
  });
  res.end(body);
}

/** Read a request body with a hard cap; the socket is destroyed if the cap is exceeded. */
export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0) {
      throw new HttpError(400, 'bad-content-length', 'Content-Length is not a number.');
    }
    if (n > limit) {
      throw new HttpError(413, 'body-too-large', `Request body exceeds ${limit} bytes.`);
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new HttpError(413, 'body-too-large', `Request body exceeds ${limit} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve());
    req.on('error', (err) => reject(err));
  });
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse a request URL against the server's own origin. Never trusts the Host header for routing. */
export function parseUrl(req: IncomingMessage, origin: string): URL {
  return new URL(req.url ?? '/', origin);
}

/** Percent-decode one path segment, rejecting NUL and malformed escapes. */
export function decodeSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'bad-path', 'Path contains a malformed percent-escape.');
  }
  if (decoded.includes('\0')) {
    throw new HttpError(400, 'bad-path', 'Path contains a NUL byte.');
  }
  return decoded;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase()] ?? 'application/octet-stream';
}
