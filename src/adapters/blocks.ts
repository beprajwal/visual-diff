/**
 * `AGENTS.md` block management (D19).
 *
 * Three of the four harnesses read `AGENTS.md`, and the user owns that file: it is where their own
 * build commands, conventions and warnings live, and it is frequently uncommitted. So this module
 * manages exactly one span of it — everything between `<!-- vdiff:start -->` and
 * `<!-- vdiff:end -->` — and every other byte comes back out of `applyBlock` unchanged.
 *
 * That is the whole contract, and it is deliberately narrower than `files.ts`:
 *
 *  - absent file        → the file is created containing just the block
 *  - no markers         → the block is appended; the existing text is a byte-exact prefix
 *  - well-formed block  → the span is replaced; prefix and suffix are byte-exact
 *  - anything else      → throws, because the alternative is guessing where the block ends
 *
 * Appending rather than overwriting is not a convenience: overwriting a user's `AGENTS.md` is
 * unrecoverable if they have not committed it, and appending without markers duplicates the block
 * on every reinstall. The markers are what make the operation repeatable.
 */

/** The exact literals. Load-bearing: `applyBlock` matches them, it does not pattern-match. */
export const BLOCK_START = '<!-- vdiff:start -->';
export const BLOCK_END = '<!-- vdiff:end -->';

/** Where the managed span sits in a file, as string offsets. */
export interface BlockSpan {
  /** Index of the first character of `BLOCK_START`. */
  start: number;
  /** Index one past the last character of `BLOCK_END`. */
  end: number;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Every malformed-block refusal. `file` is named so the message points at something actionable. */
export class MalformedBlockError extends Error {
  readonly file: string;

  constructor(file: string, detail: string) {
    super(
      `${file} has a malformed visual-diff block: ${detail}. ` +
        `Fix or remove the '${BLOCK_START}' / '${BLOCK_END}' markers and re-run; ` +
        'refusing to guess which part of the file is managed.',
    );
    this.name = 'MalformedBlockError';
    this.file = file;
  }
}

/**
 * Locate the managed span, or null when the file has no markers at all.
 * Throws {@link MalformedBlockError} for every other arrangement.
 */
export function findBlock(text: string, file = 'AGENTS.md'): BlockSpan | null {
  const starts = countOccurrences(text, BLOCK_START);
  const ends = countOccurrences(text, BLOCK_END);

  if (starts === 0 && ends === 0) return null;

  if (starts > 1) {
    throw new MalformedBlockError(file, `${starts} '${BLOCK_START}' markers, expected 1`);
  }
  if (ends > 1) {
    throw new MalformedBlockError(file, `${ends} '${BLOCK_END}' markers, expected 1`);
  }
  if (ends === 0) {
    throw new MalformedBlockError(file, `a '${BLOCK_START}' marker with no matching '${BLOCK_END}'`);
  }
  if (starts === 0) {
    throw new MalformedBlockError(file, `a '${BLOCK_END}' marker with no matching '${BLOCK_START}'`);
  }

  const start = text.indexOf(BLOCK_START);
  const endMarker = text.indexOf(BLOCK_END);
  if (endMarker < start) {
    throw new MalformedBlockError(
      file,
      `'${BLOCK_END}' appears before '${BLOCK_START}'`,
    );
  }
  return { start, end: endMarker + BLOCK_END.length };
}

/** The markers wrapped around the content. Always starts with the start marker and ends with the end one. */
export function renderBlock(content: string): string {
  return `${BLOCK_START}\n${content.trim()}\n${BLOCK_END}`;
}

/** The content currently inside the block, or null when the file has none. */
export function readBlock(text: string, file = 'AGENTS.md'): string | null {
  const span = findBlock(text, file);
  if (span === null) return null;
  return text.slice(span.start + BLOCK_START.length, span.end - BLOCK_END.length).trim();
}

/**
 * Put `content` in the managed block of `existing`, which may be null for a file that does not
 * exist yet. Pure — the caller writes the result.
 *
 * Guarantees, all covered by property tests:
 *  - the text before the block and the text after it are returned byte-for-byte;
 *  - applying the same content twice returns the identical string;
 *  - when there is no block, the whole existing file is a byte-exact prefix of the result.
 */
export function applyBlock(existing: string | null, content: string, file = 'AGENTS.md'): string {
  const block = renderBlock(content);

  // Only a genuinely absent or empty file is *created*; a file holding nothing but whitespace still
  // owns those bytes and goes down the append path, so the prefix guarantee has no exceptions.
  if (existing === null || existing === '') return `${block}\n`;

  const span = findBlock(existing, file);
  if (span !== null) {
    return existing.slice(0, span.start) + block + existing.slice(span.end);
  }

  // No markers: append, keeping every existing byte and separating with one blank line.
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}\n`;
}
