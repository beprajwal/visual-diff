/**
 * store/internal — sha256 helpers.
 *
 * All hashes are emitted in the `"sha256:<hex>"` form that `Sha256` in types.ts documents.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { stableStringify } from './json.js';
import type { Sha256 } from '../../types.js';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256(input: string | Uint8Array): Sha256 {
  return `sha256:${sha256Hex(input)}`;
}

/** Hash of a value's stable serialization: key order and whitespace cannot move it. */
export function hashJsonStable(value: unknown): Sha256 {
  return sha256(stableStringify(value, 0));
}

export async function hashFile(target: string): Promise<Sha256> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return `sha256:${hash.digest('hex')}`;
}
