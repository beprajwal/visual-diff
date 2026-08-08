/**
 * flowHash (spec §6, `meta.json`).
 *
 * sha256 over the canonical serialization, so the hash identifies the flow's *meaning*: comments,
 * whitespace, key order and an omitted-versus-explicit `shoot: true` do not move it; a selector, a
 * step order change, a viewport list change or a network mode change do.
 */

import { createHash } from 'node:crypto';
import type { FlowSpec, Sha256 } from '../types.js';
import { parseFlowSource, type ParseOptions } from './parse.js';
import { SpecError } from './errors.js';
import { serializeFlow } from './serialize.js';

export function hashFlow(spec: FlowSpec): Sha256 {
  return hashCanonical(serializeFlow(spec));
}

/** Parses then hashes. Throws `SpecError` (exit 2) when the source is not a valid flow spec. */
export function hashFlowSource(source: string, options: ParseOptions = {}): Sha256 {
  const result = parseFlowSource(source, options);
  return hashFlow(SpecError.unwrap(options.file ?? '<inline>', result));
}

function hashCanonical(canonical: string): Sha256 {
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
