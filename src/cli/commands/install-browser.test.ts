/**
 * `vdiff install-browser` resolves the installer out of the dependency tree so the browser it
 * downloads matches the Playwright the runner will drive.
 *
 * The dependency is `playwright-core`, whose `bin` is named `playwright-core` rather than
 * `playwright` — the bug this file exists to prevent is a resolver that looks up `bin.playwright`,
 * finds nothing, and silently degrades to an `npx` round trip that installs a *different* version.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT } from '../../types.js';
import type { CommandContext, SpawnResult } from '../command.js';
import { createTestPorts } from '../testing.js';
import {
  INSTALLER_PACKAGES,
  installBrowser,
  resolvePlaywrightCommand,
  type ModuleResolver,
} from './install-browser.js';

/** A resolver that knows about exactly the packages given, with the manifests given. */
function fakeResolver(manifests: Record<string, unknown>): ModuleResolver {
  return {
    resolve(specifier) {
      if (!(specifier in manifests)) throw new Error(`Cannot find module '${specifier}'`);
      return `/node_modules/${specifier}`;
    },
    readJson(path) {
      const specifier = path.replace('/node_modules/', '');
      return manifests[specifier];
    },
  };
}

function context(spawn: CommandContext['spawn']): CommandContext {
  return {
    cwd: '/project',
    ports: createTestPorts(),
    version: '0.1.0',
    spawn,
    waitForShutdown: async () => undefined,
  };
}

const CORE = { 'playwright-core/package.json': { name: 'playwright-core', bin: { 'playwright-core': 'cli.js' } } };
const FULL = { 'playwright/package.json': { name: 'playwright', bin: { playwright: 'cli.js' } } };

describe('resolvePlaywrightCommand', () => {
  it('prefers playwright-core, whose bin is not named "playwright"', () => {
    expect(resolvePlaywrightCommand(fakeResolver(CORE))).toEqual({
      command: process.execPath,
      args: ['/node_modules/playwright-core/cli.js', 'install', 'chromium'],
    });
  });

  it('accepts a plain `playwright` when that is what is installed', () => {
    expect(resolvePlaywrightCommand(fakeResolver(FULL)).args[0]).toBe(
      '/node_modules/playwright/cli.js',
    );
  });

  it('takes playwright-core first when both are present', () => {
    expect(resolvePlaywrightCommand(fakeResolver({ ...CORE, ...FULL })).args[0]).toBe(
      '/node_modules/playwright-core/cli.js',
    );
    expect(INSTALLER_PACKAGES[0]).toBe('playwright-core');
  });

  it('handles a string `bin` and an oddly named sole entry', () => {
    const stringBin = fakeResolver({
      'playwright-core/package.json': { name: 'playwright-core', bin: 'cli.js' },
    });
    expect(resolvePlaywrightCommand(stringBin).args[0]).toBe('/node_modules/playwright-core/cli.js');

    const renamed = fakeResolver({
      'playwright-core/package.json': { name: 'playwright-core', bin: { pw: 'lib/cli.js' } },
    });
    expect(resolvePlaywrightCommand(renamed).args[0]).toBe('/node_modules/playwright-core/lib/cli.js');
  });

  it('falls back to npx only when nothing is resolvable', () => {
    expect(resolvePlaywrightCommand(fakeResolver({}))).toEqual({
      command: 'npx',
      args: ['--yes', 'playwright-core', 'install', 'chromium'],
    });
    // A manifest with no usable bin is the same situation.
    expect(
      resolvePlaywrightCommand(fakeResolver({ 'playwright-core/package.json': { name: 'x' } })).command,
    ).toBe('npx');
  });

  it('resolves against the real dependency tree — the installed core CLI exists', () => {
    const require_ = createRequire(import.meta.url);
    const resolver: ModuleResolver = {
      resolve: (specifier) => require_.resolve(specifier),
      readJson: (path) => require_(path) as unknown,
    };
    const resolved = resolvePlaywrightCommand(resolver);

    expect(resolved.command).toBe(process.execPath);
    const manifest = require_.resolve('playwright-core/package.json');
    expect(resolved.args[0]).toBe(join(dirname(manifest), 'cli.js'));
    expect(resolved.args.slice(1)).toEqual(['install', 'chromium']);
  });
});

describe('installBrowser', () => {
  it('runs the resolved command and reports it', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawn = async (command: string, args: readonly string[]): Promise<SpawnResult> => {
      calls.push({ command, args });
      return { code: 0, stdout: 'Chromium downloaded\n', stderr: '' };
    };

    const result = await installBrowser(context(spawn), fakeResolver(CORE));

    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.data).toEqual({
      browser: 'chromium',
      installed: true,
      command: `${process.execPath} /node_modules/playwright-core/cli.js install chromium`,
    });
    expect(calls[0]?.args).toEqual(['/node_modules/playwright-core/cli.js', 'install', 'chromium']);
    expect(result.human).toContain('Chromium downloaded');
  });

  it('exits 1 with the tail of the installer output when it fails', async () => {
    const spawn = async (): Promise<SpawnResult> => ({
      code: 1,
      stdout: '',
      stderr: 'Error: getaddrinfo ENOTFOUND playwright.azureedge.net',
    });

    await expect(installBrowser(context(spawn), fakeResolver(CORE))).rejects.toMatchObject({
      code: 'browser-install-failed',
      exitCode: EXIT.RUN_FAILURE,
      hint: 'Error: getaddrinfo ENOTFOUND playwright.azureedge.net',
    });
  });

  it('names a runnable command in the hint when the installer said nothing', async () => {
    const spawn = async (): Promise<SpawnResult> => ({ code: 127, stdout: '', stderr: '' });
    await expect(installBrowser(context(spawn), fakeResolver(CORE))).rejects.toMatchObject({
      hint: 'npx playwright-core install chromium',
    });
  });
});
