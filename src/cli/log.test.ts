import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULTS } from '../types.js';
import { formatLogTail, readLogTail, tailLines } from './log.js';

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'vdiff-log-'));
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

const numbered = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

describe('tailLines', () => {
  it('keeps the last N lines, in order', () => {
    expect(tailLines(numbered(60), 3)).toEqual(['line 58', 'line 59', 'line 60']);
  });

  it('keeps everything when the log is shorter than the limit', () => {
    expect(tailLines('a\nb', 50)).toEqual(['a', 'b']);
  });

  it('defaults to the 50 lines spec §10 asks for', () => {
    expect(DEFAULTS.serverLogTailLines).toBe(50);
    expect(tailLines(numbered(200))).toHaveLength(50);
    expect(tailLines(numbered(200))[0]).toBe('line 151');
  });

  it('drops the trailing newline rather than reporting an empty last line', () => {
    expect(tailLines('a\nb\n\n\n', 50)).toEqual(['a', 'b']);
    expect(tailLines('', 50)).toEqual([]);
  });

  it('normalises CRLF, so a Windows dev server log is not one line of noise', () => {
    expect(tailLines('a\r\nb\r\n', 50)).toEqual(['a', 'b']);
  });
});

describe('readLogTail', () => {
  it('reads a run-relative log and reports whether the head was dropped', async () => {
    await writeFile(join(runDir, 'server.log'), `${numbered(60)}\n`, 'utf8');

    const tail = await readLogTail(runDir, 'server.log', 50);
    expect(tail).not.toBeNull();
    expect(tail?.lines).toHaveLength(50);
    expect(tail?.lines[0]).toBe('line 11');
    expect(tail?.lines[49]).toBe('line 60');
    expect(tail?.truncated).toBe(true);
    expect(tail?.path).toBe(join(runDir, 'server.log'));
  });

  it('does not claim truncation when the whole log fits', async () => {
    await writeFile(join(runDir, 'install.log'), 'boom\n', 'utf8');
    await expect(readLogTail(runDir, 'install.log', 50)).resolves.toMatchObject({
      lines: ['boom'],
      truncated: false,
    });
  });

  it('reads a log in a subdirectory of the run', async () => {
    await mkdir(join(runDir, 'logs'), { recursive: true });
    await writeFile(join(runDir, 'logs', 'server.log'), 'up\n', 'utf8');
    await expect(readLogTail(runDir, 'logs/server.log', 50)).resolves.toMatchObject({
      lines: ['up'],
    });
  });

  it('returns null rather than throwing when the log is missing or empty', async () => {
    await expect(readLogTail(runDir, 'server.log', 50)).resolves.toBeNull();
    await writeFile(join(runDir, 'empty.log'), '\n\n', 'utf8');
    await expect(readLogTail(runDir, 'empty.log', 50)).resolves.toBeNull();
  });

  it('refuses a path that escapes the run directory — meta.json is data, not a trusted input', async () => {
    await writeFile(join(runDir, 'outside.log'), 'secret\n', 'utf8');
    await mkdir(join(runDir, 'nested'), { recursive: true });

    await expect(readLogTail(join(runDir, 'nested'), '../outside.log', 50)).resolves.toBeNull();
    await expect(readLogTail(runDir, join(runDir, 'outside.log'), 50)).resolves.toBeNull();
    await expect(readLogTail(runDir, '', 50)).resolves.toBeNull();
  });
});

describe('formatLogTail', () => {
  it('names the log, gives its absolute path and indents the captured output', async () => {
    await writeFile(join(runDir, 'server.log'), 'listening\nready\n', 'utf8');
    const tail = await readLogTail(runDir, 'server.log', 50);
    if (tail === null) throw new Error('expected a tail');

    expect(formatLogTail('server.log', tail)).toBe(
      `server.log (${join(runDir, 'server.log')}):\n  listening\n  ready`,
    );
  });

  it('says how many lines it kept when it dropped the head', async () => {
    await writeFile(join(runDir, 'server.log'), `${numbered(60)}\n`, 'utf8');
    const tail = await readLogTail(runDir, 'server.log', 50);
    if (tail === null) throw new Error('expected a tail');

    expect(formatLogTail('server.log', tail)).toContain('last 50 lines of server.log');
  });
});
