/**
 * cli — the version stamped into every `--json` envelope.
 *
 * Prefers `src/version.ts#TOOL_VERSION` when that module is present, and otherwise reads the
 * package manifest that sits two directories above this file (true both in `src/cli` and in the
 * emitted `dist/cli`). Resolved once and memoised: it appears in every envelope, and a CLI that
 * hits the filesystem repeatedly to answer `--version` is silly.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Typed as `string`, not a literal, so this stays a runtime probe and not a hard build edge. */
const VERSION_MODULE: string = '../version.js';

let cached: string | null = null;

export async function readVersion(): Promise<string> {
  if (cached !== null) return cached;

  try {
    const module = (await import(VERSION_MODULE)) as { TOOL_VERSION?: unknown };
    if (typeof module.TOOL_VERSION === 'string' && module.TOOL_VERSION.length > 0) {
      cached = module.TOOL_VERSION;
      return cached;
    }
  } catch {
    /* falls back to the manifest */
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
