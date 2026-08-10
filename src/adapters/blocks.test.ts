import { describe, expect, it } from 'vitest';

import {
  BLOCK_END,
  BLOCK_START,
  MalformedBlockError,
  applyBlock,
  findBlock,
  readBlock,
  renderBlock,
} from './blocks.js';

const BLOCK = renderBlock('managed content');

describe('renderBlock', () => {
  it('wraps the content in the two markers, on their own lines', () => {
    expect(renderBlock('hello')).toBe(`${BLOCK_START}\nhello\n${BLOCK_END}`);
  });

  it('trims the content so reinstalls cannot accumulate blank lines', () => {
    expect(renderBlock('\n\n  hello  \n\n')).toBe(`${BLOCK_START}\nhello\n${BLOCK_END}`);
  });
});

describe('findBlock', () => {
  it('returns null when the file has no markers at all', () => {
    expect(findBlock('# my notes\n')).toBeNull();
    expect(findBlock('')).toBeNull();
  });

  it('locates a well-formed span', () => {
    const text = `before\n\n${BLOCK}\n\nafter\n`;
    const span = findBlock(text);
    expect(span).not.toBeNull();
    expect(text.slice(span?.start, span?.end)).toBe(BLOCK);
  });

  it('rejects a start marker with no end marker, naming the file and both markers', () => {
    expect(() => findBlock(`notes\n${BLOCK_START}\nstuff\n`, 'AGENTS.md')).toThrow(
      MalformedBlockError,
    );
    expect(() => findBlock(`notes\n${BLOCK_START}\nstuff\n`, 'AGENTS.md')).toThrow(
      "AGENTS.md has a malformed visual-diff block: a '<!-- vdiff:start -->' marker with no " +
        "matching '<!-- vdiff:end -->'",
    );
  });

  it('says it is refusing to guess, rather than silently picking an end', () => {
    try {
      findBlock(`${BLOCK_START}\nstuff\n`, 'docs/AGENTS.md');
      throw new Error('expected a MalformedBlockError');
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedBlockError);
      const message = (error as Error).message;
      expect(message).toContain('docs/AGENTS.md');
      expect(message).toContain('refusing to guess which part of the file is managed');
      expect((error as MalformedBlockError).file).toBe('docs/AGENTS.md');
    }
  });

  it('rejects an end marker with no start marker', () => {
    expect(() => findBlock(`notes\n${BLOCK_END}\n`, 'AGENTS.md')).toThrow(
      "a '<!-- vdiff:end -->' marker with no matching '<!-- vdiff:start -->'",
    );
  });

  it('rejects duplicated markers rather than picking one', () => {
    expect(() => findBlock(`${BLOCK}\n${BLOCK}\n`, 'AGENTS.md')).toThrow(
      "AGENTS.md has a malformed visual-diff block: 2 '<!-- vdiff:start -->' markers, expected 1",
    );
    expect(() => findBlock(`${BLOCK_START}\nx\n${BLOCK_END}\n${BLOCK_END}\n`, 'AGENTS.md')).toThrow(
      "2 '<!-- vdiff:end -->' markers, expected 1",
    );
  });

  it('rejects an inverted pair', () => {
    expect(() => findBlock(`${BLOCK_END}\nx\n${BLOCK_START}\n`, 'AGENTS.md')).toThrow(
      "'<!-- vdiff:end -->' appears before '<!-- vdiff:start -->'",
    );
  });
});

describe('readBlock', () => {
  it('reads back exactly what was put in', () => {
    expect(readBlock(applyBlock(null, 'the content'))).toBe('the content');
    expect(readBlock(applyBlock('user notes\n', 'the content'))).toBe('the content');
  });

  it('is null for a file this tool has never touched', () => {
    expect(readBlock('user notes\n')).toBeNull();
  });
});

describe('applyBlock — creating (D19)', () => {
  it('creates a file containing just the block when there is none', () => {
    expect(applyBlock(null, 'managed content')).toBe(`${BLOCK}\n`);
    expect(applyBlock('', 'managed content')).toBe(`${BLOCK}\n`);
  });

  it('appends to a file that has content but no markers, keeping every existing byte', () => {
    const existing = '# My project\n\nRun `make test` before pushing.\n';
    const result = applyBlock(existing, 'managed content');

    expect(result.startsWith(existing)).toBe(true);
    expect(result).toContain(BLOCK);
    expect(result.slice(existing.length)).toBe(`\n${BLOCK}\n`);
  });

  it('separates an appended block from unterminated existing text', () => {
    const result = applyBlock('no trailing newline', 'managed content');
    expect(result).toBe(`no trailing newline\n\n${BLOCK}\n`);
    expect(result.startsWith('no trailing newline')).toBe(true);
  });

  it('does not add a third blank line when one is already there', () => {
    const result = applyBlock('notes\n\n', 'managed content');
    expect(result).toBe(`notes\n\n${BLOCK}\n`);
  });
});

