/**
 * cli — reading back the diagnostics a failed run retained (spec §10).
 *
 * §10 is specific: "Dev server never ready → **exit 1 with the last 50 lines of server log**, saved
 * to the run directory". Saving it is the runner's half; printing it is this one. A path on its own
 * is not the requirement and is not useful either — the agent that ran the command has to open a
 * second file to learn why the command failed, and a human scrolling a terminal has to leave it.
 *
 * The same treatment applies to `install.log`: any log `meta.json#failure.logPath` names is read
 * and tailed here, because "the run failed and here is the end of the log that says why" is the
 * same answer in both cases.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import { DEFAULTS } from '../types.js';

/** Last `limit` non-empty-tail lines of a log, with trailing blank lines and `\r` removed. */
export function tailLines(text: string, limit: number = DEFAULTS.serverLogTailLines): string[] {
  if (limit <= 0) return [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  return lines.slice(-limit);
}

export interface LogTailResult {
  /** Absolute path of the log that was read. */
  path: string;
  lines: string[];
  /** True when the log was longer than `limit`, so the reader knows the head was dropped. */
  truncated: boolean;
}

/**
 * Read `<runDir>/<logPath>` and return its tail, or null when there is nothing to show.
 *
 * `logPath` comes off `meta.json`, which is data on disk rather than a value this process
 * computed, so it is confined to the run directory before it is opened. A missing or unreadable
 * log is not an error: the command it belongs to has already failed, and losing the log must not
 * change the exit code or replace the real failure message with a filesystem one.
 */
export async function readLogTail(
  runDir: string,
  logPath: string,
  limit: number = DEFAULTS.serverLogTailLines,
): Promise<LogTailResult | null> {
  if (logPath.length === 0 || isAbsolute(logPath) || logPath.split(/[\\/]/).includes('..')) {
    return null;
  }
  const root = resolve(runDir);
  const target = resolve(root, logPath);
  if (target !== root && !target.startsWith(root + sep)) return null;

  let text: string;
  try {
    text = await readFile(target, 'utf8');
  } catch {
    return null;
  }

  const all = tailLines(text, Number.MAX_SAFE_INTEGER);
  const lines = tailLines(text, limit);
  if (lines.length === 0) return null;
  return { path: target, lines, truncated: all.length > lines.length };
}

/**
 * The hint a failed run carries: what the log is, where it lives, and its tail — indented so the
 * captured output is visibly not this tool's own prose.
 */
export function formatLogTail(logPath: string, tail: LogTailResult): string {
  const head = tail.truncated
    ? `last ${tail.lines.length} lines of ${logPath} (${tail.path})`
    : `${logPath} (${tail.path})`;
  return [`${head}:`, ...tail.lines.map((line) => `  ${line}`)].join('\n');
}
