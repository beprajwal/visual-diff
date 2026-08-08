/**
 * store/internal — duration parsing for `.visual-diff/config.yaml`.
 *
 * The spec writes `readyTimeout: 90s`. A unit is mandatory: a bare `90` is ambiguous between
 * seconds and milliseconds, so it is rejected rather than guessed.
 */

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** `"90s"` → `90000`. Returns null for anything unitless, negative, empty or unparsable. */
export function parseDuration(input: string): number | null {
  const match = DURATION_RE.exec(input.trim());
  if (match === null) return null;
  const value = Number.parseFloat(match[1] as string);
  const unit = UNIT_MS[match[2] as string];
  if (!Number.isFinite(value) || unit === undefined) return null;
  return Math.round(value * unit);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`duration must be >= 0, got ${ms}`);
  if (ms % 3_600_000 === 0 && ms !== 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0 && ms !== 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0 && ms !== 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
