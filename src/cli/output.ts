/**
 * cli — output (spec §9, §11.6).
 *
 * Two rendering modes, and the rule that separates them is absolute:
 *
 *  - `--json` writes **exactly one** JSON object to stdout and nothing else, ever. Warnings go
 *    inside the envelope, errors go inside the envelope, human prose is not written at all.
 *    Four harnesses parse this stream; a stray log line is a broken adapter.
 *  - Without `--json`, human text goes to stdout and warnings/errors go to stderr, so a shell
 *    pipeline still gets only the answer.
 */

import type { CliEnvelope, CliError } from '../types.js';

export interface Writer {
  out(text: string): void;
  err(text: string): void;
}

/** Writer bound to the real process streams. */
export function createWriter(): Writer {
  return {
    out(text: string) {
      process.stdout.write(text);
    },
    err(text: string) {
      process.stderr.write(text);
    },
  };
}

export interface BufferWriter extends Writer {
  /** Everything written to stdout, joined. */
  stdout(): string;
  /** Everything written to stderr, joined. */
  stderr(): string;
}

/** In-memory writer for tests and for the contract snapshots. */
export function createBufferWriter(): BufferWriter {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    out(text: string) {
      outChunks.push(text);
    },
    err(text: string) {
      errChunks.push(text);
    },
    stdout() {
      return outChunks.join('');
    },
    stderr() {
      return errChunks.join('');
    },
  };
}

/**
 * Build a success envelope. Key order is fixed (`ok`, `command`, `version`, `data`, `warnings`)
 * and absent fields are omitted rather than emitted as `null`, so the JSON is byte-stable across
 * runs and diffs cleanly in a contract snapshot.
 */
export function successEnvelope<T>(
  command: string,
  version: string,
  data: T,
  warnings?: readonly string[],
): CliEnvelope<T> {
  const envelope: CliEnvelope<T> = { ok: true, command, version, data };
  if (warnings !== undefined && warnings.length > 0) envelope.warnings = [...warnings];
  return envelope;
}

/** Build a failure envelope. `data` is present when the command produced a result anyway. */
export function failureEnvelope<T>(
  command: string,
  version: string,
  error: CliError,
  data?: T,
  warnings?: readonly string[],
): CliEnvelope<T> {
  const envelope: CliEnvelope<T> = { ok: false, command, version };
  if (data !== undefined) envelope.data = data;
  envelope.error = error;
  if (warnings !== undefined && warnings.length > 0) envelope.warnings = [...warnings];
  return envelope;
}

/** The single JSON object, newline-terminated. */
export function writeEnvelope<T>(writer: Writer, envelope: CliEnvelope<T>): void {
  writer.out(`${JSON.stringify(envelope)}\n`);
}

export function writeLines(writer: Writer, lines: readonly string[], stream: 'out' | 'err' = 'out'): void {
  if (lines.length === 0) return;
  const text = `${lines.join('\n')}\n`;
  if (stream === 'out') writer.out(text);
  else writer.err(text);
}

/** Fixed-width table. Columns are padded to their widest cell; the last column is not padded. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, column) => {
    let width = header.length;
    for (const row of rows) {
      const cell = row[column] ?? '';
      if (cell.length > width) width = cell.length;
    }
    return width;
  });

  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column === widths.length - 1 ? cell : cell.padEnd(widths[column] ?? cell.length),
      )
      .join('  ')
      .trimEnd();

  return [render(headers), ...rows.map((row) => render(headers.map((_, i) => row[i] ?? '')))];
}

/** Human rendering of a failure: the message, the offending locations, then the hint. */
export function formatError(error: CliError): string[] {
  const lines = [`error: ${error.message}  (${error.code})`];
  for (const issue of error.issues ?? []) {
    const at = issue.at;
    const location = [at.file, at.line, at.column].filter((part) => part !== undefined).join(':');
    const key = at.key === undefined ? '' : `  ${at.key}`;
    lines.push(`  ${location}${key}  ${issue.code}: ${issue.message}`);
  }
  if (error.hint !== undefined) lines.push(`hint: ${error.hint}`);
  return lines;
}

/** Percentage with one decimal, e.g. 0.021 -> "2.1%". */
export function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
