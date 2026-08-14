/**
 * The complete route table (spec §9).
 *
 *   GET  /                        the report shell (prebuilt UI, served from dist)
 *   GET  /<asset>                 files of the prebuilt UI bundle
 *   GET  /api/flows               FlowsResponse
 *   GET  /api/runs/:flow          RunsResponse
 *   GET  /api/attribution/:flow/:runId   RunAttribution (mocking spec §8)
 *   GET  /api/variant/:flow/:runId       RunVariantAttribution (variants spec §7)
 *   GET  /api/diff/:base..:head   DiffResponse (?flow=, or /api/diff/:flow/:base..:head)
 *   GET  /api/blob/<path>         stored artefacts under runs/ and diffs/
 *   GET  /api/events              SSE
 *   POST /api/feedback            appends one line to feedback/pending.jsonl
 *
 * That is the entire surface. There is no route that spawns a process, runs a build, or touches
 * git, and none may be added: the report is a viewer that appends JSON, and an agent decides what
 * to do with it (spec §9, D6).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { FeedbackAppendedEvent, HelloEvent, ServerEvent } from '../../types.js';
import { assetPathFor, cspHeader, createNonce, readAsset, renderShell } from './assets.js';
import {
  handleAttribution,
  handleDiff,
  handleFlows,
  handleRuns,
  handleVariantAttribution,
} from './api.js';
import type { AuthConfig } from './auth.js';
import { authenticate, sessionCookie } from './auth.js';
import { serveBlob } from './blobs.js';
import type { ReportStore } from './deps.js';
import type { DiffService } from './diff-service.js';
import { handleFeedbackRequest } from './feedback-api.js';
import {
  baseHeaders,
  contentTypeFor,
  decodeSegment,
  HttpError,
  parseUrl,
  sendError,
  sendJson,
} from './http.js';
import type { SseHub } from './sse.js';

import path from 'node:path';

export interface ReportContext {
  store: ReportStore;
  diffs: DiffService;
  hub: SseHub;
  auth: AuthConfig;
  /** The server's own origin, used to parse request URLs. */
  origin: string;
  /** Directory of the prebuilt UI bundle, or null when it has not been built. */
  uiDir: string | null;
  /** Flow the CLI was pointed at, handed to the page as a starting selection. */
  flow: string | null;
  now: () => Date;
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

async function helloEvent(ctx: ReportContext): Promise<HelloEvent> {
  const flows = await ctx.store.listFlows();
  return { type: 'hello', ts: ctx.now().toISOString(), flows: flows.map((f) => f.name) };
}

async function serveShell(ctx: ReportContext, res: ServerResponse): Promise<void> {
  const nonce = createNonce();
  const html = await renderShell({
    uiDir: ctx.uiDir,
    bootstrap: { token: ctx.auth.token, flow: ctx.flow },
    nonce,
  });
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    ...baseHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': cspHeader(nonce),
    // Lets every later request (assets, blobs, SSE) drop the ?token= query parameter.
    'Set-Cookie': sessionCookie(ctx.auth.token),
  });
  res.end(body);
}

