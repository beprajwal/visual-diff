/**
 * `vdiff serve` (spec §9).
 *
 * "binds 127.0.0.1 on an ephemeral port, writes serve.json containing the URL and a random session
 * token, and serves a prebuilt static UI shipped inside the package — no build step at install, no
 * CDN, nothing external."
 *
 * Two writes happen here and nowhere else in the module: `serve.json` at startup (removed at
 * shutdown), and — reachable from an HTTP request — the feedback append in `store-reader.ts`. No
 * request can spawn a process, run a build, or touch git (spec §9, D6).
 */

import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { Server } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { Config, ServeInfo, ServerEvent } from '../../types.js';
import { resolveUiDir } from './assets.js';
import type { AuthConfig } from './auth.js';
import { allowedOriginsFor, createSessionToken } from './auth.js';
import type { ComputeDiffFn, ReportStore } from './deps.js';
import { createDiffService } from './diff-service.js';
import type { DiffService } from './diff-service.js';
import { createRequestHandler } from './routes.js';
import type { ReportContext } from './routes.js';
import { SseHub } from './sse.js';
import { createFsStore } from './store-reader.js';
import { createRunWatcher } from './watcher.js';
import type { RunWatcher } from './watcher.js';

export const SERVE_INFO_FILE = 'serve.json';
export const DEFAULT_HOST = '127.0.0.1';

export interface ReportServerOptions {
  /** Loaded project config; `config.dir` is the `.visual-diff` directory. */
  config: Config;
  /** 0 or omitted binds an ephemeral port (the documented default). */
  port?: number;
  /** Loopback only. Overridable for tests, never for exposure. */
  host?: string;
  /** The diff engine. Without it the server serves stored diffs and computes nothing. */
  computeDiff?: ComputeDiffFn;
  /** Alternative store implementation; defaults to the filesystem store over `config.dir`. */
  store?: ReportStore;
  /** Flow the page should preselect (`vdiff serve --flow`). */
  flow?: string;
  /** Live channel; on by default. */
  watch?: boolean;
  /** Write `.visual-diff/serve.json`; on by default. */
  writeServeInfo?: boolean;
  /** Explicit UI bundle directory; defaults to the one shipped in the package. */
  uiDir?: string;
  now?: () => Date;
  onError?: (err: unknown) => void;
  sessionToken?: string;
}

export interface ReportServer {
  readonly info: ServeInfo;
  readonly url: string;
  readonly store: ReportStore;
  readonly diffs: DiffService;
  /** Push an event to every connected page. Used by tests and by the watcher. */
  emit(event: ServerEvent): void;
  /** Connected SSE clients. */
  readonly clients: number;
  close(): Promise<void>;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // SSE holds sockets open forever; without this, close() never completes.
    server.closeAllConnections?.();
  });
}

export async function startReportServer(options: ReportServerOptions): Promise<ReportServer> {
  const now = options.now ?? ((): Date => new Date());
  const host = options.host ?? DEFAULT_HOST;
  const store = options.store ?? createFsStore(options.config);
  const token = options.sessionToken ?? createSessionToken();
  const hub = new SseHub();

  const diffs = createDiffService({
    store,
    config: options.config,
    computeDiff: options.computeDiff ?? null,
  });

  const uiDir = await resolveUiDir(options.uiDir);

  // The allowed-origin set needs the bound port, so it is populated in place after listen().
  const allowedOrigins = new Set<string>();
  const auth: AuthConfig = { token, allowedOrigins };
  const ctx: ReportContext = {
    store,
    diffs,
    hub,
    auth,
    origin: `http://${host}`,
    uiDir,
    flow: options.flow ?? null,
    now,
  };

  const server = http.createServer(createRequestHandler(ctx));
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });
  // A stalled client must not pin a socket forever.
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;

  await listen(server, host, options.port ?? 0);

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('The report server did not bind a TCP port.');
  }

  const port = address.port;
  const origin = `http://${host}:${port}`;
  ctx.origin = origin;
  for (const allowed of allowedOriginsFor(port)) allowedOrigins.add(allowed);

  const info: ServeInfo = {
    url: `${origin}/?token=${encodeURIComponent(token)}`,
    host,
    port,
    token,
    pid: process.pid,
    root: options.config.root,
    startedAt: now().toISOString(),
  };

  const serveInfoFile = path.join(options.config.dir, SERVE_INFO_FILE);
  const writeServeInfo = options.writeServeInfo !== false;
  if (writeServeInfo) {
    await fs.mkdir(options.config.dir, { recursive: true });
    // 0600: the token in this file is the only credential the server has.
    await fs.writeFile(serveInfoFile, `${JSON.stringify(info, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  let watcher: RunWatcher | null = null;
  if (options.watch !== false) {
    watcher = createRunWatcher({
      storeDir: options.config.dir,
      store,
      diffs,
      emit: (event) => hub.broadcast(event),
      now,
      ...(options.onError ? { onError: options.onError } : {}),
    });
    await watcher.ready;
  }

  let closed = false;
  return {
    info,
    url: info.url,
    store,
    diffs,
    emit: (event) => hub.broadcast(event),
    get clients() {
      return hub.size;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (watcher) await watcher.close();
      hub.close();
      await closeServer(server);
      if (writeServeInfo) {
        // Remove only our own file: a second server that took over must keep its entry.
        try {
          const raw = await fs.readFile(serveInfoFile, 'utf8');
          const stored = JSON.parse(raw) as Partial<ServeInfo>;
          if (stored.pid === info.pid && stored.port === info.port) {
            await fs.rm(serveInfoFile, { force: true });
          }
        } catch {
          /* nothing to clean up */
        }
      }
    },
  };
}

/**
 * Module edge (spec §5): start the report server and hand back its {@link ServeInfo} plus a close
 * handle. `vdiff serve` calls exactly this.
 */
export async function serveReport(options: ReportServerOptions): Promise<ReportServer> {
  return startReportServer(options);
}
