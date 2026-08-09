/**
 * Where scenario specs live on disk (mocking spec §5 "Storage").
 *
 * `.visual-diff/scenarios/<name>.yaml`, committed alongside flows and read from git history at the
 * target SHA during historical replay, exactly as flow specs are under D4.
 *
 * These three functions sit in `mocking/` rather than in `store/paths.ts` because the layout is
 * defined by the mocking spec and is read by the same module edge that parses the file — the CLI
 * binds one module for the whole slice (`cli/deps.ts`) and constructs no path of its own. The
 * store remains the authority for every path *inside* `.visual-diff/runs`, `diffs` and `cache`;
 * scenarios are input, like flows, not store state.
 *
 * The directory name is spelled here rather than imported from `store/paths.ts` for the same reason
 * `scenario/name.ts` spells it: the mocking layer stays free of the store, so a scenario can be
 * parsed and validated without loading it.
 */

import { readdir } from 'node:fs/promises';
import * as path from 'node:path';

import { SCENARIOS_DIRNAME, scenarioFileName } from '../scenario/index.js';
import type { ScenarioName } from '../types.js';

/** The store's own directory name. See the header for why it is restated. */
const VISUAL_DIFF_DIRNAME = '.visual-diff';

const YAML_EXTENSIONS = ['.yaml', '.yml'] as const;

/** Absolute path of `<root>/.visual-diff/scenarios`. */
export function scenariosDir(root: string): string {
  return path.join(root, VISUAL_DIFF_DIRNAME, SCENARIOS_DIRNAME);
}

/** Absolute path of `<root>/.visual-diff/scenarios/<name>.yaml`. */
export function scenarioFile(root: string, name: ScenarioName): string {
  return path.join(scenariosDir(root), scenarioFileName(name));
}

/**
 * Scenario names with a spec file on disk, sorted, or `[]` when the directory does not exist —
 * a project with no scenarios is not an error, it is the starting state.
 *
 * Every `.yaml`/`.yml` entry that is not a directory is listed, including one whose name could
 * never be selected (`none`). Omitting those would be the silent-skip the `list` command exists to
 * avoid: a file present but absent from the listing looks exactly like a file that was never
 * written, so it is listed and the parse step reports why it cannot be used. Symlinks are listed
 * for the same reason — vendoring a shared scenario by link is unusual, but failing to mention it
 * would be worse than parsing it.
 */
export async function listScenarios(root: string): Promise<ScenarioName[]> {
  let entries;
  try {
    entries = await readdir(scenariosDir(root), { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }

  const names: ScenarioName[] = [];
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
