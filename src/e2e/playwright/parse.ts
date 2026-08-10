/**
 * `e2e/playwright` — finding the trace files in an archive, and reading their NDJSON.
 *
 * ### There are two archive layouts, and assuming one silently mis-parses the other
 *
 * A library trace (`context.tracing.stop({ path })`) holds `trace.trace`, `trace.network` and
 * `trace.stacks`. A `@playwright/test` archive holds `test.trace` — the runner's own hooks,
 * fixtures and `test.step` tree, with no `.network` or `.stacks` sibling — plus **one numbered
 * prefix per BrowserContext**: `0-trace.*`, `1-trace.*`. The ordinal is not creation order.
 *
 * So discovery cannot key on a filename. It does what Playwright's own loader does: glob every
 * entry matching `(.+)\.trace$`, take the captured prefix, and read `prefix + ".network"` and
 * `prefix + ".stacks"` if they happen to exist. `test.trace` matches with prefix `test`, and its
 * missing siblings are simply missing.
 */

import { traceCorrupt } from '../errors.js';
import type { AnyTraceEvent, ResourceSnapshotEvent } from './events.js';

const TRACE_ENTRY = /^(.+)\.trace$/;

/**
 * Trace prefixes in a stable order: numbered context prefixes first and numerically, then everything
 * else alphabetically.
 *
 * Order is not semantically meaningful — actions are merged and sorted by wall time — but it decides
 * which context-options title is read first, and a reader that returns a different answer depending
 * on zip entry order is a reader whose output is not reproducible.
 */
export function discoverTracePrefixes(entryNames: readonly string[]): string[] {
  const prefixes: string[] = [];
  for (const name of entryNames) {
    if (name.includes('/')) continue;
    const match = TRACE_ENTRY.exec(name);
    if (match !== null && match[1] !== undefined) prefixes.push(match[1]);
  }
  return [...new Set(prefixes)].sort(comparePrefixes);
}

function comparePrefixes(a: string, b: string): number {
  const numberA = numericPrefix(a);
  const numberB = numericPrefix(b);
  if (numberA !== null && numberB !== null) return numberA - numberB;
  if (numberA !== null) return -1;
  if (numberB !== null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function numericPrefix(prefix: string): number | null {
  const match = /^(\d+)-trace$/.exec(prefix);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Parses one NDJSON trace file.
 *
 * Blank lines are skipped — a `.network` file that recorded nothing is a zero-byte entry, and a
 * trailing newline is normal. Anything else that is not a JSON object is corruption, reported with
 * the entry and line number, because "unexpected token at position 41213" is not a thing anyone can
 * act on.
 */
export function parseTraceEvents(
  archivePath: string,
  entryName: string,
  text: string,
): AnyTraceEvent[] {
  const events: AnyTraceEvent[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw traceCorrupt(
        archivePath,
        `${entryName} line ${index + 1} is not valid JSON`,
        cause,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw traceCorrupt(archivePath, `${entryName} line ${index + 1} is not a trace event object`);
    }
    const event = parsed as { type?: unknown };
    if (typeof event.type !== 'string') {
      throw traceCorrupt(
        archivePath,
        `${entryName} line ${index + 1} has no 'type': it is not a trace event`,
      );
    }
    events.push(event as AnyTraceEvent);
  }
  return events;
}

/**
 * Parses a `*.network` file.
 *
 * Every line is `{"type":"resource-snapshot","snapshot":<HAR entry>}`. The file is **zero bytes
 * whenever tracing ran with `snapshots: false`** — network is gated on DOM snapshots, with no flag
 * of its own — so an empty result here is a capture setting, not a fault.
 */
export function parseNetworkEvents(
  archivePath: string,
  entryName: string,
  text: string,
): ResourceSnapshotEvent[] {
  const out: ResourceSnapshotEvent[] = [];
  for (const event of parseTraceEvents(archivePath, entryName, text)) {
    if (event.type !== 'resource-snapshot') continue;
    const snapshot = (event as { snapshot?: unknown }).snapshot;
    if (snapshot === null || typeof snapshot !== 'object') continue;
    out.push(event as unknown as ResourceSnapshotEvent);
  }
  return out;
}
