/**
 * Files a flow attaches (`upload`), resolved against the `.visual-diff/` directory.
 *
 * A fixture is committed beside the flow that uses it — `.visual-diff/fixtures/spec.pdf` — so a
 * historical replay finds it where the working tree has it, the same way a session file is read
 * from the machine rather than from git. The path in the flow is relative and stays inside the
 * directory: a flow is committed text, and committed text must not be able to name `/etc/passwd`
 * or `../../.env` as something to hand to a web page.
 */

import * as path from 'node:path';

import { RunnerError } from './errors.js';
import { EXIT } from '../types.js';

/** Absolute path of one fixture, or a config error naming what was wrong with the reference. */
export function resolveFixturePath(fixturesRoot: string, relative: string): string {
  if (relative.trim().length === 0 || path.isAbsolute(relative)) {
    throw new RunnerError({
      code: 'fixture-path-invalid',
      message: `upload path "${relative}" must be relative to .visual-diff/ (for example fixtures/spec.pdf)`,
      exitCode: EXIT.CONFIG_ERROR,
      kind: 'flow-invalid',
    });
  }
  const root = path.resolve(fixturesRoot);
  const resolved = path.resolve(root, relative);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(withSep)) {
    throw new RunnerError({
      code: 'fixture-path-escapes',
      message: `upload path "${relative}" escapes .visual-diff/`,
      exitCode: EXIT.CONFIG_ERROR,
      kind: 'flow-invalid',
    });
  }
  return resolved;
}

/** Every path an `upload` map names, resolved, in the order written. */
export function resolveFixturePaths(fixturesRoot: string, files: string | string[]): string[] {
  const list = Array.isArray(files) ? files : [files];
  return list.map((file) => resolveFixturePath(fixturesRoot, file));
}
