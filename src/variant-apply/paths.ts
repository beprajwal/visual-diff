/**
 * Where variant specs live on disk (variants spec §4 "Storage").
 *
 * `.visual-diff/variants/<name>.yaml`, committed alongside flows and scenarios and read from git
 * history at the target SHA on historical replay, exactly as flow specs are under D4.
 *
 * This is `mocking/paths.ts` for variants, down to the reasoning: the three functions sit at the
 * slice edge rather than in `store/paths.ts` because the layout is defined by the variants spec and
 * is read by the same module the CLI binds for the whole slice (`cli/deps.ts#MODULE_SPECIFIERS`),
 * which constructs no path of its own. The store stays the authority for every path *inside*
 * `.visual-diff/runs`, `diffs` and `cache`; variants are input, like flows, not store state.
 */

import { readdir } from 'node:fs/promises';
import * as path from 'node:path';

import { VARIANTS_DIRNAME, variantFileName, type VariantName } from '../variant/index.js';

/**
 * The store's own directory name, restated here for the reason `mocking/paths.ts` restates it: this
 * layer stays free of the store, so a variant can be located and parsed without loading it.
 */
const VISUAL_DIFF_DIRNAME = '.visual-diff';

const YAML_EXTENSIONS = ['.yaml', '.yml'] as const;

/** Absolute path of `<root>/.visual-diff/variants`. */
export function variantsDir(root: string): string {
  return path.join(root, VISUAL_DIFF_DIRNAME, VARIANTS_DIRNAME);
}

/** Absolute path of `<root>/.visual-diff/variants/<name>.yaml`. */
export function variantFile(root: string, name: VariantName): string {
  return path.join(variantsDir(root), variantFileName(name));
}

/**
 * Variant names with a spec file on disk, sorted, or `[]` when the directory does not exist — a
 * project with no variants is not an error, it is the starting state.
 *
 * Every `.yaml`/`.yml` entry that is not a directory is listed, including one whose name could
 * never be selected (`none` is reserved, §7). Omitting those would be the silent skip that `list`
 * exists to avoid: a file present but absent from the listing looks exactly like a file that was
 * never written, so it is listed and the parse step reports why it cannot be used.
 */
export async function listVariants(root: string): Promise<VariantName[]> {
  let entries;
  try {
    entries = await readdir(variantsDir(root), { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }

  const names: VariantName[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const ext = YAML_EXTENSIONS.find((candidate) => entry.name.endsWith(candidate));
    if (ext === undefined) continue;
    const stem = entry.name.slice(0, -ext.length);
    if (stem.length === 0) continue;
    names.push(stem);
  }
  return names.sort();
}
