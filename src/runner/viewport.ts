/**
 * Viewport ids and the viewport worker pool (spec §7).
 *
 * Viewports are independent full replays in separate browser contexts, run concurrently up to a
 * worker cap. Reusing one context across viewports carries scroll position, focus and storage,
 * which makes mobile results depend on desktop having run first — so the pool never shares state
 * between items, and one failing viewport never cancels the others.
 */

import { EXIT, type Viewport, type ViewportId } from '../types.js';
import { RunnerError } from './errors.js';

const VIEWPORT_RE = /^(\d{1,5})x(\d{1,5})$/;

export function tryParseViewport(id: string): Viewport | null {
  const match = VIEWPORT_RE.exec(id.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { id: `${width}x${height}`, width, height };
}

export function parseViewport(id: string): Viewport {
  const viewport = tryParseViewport(id);
  if (!viewport) {
    throw new RunnerError({
      code: 'invalid-viewport',
      message: `invalid viewport '${id}': expected WIDTHxHEIGHT, e.g. 1280x800`,
      exitCode: EXIT.CONFIG_ERROR,
      kind: 'flow-invalid',
    });
  }
  return viewport;
}

export function formatViewport(width: number, height: number): ViewportId {
  return `${width}x${height}`;
}

/** Parse, validate and de-duplicate a viewport list, preserving first-seen order. */
export function normalizeViewports(ids: readonly string[]): Viewport[] {
  const seen = new Set<ViewportId>();
  const out: Viewport[] = [];
  for (const id of ids) {
    const viewport = parseViewport(id);
    if (seen.has(viewport.id)) continue;
    seen.add(viewport.id);
    out.push(viewport);
  }
  if (out.length === 0) {
    throw new RunnerError({
      code: 'no-viewports',
      message: 'no viewports to replay: the flow, the config and --viewport are all empty',
      exitCode: EXIT.CONFIG_ERROR,
      kind: 'flow-invalid',
    });
  }
  return out;
}

export type PoolOutcome<R> = { ok: true; value: R } | { ok: false; error: unknown };

/**
 * Run `fn` over `items` with at most `limit` in flight. Results keep input order and a rejection is
 * captured per item rather than aborting its siblings — a failed mobile replay must still leave a
 * complete desktop replay behind.
 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PoolOutcome<R>>> {
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  const results = new Array<PoolOutcome<R>>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = { ok: true, value: await fn(item, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
