/**
 * `vdiff install-browser` — download the Chromium build the runner needs (spec §9, §10).
 *
 * Everything else in the tool refuses to touch the network; this command exists so that refusal
 * has an escape hatch a user runs deliberately. It shells out to Playwright's own installer rather
 * than reimplementing a download, and resolves that installer out of the dependency tree so the
 * downloaded browser always matches the Playwright the runner will drive.
 *
 * The runtime dependency is `playwright-core` (spec §12: the package is distributed for `npx`, and
 * `playwright` drags in a test runner plus, historically, an install hook that downloads every
 * browser before the CLI can print its help). `playwright-core` ships the same `install` CLI, so
 * this command is the *only* thing that ever fetches a browser — which is the whole point.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { EXIT } from '../../types.js';
import type { CommandContext, CommandResult } from '../command.js';
import { runFailure } from '../error.js';
import type { InstallBrowserData } from '../shapes.js';

export interface PlaywrightCommand {
  command: string;
  args: string[];
}

/** Injected so the resolution rule is testable without Playwright installed. */
export interface ModuleResolver {
  resolve(specifier: string): string;
  readJson(path: string): unknown;
}

/**
 * Tried in order. `playwright-core` is the declared dependency; `playwright` is accepted because a
 * source checkout has it as a devDependency and a user may have installed it alongside, and its
 * `install` CLI is the same program.
 */
export const INSTALLER_PACKAGES = ['playwright-core', 'playwright'] as const;

/** Every `bin` entry of a manifest, as [name, relative path] pairs. */
function binEntries(manifest: unknown): Array<[string, string]> {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const parsed = manifest as { name?: unknown; bin?: unknown };
  if (typeof parsed.bin === 'string') {
    return typeof parsed.name === 'string' ? [[parsed.name, parsed.bin]] : [];
  }
  if (typeof parsed.bin !== 'object' || parsed.bin === null) return [];
  return Object.entries(parsed.bin as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );
}

/**
 * Prefer an installed Playwright's own CLI, executed with the running Node binary: no PATH lookup,
 * no shell, no registry round trip, and the version is guaranteed to match the one the runner will
 * drive. `npx` is the fallback for when neither package is resolvable from here.
 */
export function resolvePlaywrightCommand(resolver: ModuleResolver): PlaywrightCommand {
  for (const pkg of INSTALLER_PACKAGES) {
    try {
      const packageJsonPath = resolver.resolve(`${pkg}/package.json`);
      const entries = binEntries(resolver.readJson(packageJsonPath));
      // Prefer the bin named after the package; otherwise the sole entry, whatever it is called.
      const chosen = entries.find(([name]) => name === pkg) ?? entries[0];
      if (chosen !== undefined) {
        return {
          command: process.execPath,
          args: [join(dirname(packageJsonPath), chosen[1]), 'install', 'chromium'],
        };
      }
    } catch {
      /* try the next package, then npx */
    }
  }
  return { command: 'npx', args: ['--yes', 'playwright-core', 'install', 'chromium'] };
}

function nodeResolver(): ModuleResolver {
  const require_ = createRequire(import.meta.url);
  return {
    resolve: (specifier) => require_.resolve(specifier),
    readJson: (path) => require_(path) as unknown,
  };
}

export async function installBrowser(
  ctx: CommandContext,
  resolver: ModuleResolver = nodeResolver(),
): Promise<CommandResult<InstallBrowserData>> {
  const { command, args } = resolvePlaywrightCommand(resolver);
  const printable = `${command} ${args.join(' ')}`;

  const result = await ctx.spawn(command, args, { cwd: ctx.cwd });
  const output = `${result.stdout}${result.stderr}`.trim();

  if (result.code !== 0) {
    throw runFailure('browser-install-failed', `\`${printable}\` exited ${result.code}`, {
      hint:
        output.length === 0
          ? 'npx playwright-core install chromium'
          : output.split('\n').slice(-5).join('\n'),
    });
  }

  const human = ['chromium installed'];
  if (output.length > 0) human.push(...output.split('\n'));

  return {
    data: { browser: 'chromium', installed: true, command: printable },
    human,
    exitCode: EXIT.OK,
  };
}
