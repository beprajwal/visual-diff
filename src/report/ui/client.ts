/**
 * Thin fetch wrappers over the report API (spec §9) plus the SSE subscription.
 *
 * Every route is gated by the per-session token from `serve.json`. The token arrives as a query
 * parameter on the first load; it is kept in `sessionStorage` so a reload without the parameter
 * still works, and it is re-attached to every request because `EventSource` and `<img>` cannot
 * carry headers.
 */

import type {
  DiffResponse,
  FeedbackEntry,
  FeedbackInput,
  FlowsResponse,
  RunId,
  RunsResponse,
  ServerEvent,
} from '../../types.js';
import { blobUrl } from './paths.js';

const TOKEN_STORAGE_KEY = 'vdiff.token';

/** Reads the session token from the URL, falling back to the one stored on first load. */
export function readToken(search: string = globalThis.location?.search ?? ''): string | null {
  const fromUrl = new URLSearchParams(search).get('token');
  if (fromUrl) {
    try {
      globalThis.sessionStorage?.setItem(TOKEN_STORAGE_KEY, fromUrl);
    } catch {
      // Private-mode storage failures are not fatal: the token still works for this page load.
    }
    return fromUrl;
  }
  try {
    return globalThis.sessionStorage?.getItem(TOKEN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface ApiClient {
  readonly token: string | null;
  flows(): Promise<FlowsResponse>;
  runs(flow: string): Promise<RunsResponse>;
  diff(flow: string, base: RunId, head: RunId): Promise<DiffResponse>;
  postFeedback(input: FeedbackInput): Promise<FeedbackEntry>;
  /** Absolute URL for a blob path relative to the `.visual-diff` directory. */
  blob(storePath: string): string;
  /** Subscribes to the live channel. Returns an unsubscribe function. */
  subscribe(handlers: SubscribeHandlers): () => void;
}

export interface SubscribeHandlers {
  onEvent(event: ServerEvent): void;
  onOpen?(): void;
  onClose?(): void;
}

export interface ClientOptions {
  token?: string | null;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected in tests. Defaults to the global `EventSource`. */
  eventSourceImpl?: typeof EventSource;
  /** Base path of the API, without a trailing slash. */
  apiBase?: string;
}

function withToken(url: string, token: string | null): string {
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export function createClient(options: ClientOptions = {}): ApiClient {
  const token = options.token !== undefined ? options.token : readToken();
  const apiBase = options.apiBase ?? '/api';
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function getJson<T>(path: string): Promise<T> {
    const response = await doFetch(withToken(`${apiBase}${path}`, token), {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'message' in body
          ? String((body as { message: unknown }).message)
          : `${response.status} ${response.statusText}`;
      throw new ApiError(response.status, message);
    }
    return body as T;
  }

  return {
    token,

    flows() {
      return getJson<FlowsResponse>('/flows');
    },

    runs(flow) {
      return getJson<RunsResponse>(`/runs/${encodeURIComponent(flow)}`);
    },

    diff(flow, base, head) {
      // Spec §9 names the route `/api/diff/:base..:head`; the flow rides along as a query
      // parameter because a pair id alone does not identify a flow.
      const pair = `${encodeURIComponent(base)}..${encodeURIComponent(head)}`;
      return getJson<DiffResponse>(`/diff/${pair}?flow=${encodeURIComponent(flow)}`);
    },

    async postFeedback(input) {
      const response = await doFetch(withToken(`${apiBase}/feedback`, token), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const message =
          body && typeof body === 'object' && 'message' in body
            ? String((body as { message: unknown }).message)
            : `${response.status} ${response.statusText}`;
        throw new ApiError(response.status, message);
      }
      return body as FeedbackEntry;
    },

    blob(storePath) {
      return blobUrl(storePath, token);
    },

    subscribe(handlers) {
      const Impl = options.eventSourceImpl ?? globalThis.EventSource;
      if (!Impl) {
        handlers.onClose?.();
        return () => undefined;
      }

      let closed = false;
      let source: EventSource | null = null;
      let retry: ReturnType<typeof setTimeout> | undefined;

      const open = (): void => {
        if (closed) return;
        source = new Impl(withToken(`${apiBase}/events`, token));
        source.onopen = () => handlers.onOpen?.();
        source.onmessage = (message: MessageEvent) => {
          try {
            handlers.onEvent(JSON.parse(String(message.data)) as ServerEvent);
          } catch {
            // A malformed frame is never worth tearing down the channel for.
          }
        };
        source.onerror = () => {
          handlers.onClose?.();
          // EventSource retries on its own while the connection is merely reconnecting; once it
          // gives up and closes, reopen on a fixed backoff so a server restart is survivable.
          if (source && source.readyState === 2 /* CLOSED */ && !closed) {
            source.close();
            source = null;
            retry = setTimeout(open, 2000);
          }
        };
      };

      open();

      return () => {
        closed = true;
        if (retry !== undefined) clearTimeout(retry);
        source?.close();
        source = null;
      };
    },
  };
}
