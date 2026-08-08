/**
 * Session-token gate (spec §9).
 *
 * "Localhost binding plus a session token keeps other local processes and browser tabs out."
 * Every route goes through {@link authenticate} — API, SSE, blobs and the UI shell alike. There is
 * no unauthenticated path and no CORS allowance, so a page on another origin can neither read a
 * response nor mint a request that the server will act on.
 *
 * Three carriers are accepted, in order: the `X-Vdiff-Token` header (what the UI's fetch calls
 * use), the `token` query parameter (what the first navigation carries), and the `vdiff_token`
 * cookie (set from that first navigation so image and blob requests need no query string). The
 * cookie is `SameSite=Strict; HttpOnly`, so a cross-site request never carries it.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const TOKEN_HEADER = 'x-vdiff-token';
export const TOKEN_QUERY = 'token';
export const TOKEN_COOKIE = 'vdiff_token';

/** Hostnames the server answers on. Anything else is a DNS-rebinding attempt. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export type TokenSource = 'header' | 'query' | 'cookie';

export type AuthResult =
  | { ok: true; source: TokenSource }
  | { ok: false; status: 401 | 403; code: string; message: string };

export interface AuthConfig {
  token: string;
  /** Origins allowed to talk to this server: our own, under every local hostname spelling. */
  allowedOrigins: ReadonlySet<string>;
}

/** A fresh 256-bit session token. Regenerated on every `vdiff serve`. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function allowedOriginsFor(port: number): Set<string> {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
}

/** Constant-time string comparison that does not leak the token length through early exit. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.byteLength !== right.byteLength) {
    // Still burn a comparison so the failure costs the same as a mismatched value.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  // Null-prototype: a cookie literally named `__proto__` must not touch the object's prototype.
  const out = Object.create(null) as Record<string, string>;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Strip the port from a Host header value, tolerating bracketed IPv6. */
export function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value.toLowerCase() : value.slice(0, end + 1).toLowerCase();
  }
  const colon = value.lastIndexOf(':');
  return (colon === -1 ? value : value.slice(0, colon)).toLowerCase();
}

/** The Set-Cookie value that lets subsequent requests drop the `?token=` query parameter. */
export function sessionCookie(token: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}

export function extractToken(
  req: IncomingMessage,
  url: URL,
): { token: string; source: TokenSource } | null {
  const header = req.headers[TOKEN_HEADER];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (headerValue) return { token: headerValue, source: 'header' };

  const query = url.searchParams.get(TOKEN_QUERY);
  if (query) return { token: query, source: 'query' };

  const cookie = parseCookies(req.headers.cookie)[TOKEN_COOKIE];
  if (cookie) return { token: cookie, source: 'cookie' };

  return null;
}

/**
 * Gate one request. Order matters: host and origin are cheap structural checks that reject a
 * cross-origin caller before the token is even looked at.
 */
export function authenticate(req: IncomingMessage, url: URL, config: AuthConfig): AuthResult {
  const host = req.headers.host;
  if (!host || !LOCAL_HOSTS.has(hostnameOf(host))) {
    return {
      ok: false,
      status: 403,
      code: 'bad-host',
      message: 'The report server answers on localhost only.',
    };
  }

  // An Origin header is present on every cross-origin request a browser can make (and on
  // same-origin POSTs). Absent means a non-browser caller, which still has to present the token.
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (origin !== undefined && !config.allowedOrigins.has(origin)) {
    return {
      ok: false,
      status: 403,
      code: 'cross-origin',
      message: 'Cross-origin requests are rejected.',
    };
  }

  const fetchSiteHeader = req.headers['sec-fetch-site'];
  const fetchSite = Array.isArray(fetchSiteHeader) ? fetchSiteHeader[0] : fetchSiteHeader;
  if (fetchSite === 'cross-site') {
    return {
      ok: false,
      status: 403,
      code: 'cross-origin',
      message: 'Cross-site requests are rejected.',
    };
  }

  const presented = extractToken(req, url);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      code: 'missing-token',
      message: 'A session token is required. It is written to .visual-diff/serve.json.',
    };
  }
  if (!safeEqual(presented.token, config.token)) {
    return {
      ok: false,
      status: 401,
      code: 'bad-token',
      message: 'Invalid session token.',
    };
  }
  return { ok: true, source: presented.source };
}
