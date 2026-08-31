/**
 * ci/app-script — find the prebuilt static-report bundle for `vdiff export` (CI spec D38).
 *
 * Same two-layout resolution as `report/server/assets.ts`: an installed package has this file at
 * `dist/ci/app-script.js` with the UI at `dist/ui/`, a source checkout runs it from `src/ci/` with
 * the UI at `<repo>/dist/ui/`. Null rather than a throw when neither exists — the exporter writes
 * an honest page without the app (report-html.ts), because a missing dev build must not turn an
 * evidence export into a failure.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_SCRIPT = 'report-static.js';

export async function resolveAppScript(moduleUrl: string = import.meta.url): Promise<string | null> {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(here, '../ui', APP_SCRIPT), // dist/ci/ → dist/ui/ (installed)
    path.resolve(here, '../../dist/ui', APP_SCRIPT), // src/ci/ → <repo>/dist/ui/ (checkout)
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      // Try the next layout.
    }
  }
  return null;
}