async function serveUiAsset(
  ctx: ReportContext,
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.uiDir) {
    throw new HttpError(
      404,
      'ui-not-built',
      'The report UI bundle is missing from this installation.',
      'Rebuild the package with `pnpm build`.',
    );
  }
  const file = assetPathFor(ctx.uiDir, pathname);
  const body = file ? await readAsset(file) : null;
  if (!file || !body) {
    throw new HttpError(404, 'not-found', `No such asset: ${pathname}`);
  }
  res.writeHead(200, {
    ...baseHeaders(),
    'Content-Type': contentTypeFor(path.extname(file)),
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handleGet(ctx: ReportContext, url: URL, res: ServerResponse): Promise<void> {
  const pathname = normalizePath(url.pathname);

  if (pathname === '/api/flows') {
    sendJson(res, 200, await handleFlows(ctx.store));
    return;
  }

  if (pathname.startsWith('/api/runs/')) {
    const flow = decodeSegment(pathname.slice('/api/runs/'.length));
    sendJson(res, 200, await handleRuns(ctx.store, flow));
    return;
  }

  if (pathname.startsWith('/api/attribution/')) {
    const segments = pathname
      .slice('/api/attribution/'.length)
      .split('/')
      .filter((s) => s.length > 0);
    if (segments.length !== 2) {
      throw new HttpError(400, 'bad-path', 'Expected /api/attribution/<flow>/<runId>.');
    }
    sendJson(
      res,
      200,
      await handleAttribution(
        ctx.store,
        decodeSegment(segments[0] as string),
        decodeSegment(segments[1] as string),
      ),
    );
    return;
  }

  if (pathname.startsWith('/api/variant/')) {
    const segments = pathname
      .slice('/api/variant/'.length)
      .split('/')
      .filter((s) => s.length > 0);
    if (segments.length !== 2) {
      throw new HttpError(400, 'bad-path', 'Expected /api/variant/<flow>/<runId>.');
    }
    sendJson(
      res,
      200,
      await handleVariantAttribution(
        ctx.store,
        decodeSegment(segments[0] as string),
        decodeSegment(segments[1] as string),
      ),
    );
    return;
  }

  if (pathname.startsWith('/api/diff/')) {
    const rest = pathname.slice('/api/diff/'.length);
    const segments = rest.split('/').filter((s) => s.length > 0);
    let flow: string | null;
    let pairSpec: string;
    if (segments.length === 2) {
      flow = decodeSegment(segments[0] as string);
      pairSpec = decodeSegment(segments[1] as string);
    } else if (segments.length === 1) {
      flow = url.searchParams.get('flow');
      pairSpec = decodeSegment(segments[0] as string);
    } else {
      throw new HttpError(400, 'bad-path', 'Expected /api/diff/<base>..<head>?flow=<flow>.');
    }
    sendJson(res, 200, await handleDiff(ctx.diffs, flow ?? '', pairSpec));
    return;
  }

  if (pathname === '/api/events') {
    ctx.hub.open(res, [await helloEvent(ctx)]);
    return;
  }

  if (pathname.startsWith('/api/blob/')) {
    const raw = pathname.slice('/api/blob/'.length);
    const relative = raw
      .split('/')
      .map((segment) => decodeSegment(segment))
      .join('/');
    await serveBlob(ctx.store, relative, res);
    return;
  }

  if (pathname.startsWith('/api/')) {
    throw new HttpError(404, 'not-found', `No such endpoint: ${pathname}`);
  }

  if (pathname === '' || pathname === '/' || pathname === '/index.html') {
    await serveShell(ctx, res);
    return;
  }

  await serveUiAsset(ctx, pathname, res);
}

async function handlePost(
  ctx: ReportContext,
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  if (normalizePath(url.pathname) !== '/api/feedback') {
    throw new HttpError(404, 'not-found', `No such endpoint: ${url.pathname}`);
  }
  const entry = await handleFeedbackRequest(req, { store: ctx.store, now: ctx.now });
  const event: FeedbackAppendedEvent = {
    type: 'feedback',
    ts: ctx.now().toISOString(),
    entry,
  };
  ctx.hub.broadcast(event);
  sendJson(res, 201, entry);
}

/** Build the single request handler passed to `http.createServer`. */
export function createRequestHandler(
  ctx: ReportContext,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void dispatch(ctx, req, res);
  };
}

export async function dispatch(
  ctx: ReportContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') {
      // No OPTIONS handler on purpose: without a preflight response, no cross-origin fetch can
      // ever reach a route here.
      throw new HttpError(405, 'method-not-allowed', `${method} is not supported.`);
    }

    const url = parseUrl(req, ctx.origin);
    const auth = authenticate(req, url, ctx.auth);
    if (!auth.ok) {
      sendJson(res, auth.status, { error: auth.code, message: auth.message });
      return;
    }

    if (method === 'GET') {
      await handleGet(ctx, url, res);
    } else {
      await handlePost(ctx, req, url, res);
    }
  } catch (err) {
    reportFailure(ctx, res, err);
  }
}

function reportFailure(ctx: ReportContext, res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    // A stream (SSE or a blob) already started; the only honest thing left is to drop it.
    if (!res.writableEnded) res.end();
    return;
  }
  if (err instanceof HttpError) {
    sendError(res, err);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const event: ServerEvent = { type: 'error', ts: ctx.now().toISOString(), message };
  ctx.hub.broadcast(event);
  sendJson(res, 500, { error: 'internal', message });
}
