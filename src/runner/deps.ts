/**
 * The dependency cache for the slow path (spec §7).
 *
 * "The dep cache is keyed by lockfile hash, so a revision whose lockfile matches an existing entry
 * installs nothing. A revision with an unresolvable lockfile fails the run cleanly, with its install
 * log retained, rather than replaying against wrong dependency versions."
 *
 * Installs happen inside `cache/deps/<lockfile-sha>`, never inside the worktree, so the cache
 * outlives the worktree that produced it. The worktree gets a `node_modules` symlink pointing at it.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RunnerError } from './errors.js';

export interface LockfileKind {
  name: string;
  /** Install command used when `config.app.install` is not set. */
  install: string;
}

/**
 * Recognised lockfiles, in resolution order.
 *
 * `package.json` is the documented last resort, not a lockfile: a project that commits no lockfile
 * (the fixture app is one, deliberately, so its scripted history never has to carry one) would
 * otherwise be unreplayable at any historical revision. Keying the cache on the manifest still
 * gives "same dependencies in, no reinstall"; it just cannot promise the same *resolved* versions,
 * which is why it sits last and installs without `--frozen-lockfile`.
 */
export const LOCKFILES: readonly LockfileKind[] = [
  { name: 'pnpm-lock.yaml', install: 'pnpm install --frozen-lockfile' },
  { name: 'package-lock.json', install: 'npm ci' },
  { name: 'npm-shrinkwrap.json', install: 'npm ci' },
  { name: 'yarn.lock', install: 'yarn install --frozen-lockfile' },
  { name: 'bun.lockb', install: 'bun install --frozen-lockfile' },
  { name: 'package.json', install: 'npm install' },
];

/** Copied next to the lockfile so the install resolves the same way it would in the worktree. */
const SIDECAR_FILES = [
  'package.json',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.nvmrc',
  '.node-version',
  'pnpm-workspace.yaml',
];

const MARKER = '.vdiff-deps.json';

export interface LockfileInfo {
  name: string;
  path: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function findLockfile(dir: string): Promise<LockfileInfo | null> {
  for (const kind of LOCKFILES) {
    const path = join(dir, kind.name);
    if (await exists(path)) return { name: kind.name, path };
  }
  return null;
}

export function defaultInstallCommand(lockfileName: string): string {
  const kind = LOCKFILES.find((entry) => entry.name === lockfileName);
  if (!kind) {
    throw new RunnerError({
      code: 'lockfile-unknown',
      message: `unrecognised lockfile '${lockfileName}'`,
      kind: 'install',
    });
  }
  return kind.install;
}

/** Cache key: the lockfile's name and bytes. Pure, so it is directly testable. */
export function hashLockfile(name: string, contents: string | Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(name, 'utf8');
  hash.update('\0', 'utf8');
  hash.update(contents);
  return hash.digest('hex');
}

export function depsCacheEntry(cacheDepsDir: string, hash: string): string {
  return resolve(cacheDepsDir, hash);
}

export interface RunCommandResult {
  code: number;
  log: string;
}

/** Run a shell command, capturing stdout and stderr interleaved into one retained log. */
export function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunCommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    let size = 0;
    const push = (data: Buffer): void => {
      const text = data.toString('utf8');
      size += text.length;
      chunks.push(text);
      // Keep the log bounded; the tail is what diagnoses a failed install.
      while (size > 2_000_000 && chunks.length > 1) {
        const dropped = chunks.shift();
        size -= dropped ? dropped.length : 0;
      }
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);

