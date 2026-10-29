/**
 * `vdiff select` with git faked through `spawn` and the selector faked through the ports: what the
 * command owns is how the change is gathered and how the answer is carried, and that is what is
 * pinned here. The selection itself is tested beside the selector.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../types.js';
import type { CommandContext, SpawnFn } from '../command.js';
import { CliFailure } from '../error.js';
import { createTestPorts } from '../testing.js';
import { changedLines, select } from './select.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdiff-select-cmd-'));
  dirs.push(dir);
  return dir;
}

/** git as the command sees it: a merge-base, a diff, an untracked list. */
function fakeGit(calls: string[][] = []): SpawnFn {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'merge-base') {
      return args[1] === 'nowhere'
        ? { code: 128, stdout: '', stderr: 'fatal: Not a valid object name nowhere' }
        : { code: 0, stdout: 'abc123\n', stderr: '' };
    }
    if (args[0] === 'diff') return { code: 0, stdout: 'src/Cart.tsx\ndocs/x.md\n', stderr: '' };
    if (args[0] === 'ls-files') return { code: 0, stdout: 'src/New.tsx\n', stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: '/project',
    ports: createTestPorts(),
    version: '0.1.0',
    spawn: fakeGit(),
    waitForShutdown: async () => undefined,
    ...overrides,
  };
}

describe('vdiff select', () => {
  it('--base diffs the working tree against the merge-base and adds untracked files', async () => {
    const calls: string[][] = [];
    const result = await select(context({ spawn: fakeGit(calls) }), { kind: 'select', base: 'main', json: false });

    expect(calls).toEqual([
      ['git', 'merge-base', 'main', 'HEAD'],
      ['git', 'diff', '--name-only', '--no-renames', 'abc123'],
      ['git', 'ls-files', '--others', '--exclude-standard'],
    ]);
    expect(result.data.base).toBe('abc123');
    expect(result.data.changed).toEqual(['src/Cart.tsx', 'docs/x.md', 'src/New.tsx']);
    expect(result.data.mode).toBe('some');
    expect(result.data.flows).toEqual(['checkout']);
    expect(result.human).toEqual([
      '## Visual diff flows',
      '',
      '1 flow replays.',
      '',
      '- `checkout`: /cart via Cart.tsx, New.tsx',
    ]);
    expect(result.exitCode).toBeUndefined();
  });

  it('--changed reads a file of paths, and combines with --base', async () => {
    const dir = await temp();
    const file = join(dir, 'changed');
    await writeFile(file, 'src/A.tsx\n\n  src/B.tsx  \n', 'utf8');

    const alone = await select(context(), { kind: 'select', changed: file, json: false });
    expect(alone.data.changed).toEqual(['src/A.tsx', 'src/B.tsx']);
    expect(alone.data.base).toBeUndefined();

    const both = await select(context(), { kind: 'select', changed: file, base: 'main', json: false });
    expect(both.data.changed).toEqual(['src/A.tsx', 'src/B.tsx', 'src/Cart.tsx', 'docs/x.md', 'src/New.tsx']);
  });

  it('--all carries the reason through and selects everything without looking', async () => {
    const calls: string[][] = [];
    const result = await select(context({ spawn: fakeGit(calls) }), {
      kind: 'select',
      all: 'the pull request carries the label',
      json: false,
    });
    expect(calls).toEqual([]);
    expect(result.data.mode).toBe('all');
    expect(result.data.everything).toBe('the pull request carries the label');
    expect(result.data.flows).toEqual(['checkout', 'search']);
  });

  it('nothing reached is exit 0 with an empty list: an answer, not a failure', async () => {
    const dir = await temp();
    const file = join(dir, 'changed');
    await writeFile(file, 'docs/x.md\nlib/util.ts\n', 'utf8');
    const result = await select(context(), { kind: 'select', changed: file, json: false });
    expect(result.data.mode).toBe('none');
    expect(result.data.flows).toEqual([]);
    expect(result.data.unattributed).toEqual(['lib/util.ts']);
    expect(result.exitCode).toBeUndefined();
  });

  it('--summary appends the markdown to the file CI shows', async () => {
    const dir = await temp();
    const summary = join(dir, 'summary.md');
    await writeFile(summary, '# before\n', 'utf8');
    await select(context(), { kind: 'select', base: 'main', summary, json: false });
    expect(await readFile(summary, 'utf8')).toBe(
      '# before\n## Visual diff flows\n\n1 flow replays.\n\n- `checkout`: /cart via Cart.tsx, New.tsx\n',
    );
  });

  it('a base git cannot find is a config error with the fetch hint', async () => {
    const thrown = await select(context(), { kind: 'select', base: 'nowhere', json: false }).catch(
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CliFailure);
    expect(thrown).toMatchObject({
      code: 'base-unknown',
      exitCode: EXIT.CONFIG_ERROR,
      hint: 'fetch the base branch first; in a shallow clone, check out with fetch-depth: 0',
    });
  });

  it('a --changed file that cannot be read is a config error', async () => {
    const thrown = await select(context(), { kind: 'select', changed: '/nope/changed', json: false }).catch(
      (error: unknown) => error,
    );
    expect(thrown).toMatchObject({ code: 'changed-unreadable', exitCode: EXIT.CONFIG_ERROR });
  });

  it('reads a -U0 diff into head line numbers, a removed line taking the line it preceded', () => {
    const diff = [
      'diff --git a/x.css b/x.css',
      '--- a/x.css',
      '+++ b/x.css',
      '@@ -3 +3 @@ .badge {',
      '-  color: red;',
      '+  color: blue;',
      '@@ -9,2 +8,0 @@',
      '-.gone {',
      '-}',
      '@@ -20,0 +20,2 @@',
      '+.new {',
      '+}',
    ].join('\n');
    expect(changedLines(diff)).toEqual([
      { text: '  color: red;', line: 3, side: '-' },
      { text: '  color: blue;', line: 3, side: '+' },
      { text: '.gone {', line: 9, side: '-' },
      { text: '}', line: 9, side: '-' },
      { text: '.new {', line: 20, side: '+' },
      { text: '}', line: 21, side: '+' },
    ]);
  });
});
