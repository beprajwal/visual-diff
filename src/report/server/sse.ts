/**
 * SSE hub for `GET /api/events` (spec §9, D6).
 *
 * One-way push only: the server tells the page that a run landed or a diff is ready, and the page
 * decides whether to follow. There is no inbound channel here — feedback travels over an ordinary
 * POST, and nothing on this socket can ask the server to do anything.
 */

import type { ServerResponse } from 'node:http';

import type { ServerEvent } from '../../types.js';
import { baseHeaders } from './http.js';

/** Heartbeat comment interval. Keeps proxies and sleeping sockets from silently dropping. */
export const HEARTBEAT_MS = 15_000;

/** Serialize one event into an SSE frame. Pure, so framing is testable without a socket. */
export function formatEvent(event: ServerEvent): string {
  const data = JSON.stringify(event);
  return `event: ${event.type}\ndata: ${data}\n\n`;
}

export interface SseClient {
  write(chunk: string): boolean;
  end(): void;
  onClose(listener: () => void): void;
}

/** Adapt a Node response to the minimal client surface the hub needs. */
export function responseClient(res: ServerResponse): SseClient {
  return {
    write: (chunk) => res.write(chunk),
    end: () => {
      if (!res.writableEnded) res.end();
    },
    onClose: (listener) => {
      res.on('close', listener);
    },
  };
}

export class SseHub {
  private readonly clients = new Set<SseClient>();
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly heartbeatMs: number = HEARTBEAT_MS) {}

  get size(): number {
    return this.clients.size;
  }

  /** Write the SSE preamble to a fresh response and register it. */
  open(res: ServerResponse, initial: ServerEvent[] = []): SseClient {
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Disable proxy buffering; a buffered event stream is a broken event stream.
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    const client = responseClient(res);
    this.add(client, initial);
    return client;
  }

  add(client: SseClient, initial: ServerEvent[] = []): void {
    if (this.closed) {
      client.end();
      return;
    }
    this.clients.add(client);
    client.onClose(() => this.remove(client));
    for (const event of initial) {
      client.write(formatEvent(event));
    }
    this.startHeartbeat();
  }

  remove(client: SseClient): void {
    this.clients.delete(client);
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  /** Fan one event out to every connected page. A dead socket is dropped, never retried. */
  broadcast(event: ServerEvent): void {
    if (this.closed) return;
    const frame = formatEvent(event);
    for (const client of [...this.clients]) {
      try {
        client.write(frame);
      } catch {
        this.remove(client);
      }
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    for (const client of [...this.clients]) {
      try {
        client.end();
      } catch {
        /* the socket is already gone */
      }
    }
    this.clients.clear();
  }

  private startHeartbeat(): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => {
      for (const client of [...this.clients]) {
        try {
          client.write(`: heartbeat\n\n`);
        } catch {
          this.remove(client);
        }
      }
    }, this.heartbeatMs);
    // Never hold the process open for a heartbeat.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