    const timer = setTimeout(() => {
      chunks.push(`\n[vdiff] command timed out after ${timeoutMs}ms\n`);
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    const finish = (code: number): void => {
      clearTimeout(timer);
      resolvePromise({ code, log: `$ ${command}\n${chunks.join('')}` });
    };
    child.on('error', (error) => {
      chunks.push(`\n[vdiff] ${error.message}\n`);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

export interface EnsureDepsOptions {
  /** Directory whose lockfile defines the cache key — the worktree on the slow path. */
  projectDir: string;
  /** `.visual-diff/cache/deps`. */
  cacheDepsDir: string;
  /** `config.app.install`; defaults to the lockfile's canonical command. */
  installCmd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface DepsResult {
  hash: string;
  /** `cache/deps/<lockfile-sha>`. */
  dir: string;
  nodeModules: string;
  /** True when nothing was installed because the lockfile hash already had an entry. */
  cached: boolean;
  installLog: string;
  lockfile: string;
}

export async function ensureDeps(options: EnsureDepsOptions): Promise<DepsResult> {
  const { projectDir, cacheDepsDir } = options;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const env = options.env ?? { ...process.env, CI: '1', NO_COLOR: '1', npm_config_color: 'false' };

  const lockfile = await findLockfile(projectDir);
  if (!lockfile) {
    throw new RunnerError({
      code: 'lockfile-missing',
      message: `no lockfile and no package.json in ${projectDir}: cannot resolve dependencies for this revision`,
      kind: 'install',
      hint: `commit one of ${LOCKFILES.map((l) => l.name).join(', ')} so historical replays install the same versions`,
    });
  }

  const contents = await readFile(lockfile.path);
  const hash = hashLockfile(lockfile.name, contents);
  const dir = depsCacheEntry(cacheDepsDir, hash);
  const nodeModules = join(dir, 'node_modules');

  if ((await exists(join(dir, MARKER))) && (await exists(nodeModules))) {
    return { hash, dir, nodeModules, cached: true, installLog: '', lockfile: lockfile.name };
  }

  const command = options.installCmd ?? defaultInstallCommand(lockfile.name);
  await mkdir(cacheDepsDir, { recursive: true });
  const tmp = join(cacheDepsDir, `.tmp-${hash.slice(0, 12)}-${process.pid}-${Date.now().toString(36)}`);
  await mkdir(tmp, { recursive: true });

  try {
    await copyFile(lockfile.path, join(tmp, lockfile.name));
    let sawManifest = false;
    for (const name of SIDECAR_FILES) {
      const from = join(projectDir, name);
      if (await exists(from)) {
        await copyFile(from, join(tmp, name));
        if (name === 'package.json') sawManifest = true;
      }
    }
    if (!sawManifest) {
      throw new RunnerError({
        code: 'manifest-missing',
        message: `no package.json next to ${lockfile.name} in ${projectDir}`,
        kind: 'install',
      });
    }

    const result = await runCommand(command, tmp, env, timeoutMs);
    if (result.code !== 0) {
      throw new RunnerError({
        code: 'install-failed',
        message: `install failed for lockfile ${lockfile.name} (exit ${result.code}): ${command}`,
        kind: 'install',
        log: result.log,
        logName: 'install.log',
      });
    }
    if (!(await exists(join(tmp, 'node_modules')))) {
      throw new RunnerError({
        code: 'install-failed',
        message: `install command produced no node_modules: ${command}`,
        kind: 'install',
        log: result.log,
        logName: 'install.log',
      });
    }

    await writeFile(
      join(tmp, MARKER),
      `${JSON.stringify(
        { hash, lockfile: lockfile.name, command, installedAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
      'utf8',
    );

    try {
      await rename(tmp, dir);
    } catch {
      // Another run finished the same lockfile first: keep theirs, drop ours.
      await rm(tmp, { recursive: true, force: true });
      if (!(await exists(nodeModules))) throw new RunnerError({
        code: 'install-failed',
        message: `could not publish the dependency cache entry for ${hash}`,
        kind: 'install',
        log: result.log,
        logName: 'install.log',
      });
      return { hash, dir, nodeModules, cached: true, installLog: result.log, lockfile: lockfile.name };
    }

    return { hash, dir, nodeModules, cached: false, installLog: result.log, lockfile: lockfile.name };
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Point `<projectDir>/node_modules` at the shared cache entry. Only ever called on a detached
 * worktree under `cache/worktrees`, which is why replacing an existing directory is safe.
 */
export async function linkNodeModules(projectDir: string, nodeModules: string): Promise<void> {
  const target = join(projectDir, 'node_modules');
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) await unlink(target);
    else await rm(target, { recursive: true, force: true });
  } catch {
    /* nothing there yet */
  }
  await symlink(nodeModules, target, process.platform === 'win32' ? 'junction' : 'dir');
}
