/**
 * The prebuilt report UI, shipped inside the package (spec §9): "a prebuilt static UI shipped
 * inside the package — no build step at install, no CDN, nothing external."
 *
 * This file resolves that bundle on disk and serves it. It never fetches, never builds, and the
 * page it emits carries a Content-Security-Policy that forbids loading anything off-origin, so a
 * regression in the UI cannot quietly reintroduce a CDN dependency.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/** Files the UI bundle may consist of; anything else 404s. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BootstrapData {
  token: string;
  /** Flow the CLI was pointed at, when `vdiff serve --flow` was used. */
  flow: string | null;
}

/**
 * Candidate locations of the built UI, in order:
 *  - `dist/ui`, relative to this file once compiled to `dist/report/server/`
 *  - `<repo>/dist/ui`, when running from `src/` (vitest, `tsx`, local development)
 */
export function uiDirCandidates(moduleUrl: string): string[] {
  const here = path.dirname(fileURLToPath(moduleUrl));
  return [
    path.resolve(here, '../../ui'),
    path.resolve(here, '../../../dist/ui'),
  ];
}

async function isDir(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** First candidate directory that exists, or null when the UI has not been built. */
export async function resolveUiDir(
  explicit?: string,
  moduleUrl: string = import.meta.url,
): Promise<string | null> {
  const candidates = explicit ? [path.resolve(explicit)] : uiDirCandidates(moduleUrl);
  for (const candidate of candidates) {
    if (await isDir(candidate)) return candidate;
  }
  return null;
}

/** Map a URL path to a file inside the UI directory, or null when it is not a legal asset name. */
export function assetPathFor(uiDir: string, urlPath: string): string | null {
  const trimmed = urlPath.replace(/^\/+/, '');
  if (!trimmed) return null;
  const segments = trimmed.split('/');
  if (segments.length > 2) return null;
  if (!segments.every((s) => ASSET_NAME.test(s))) return null;
  if (segments.length === 2 && segments[0] !== 'assets') return null;
  const resolved = path.resolve(uiDir, ...segments);
  const inside = path.relative(uiDir, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return resolved;
}

export async function readAsset(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/** JSON safe to embed inside a <script> block. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function cspHeader(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function createNonce(): string {
  return randomBytes(16).toString('base64');
}

const FALLBACK_SHELL = (bootstrap: string, nonce: string, hasStyles: boolean): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>visual-diff</title>
${hasStyles ? '<link rel="stylesheet" href="/report.css" />' : ''}
<script nonce="${nonce}">window.__VDIFF__ = ${bootstrap};</script>
</head>
<body>
<!-- Same mount point the bundle auto-mounts into (src/report/ui/main.tsx). -->
<div id="vdiff-root">Loading the visual-diff report…</div>
<script type="module" src="/report.js"></script>
</body>
</html>
`;

export interface ShellOptions {
  uiDir: string | null;
  bootstrap: BootstrapData;
  nonce: string;
}

/**
 * The HTML document. When the bundle ships its own `index.html`, that file is used verbatim with
 * the bootstrap script injected; otherwise a minimal self-contained shell is emitted so the server
 * is useful before the UI bundle exists.
 */
export async function renderShell(options: ShellOptions): Promise<string> {
  const bootstrap = embedJson(options.bootstrap);
  const inline = `<script nonce="${options.nonce}">window.__VDIFF__ = ${bootstrap};</script>`;

  if (options.uiDir) {
    const indexFile = path.join(options.uiDir, 'index.html');
    const html = await readAsset(indexFile);
    if (html) {
      const text = html.toString('utf8');
      if (text.includes('</head>')) return text.replace('</head>', `${inline}\n</head>`);
      return `${inline}\n${text}`;
    }
  }

  const hasStyles = options.uiDir
    ? (await readAsset(path.join(options.uiDir, 'report.css'))) !== null
    : false;
  return FALLBACK_SHELL(bootstrap, options.nonce, hasStyles);
}
