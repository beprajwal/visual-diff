/**
 * `e2e/` — turning `--from trace <path|glob>` into a list of archives (e2e spec §6).
 *
 * `vdiff e2e --from trace 'test-results/**\/trace.zip'` is the shape the command is written for: a
 * suite writes one archive per test into a directory tree it names, and the whole point of D25 is
 * that we read what is already there rather than asking anyone to move it.
 *
 * The CLI deliberately does not expand the pattern itself (see `cli/ports.ts`): *which files a
 * pattern names* has to be one answer, shared by `vdiff e2e list` and `vdiff e2e`, or the preview is
 * a preview of something else. This module is that answer.
 *
 * ### What is supported, and why not more
 *
 * `*` (anything but a separator), `?` (one character) and `**` (zero or more directories). No brace
 * expansion, no `[…]` classes, no negation, and no dependency: the patterns a test suite's output
 * directory needs are exhausted by those three, and every additional construct is a new way for a
 * pattern to match nothing while looking right — which §6 already treats as exit 2 because it is
 * nearly always a wrong path.
 *
 * Two conveniences beyond globbing, both because a user's first attempt is a path rather than a
 * pattern:
 *
 *  - a pattern naming a **file** is that file, magic or not;
 *  - a pattern naming a **directory** is every `*.zip` beneath it, because `vdiff e2e --from trace
 *    test-results/` is what people type and refusing it would be pedantry.
 *
 * Symlinked directories are not descended into. A test-results tree is machine-generated and a cycle
 * in one would hang the ingest, which is a worse answer than not finding an archive somebody
 * symlinked in.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** Characters that make a path segment a pattern rather than a name. */
const MAGIC = /[*?]/;

export function hasMagic(pattern: string): boolean {
  return MAGIC.test(pattern);
}

/** Archive extension a bare directory is searched for. */
const ARCHIVE_EXTENSION = '.zip';

/** Directories never descended into: they hold no test output and are large. */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/**
 * Every existing file the pattern names, absolute and sorted.
 *
 * Sorted because ingestion order decides run ids, and two machines ingesting one CI run's output
 * must produce the same timeline. Locale-independent (`<`), so a machine's collation cannot reorder
 * a store.
 */
export async function discoverArchives(pattern: string, cwd: string): Promise<string[]> {
  const absolute = path.resolve(cwd, pattern);

  if (!hasMagic(absolute)) {
    const stat = await statOrNull(absolute);
    if (stat === null) return [];
    if (stat.isFile()) return [absolute];
    if (stat.isDirectory()) return sorted(await walkForExtension(absolute));
    return [];
  }

  const segments = splitSegments(absolute);
  const staticPrefix: string[] = [];
  let index = 0;
  while (index < segments.length && !hasMagic(segments[index] as string)) {
    staticPrefix.push(segments[index] as string);
    index += 1;
  }
  const root = staticPrefix.length === 0 ? path.parse(absolute).root : staticPrefix.join(path.sep);
  const rest = segments.slice(index);
  const matches: string[] = [];
  await matchSegments(root === '' ? path.sep : root, rest, matches);
  return sorted(matches);
}

/**
 * The pattern with its leading non-magic run removed, for messages.
 *
 * `vdiff e2e` reports the pattern exactly as typed, so this is only ever used where naming the part
 * that actually did the matching is clearer than repeating the whole string.
 */
function splitSegments(absolute: string): string[] {
  return absolute.split(/[/\\]+/).filter((segment, position) => segment !== '' || position === 0);
}

async function statOrNull(target: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

function sorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Every `*.zip` beneath a directory the user named directly. */
async function walkForExtension(directory: string): Promise<string[]> {
  const found: string[] = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of await readDirOrEmpty(current)) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) stack.push(child);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(ARCHIVE_EXTENSION)) found.push(child);
    }
  }
  return found;
}

async function readDirOrEmpty(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Walk `directory` matching `segments`, appending every file that matches all of them.
 *
 * `**` is handled by trying both readings at once — "consume no directory" and "consume this one" —
 * which is what makes `a/**\/b` match `a/b` as well as `a/x/y/b`.
 */
async function matchSegments(
  directory: string,
  segments: readonly string[],
  out: string[],
): Promise<void> {
  const [head, ...rest] = segments;
  if (head === undefined) return;

  if (head === '**') {
    // Zero directories consumed: the rest of the pattern applies right here.
    if (rest.length > 0) await matchSegments(directory, rest, out);
    for (const entry of await readDirOrEmpty(directory)) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        // One or more directories consumed: `**` still applies below.
        await matchSegments(child, segments, out);
      } else if (rest.length === 0 && entry.isFile()) {
        out.push(child);
      }
    }
    return;
  }

  const matcher = segmentMatcher(head);
  for (const entry of await readDirOrEmpty(directory)) {
    if (!matcher(entry.name)) continue;
    const child = path.join(directory, entry.name);
    if (rest.length === 0) {
      if (entry.isFile()) out.push(child);
      continue;
    }
    if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
      await matchSegments(child, rest, out);
    }
  }
}

/**
 * One path segment's pattern, compiled.
 *
 * A leading dot is not special: `test-results/**` finding `.last-run.json` is not a hazard here, and
 * a user who wrote `.playwright/*.zip` means the dotted directory they named.
 */
export function segmentMatcher(pattern: string): (name: string) => boolean {
  if (!hasMagic(pattern)) {
    return (name) => name === pattern;
  }
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '[^/\\\\]*';
    else if (char === '?') source += '[^/\\\\]';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const re = new RegExp(`^${source}$`);
  return (name) => re.test(name);
}