describe('applyBlock — replacing (D19)', () => {
  it('replaces the span and leaves the surrounding bytes identical', () => {
    const before = '# My project\n\nSome rules.\n\n';
    const after = '\n\n## My own section\n\nMore rules.\n';
    const existing = `${before}${renderBlock('old content')}${after}`;

    const result = applyBlock(existing, 'new content');

    expect(result).toBe(`${before}${renderBlock('new content')}${after}`);
    expect(result.startsWith(before)).toBe(true);
    expect(result.endsWith(after)).toBe(true);
    expect(result).not.toContain('old content');
  });

  it('is idempotent: reinstalling the same content changes nothing', () => {
    const existing = `before\n\n${renderBlock('v1')}\n\nafter\n`;
    const once = applyBlock(existing, 'v2');
    const twice = applyBlock(once, 'v2');
    expect(twice).toBe(once);
    expect(applyBlock(twice, 'v2')).toBe(once);
  });

  it('is idempotent from nothing, too: create then reinstall', () => {
    const created = applyBlock(null, 'content');
    expect(applyBlock(created, 'content')).toBe(created);
  });

  it('append-then-replace touches the user text exactly once', () => {
    const user = 'user line\n';
    const appended = applyBlock(user, 'v1');
    const replaced = applyBlock(appended, 'v2');
    expect(replaced.startsWith(user)).toBe(true);
    expect(replaced).toBe(applyBlock(user, 'v2'));
  });

  it('refuses to touch a file whose block is malformed', () => {
    expect(() => applyBlock(`notes\n${BLOCK_START}\nhalf a block\n`, 'x', 'AGENTS.md')).toThrow(
      MalformedBlockError,
    );
  });
});

/* ---------------------------------------------------------------- property tests (spec §7.3) */

/**
 * A seeded LCG rather than `Math.random`, so a failure is reproducible from the seed printed in
 * the assertion message, and rather than a property-testing dependency, because the generator this
 * needs is fifteen lines and the no-new-dependencies rule is worth more than the sugar.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const FRAGMENTS = [
  '# Project\n',
  '\n',
  'Run `npm test`.\n',
  '## Conventions\n\n- two spaces\n',
  'A line with a <!-- comment --> in it\n',
  'Trailing text with no newline',
  '\n\n\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n',
  'Unicode: café — ✓\n',
];

function fragment(next: () => number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)] as string;
  }
  return out;
}

describe('applyBlock — properties over content before, after, and both', () => {
  it('preserves the prefix and the suffix byte for byte, and stays idempotent', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = lcg(seed);
      const before = fragment(next, Math.floor(next() * 4));
      const after = fragment(next, Math.floor(next() * 4));
      const content = `managed ${seed}`;
      const where = `seed ${seed}`;

      // Case 1: no block yet. The whole existing file survives as a prefix.
      const plain = `${before}${after}`;
      const created = applyBlock(plain === '' ? null : plain, content);
      expect(created.startsWith(plain), `${where}: prefix preserved when appending`).toBe(true);
      expect(readBlock(created), `${where}: block round-trips`).toBe(content);

      // Case 2: a block already sits between `before` and `after`.
      const existing = `${before}${renderBlock('previous content')}${after}`;
      const replaced = applyBlock(existing, content);
      expect(replaced.startsWith(before), `${where}: bytes before the block are untouched`).toBe(
        true,
      );
      expect(replaced.endsWith(after), `${where}: bytes after the block are untouched`).toBe(true);
      expect(replaced.length, `${where}: only the block changed length`).toBe(
        before.length + renderBlock(content).length + after.length,
      );
      expect(replaced, `${where}: the old content is gone`).not.toContain('previous content');

      // Idempotency across both routes.
      expect(applyBlock(replaced, content), `${where}: replace is idempotent`).toBe(replaced);
      expect(applyBlock(created, content), `${where}: create is idempotent`).toBe(created);
    }
  });

  it('never loses a byte of user text, whatever the fragments are', () => {
    for (let seed = 500; seed < 560; seed += 1) {
      const next = lcg(seed);
      const before = fragment(next, 1 + Math.floor(next() * 3));
      const after = fragment(next, 1 + Math.floor(next() * 3));
      const existing = `${before}${renderBlock('old')}${after}`;
      const result = applyBlock(existing, 'new');

      const stripped = result.replace(renderBlock('new'), '');
      expect(stripped, `seed ${seed}`).toBe(`${before}${after}`);
    }
  });
});
