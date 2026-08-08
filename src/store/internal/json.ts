/**
 * store/internal — stable JSON serialization.
 *
 * Every JSON blob the store writes goes through `stableStringify`, so `meta.json` and
 * `findings.json` are byte-stable across runs and machines. The golden diff tests (spec §11.3)
 * depend on that; so does any human reading a `git diff` of a checked-in fixture run.
 */

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value instanceof Uint8Array) return Array.from(value);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      // `undefined` is not representable in JSON; dropping it keeps optional fields absent
      // rather than emitting `null`, which the contracts in types.ts distinguish.
      if (child === undefined) continue;
      out[key] = sortValue(child);
    }
    return out;
  }
  return value;
}

export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortValue(value), null, indent);
}

/** One line, no indent — for JSONL sinks where a line must never contain a newline. */
export function stableStringifyLine(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
