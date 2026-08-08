/**
 * `vdiff install-browser` — download the Chromium build Playwright needs (spec §9, §10).
 *
 * Everything else in the tool refuses to touch the network; this command exists so that refusal
 * has an escape hatch a user runs deliberately. It shells out to Playwright's own installer rather
 * than reimplementing a download, and resolves that installer out of the dependency tree so the
 * downloaded browser always matches the Playwright the runner will drive.
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
 * Prefer the installed Playwright's own CLI, executed with the running Node binary: no PATH
 * lookup, no shell, no registry round trip, and the version is guaranteed to match. `npx` is the
 * fallback for when Playwright is not resolvable from here — a global install, for instance.
 */
export function resolvePlaywrightCommand(resolver: ModuleResolver): PlaywrightCommand {
  try {
    const packageJsonPath = resolver.resolve('playwright/package.json');
    const parsed = resolver.readJson(packageJsonPath) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof parsed.bin === 'string' ? parsed.bin : parsed.bin?.['playwright'];
    if (typeof bin === 'string' && bin.length > 0) {
      return {
        command: process.execPath,
        args: [join(dirname(packageJsonPath), bin), 'install', 'chromium'],
      };
    }
  } catch {
    /* falls through to npx */
  }
  return { command: 'npx', args: ['--yes', 'playwright', 'install', 'chromium'] };
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
          ? 'npx playwright install chromium'
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
