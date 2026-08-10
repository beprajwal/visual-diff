/**
 * `e2e/` — the typed ingestion failure (e2e spec §8).
 *
 * Every row of §8's table that ends in "exit 2" is constructed here and nowhere else, so the
 * message a user sees for an unreadable archive is one string with one test asserting it. As in
 * `store/` and `scenario/`, nothing calls `process.exit`: the error carries a `CliError` payload
 * and `cli/main.ts` maps `exitCode`.
 *
 * The messages deliberately do not reuse Playwright's own wording. Its viewer says "Please use
 * latest Playwright to open the trace", which is advice about a program the user is not running;
 * ours names the version found, the versions supported, and the file.
 */

import { EXIT, type CliError, type ExitCode } from '../types.js';

export const E2E_ERROR_CODES = [
  /** The path could not be opened, or is not a zip at all. */
  'e2e-archive-unreadable',
  /** It is a zip, but nothing inside it is a trace. */
  'e2e-not-a-trace',
  /** The trace declares a format version outside the supported range. */
  'e2e-trace-version-unsupported',
  /** The trace recorded no screenshots — §8: "a run with no shots is worse than none". */
  'e2e-no-screenshots',
  /** A trace line, or a resource the trace points at, is corrupt. */
  'e2e-trace-corrupt',
] as const;
export type E2eErrorCode = (typeof E2E_ERROR_CODES)[number];

export class E2eError extends Error implements CliError {
  readonly code: E2eErrorCode;
  /** Always `EXIT.CONFIG_ERROR` (2): every §8 row is a bad input, never a failed run. */
  readonly exitCode: ExitCode = EXIT.CONFIG_ERROR;
  readonly file: string;
  readonly hint?: string;

  constructor(
    code: E2eErrorCode,
    file: string,
    message: string,
    options: { hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'E2eError';
    this.code = code;
    this.file = file;
    if (options.hint !== undefined) this.hint = options.hint;
  }

  toCliError(): CliError {
    const out: CliError = { code: this.code, message: this.message, exitCode: this.exitCode };
    if (this.hint !== undefined) out.hint = this.hint;
    return out;
  }
}

export function isE2eError(value: unknown): value is E2eError {
  return value instanceof E2eError;
}

/* ------------------------------------------------------------------ §8 constructors */

/**
 * "path is not a readable trace archive", at the layer where the file is not even a zip.
 *
 * §8 lists one row for an unreadable archive; the file being absent, unreadable or simply not a zip
 * are different facts about it, so `detail` carries which one rather than flattening all three into
 * a single unhelpful sentence.
 */
export function archiveUnreadable(file: string, detail: string, cause?: unknown): E2eError {
  return new E2eError(
    'e2e-archive-unreadable',
    file,
    `not a readable trace archive: ${file} (${detail})`,
    {
      hint: 'a Playwright trace is a zip written by tracing.stop({ path }) or by the runner into test-results/',
      cause,
    },
  );
}

/** A readable zip with no `*.trace` entry: it is an archive, but not a trace one. */
export function notATrace(file: string, entryCount: number): E2eError {
  return new E2eError(
    'e2e-not-a-trace',
    file,
    `not a Playwright trace archive: ${file} contains no '.trace' entry (${entryCount} ${
      entryCount === 1 ? 'entry' : 'entries'
    } read)`,
    {
      hint: 'a trace archive contains trace.trace, or one N-trace.trace per browser context when written by @playwright/test',
    },
  );
}

/**
 * §8: "trace format version unsupported — exit 2, naming the version and the versions supported".
 *
 * The two directions carry different advice, because they are different problems: a newer trace
 * means our reader is behind, an older one means the suite's Playwright is behind the floor at
 * which titles and step ids can be mapped correctly at all.
 */
export function traceVersionUnsupported(
  file: string,
  found: number,
  supported: readonly number[],
  options: { declared?: boolean } = {},
): E2eError {
  const lowest = supported[0];
  const highest = supported[supported.length - 1];
  const range = supported.join(', ');
  const subject =
    options.declared === false
      ? `the trace declares no format version, which Playwright reads as version ${found}, and ${found}`
      : `trace format version ${found}`;
  const direction =
    lowest !== undefined && found < lowest
      ? `${subject} is older than the supported versions (${range}); it was written by Playwright 1.44 or earlier, which records no step ids and no reliable origin, so titles cannot be mapped to step ids`
      : `${subject} is newer than the supported versions (${range}); this build of visual-diff cannot read it`;
  return new E2eError('e2e-trace-version-unsupported', file, `${direction}: ${file}`, {
    hint:
      lowest !== undefined && found < lowest
        ? `upgrade the suite to Playwright 1.45 or later and re-record the trace (version ${lowest} first shipped there)`
        : `upgrade visual-diff; the highest trace version it reads is ${highest}`,
  });
}

/** §8: "trace contains no screenshots — nothing to diff, and a run with no shots is worse than none". */
export function noScreenshots(file: string): E2eError {
  return new E2eError(
    'e2e-no-screenshots',
    file,
    `trace contains no screenshots: ${file} — there is nothing to diff, and a run with no shots is worse than none`,
    {
      hint: "screenshots default to off for library tracing: record with tracing.start({ screenshots: true, snapshots: true })",
    },
  );
}

/** A trace entry that is present but malformed: a bad NDJSON line, or a resource that is not one. */
export function traceCorrupt(file: string, detail: string, cause?: unknown): E2eError {
  return new E2eError('e2e-trace-corrupt', file, `corrupt trace archive: ${file} (${detail})`, {
    cause,
  });
}
