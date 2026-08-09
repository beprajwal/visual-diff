/**
 * Key path → file/line/column, over the CST-backed AST the `yaml` package builds.
 *
 * Mocking spec §8 requires every rejection to carry "file, line and offending key", which is the
 * same requirement slice-1 §10 put on flow specs. `flow/parse.ts` solves it identically but does
 * not export the solution across its module edge (`flow/index.ts` exports `keyPath` and not
 * `locateInDoc`), and `scenario/` may not reach past that edge — so the twenty lines live here too
 * rather than the scenario layer depending on the flow layer for them. If a third spec format
 * appears, this is the moment to lift both copies into a shared spec-parsing utility.
 */

import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { SourceLocation } from '../types.js';

type ParsedDoc = ReturnType<typeof parseDocument>;

/** Resolves a key path (e.g. `['rules', 2, 'match', 'url']`) to a file/line/column/key location. */
export type Locate = (path: ReadonlyArray<string | number>) => SourceLocation;

/** `rules[2].match.url`, `rules[0].patchOps[1].op`, `mode`. */
export function keyPath(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

/**
 * Resolve a key path against a parsed document, falling back to the deepest node that did resolve.
 * A path that does not exist at all (a *missing* key, which is most of §8) still lands on its
 * parent, so the reported line is the rule the key is missing from rather than line 1.
 */
export function locateInDoc(
  doc: ParsedDoc | null,
  lineCounter: LineCounter,
  file: string,
  path: ReadonlyArray<string | number>,
): SourceLocation {
  const location: SourceLocation = { file };
  if (path.length > 0) location.key = keyPath(path);
  if (!doc) return location;

  let node: unknown = doc.contents;
  let anchor: unknown = doc.contents;

  for (let i = 0; i < path.length; i += 1) {
    const segment = path[i];
    if (segment === undefined) break;
    const last = i === path.length - 1;

    if (isMap(node)) {
      const pair = node.items.find(
        (candidate) => isScalar(candidate.key) && String(candidate.key.value) === String(segment),
      );
      if (!pair) break;
      anchor = last ? pair.key : (pair.value ?? pair.key);
      node = pair.value;
    } else if (isSeq(node)) {
      const index = typeof segment === 'number' ? segment : Number(segment);
      if (!Number.isInteger(index)) break;
      const item: unknown = node.items[index];
      if (item === undefined) break;
      anchor = item;
      node = item;
    } else {
      break;
    }
  }

  const offset = startOffset(anchor);
  if (offset === undefined) return location;
  const pos = lineCounter.linePos(offset);
  location.line = pos.line;
  location.column = pos.col;
  return location;
}

/** Location of a raw character offset, used for YAML syntax errors that have no key path. */
export function locateOffset(
  lineCounter: LineCounter,
  file: string,
  offset: number,
): SourceLocation {
  const pos = lineCounter.linePos(offset);
  return { file, line: pos.line, column: pos.col };
}

function startOffset(node: unknown): number | undefined {
  if (node === null || typeof node !== 'object' || !('range' in node)) return undefined;
  const range = (node as { range?: readonly number[] | null }).range;
  if (!range || typeof range[0] !== 'number') return undefined;
  return range[0];
}
