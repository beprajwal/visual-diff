/**
 * cli — the two pieces of process plumbing the commands need, isolated so every command stays a
 * plain function that a test can call: a child-process runner and a shutdown signal.
 */

import { spawn as nodeSpawnProcess } from 'node:child_process';

import type { SpawnFn } from './command.js';

/** Captures stdout/stderr rather than inheriting them, so `--json` output stays uncontaminated. */
export const spawnCapture: SpawnFn = (command, args, options) =>
  new Promise((resolve) => {
    const child = nodeSpawnProcess(command, [...args], {
      cwd: options?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (error: Error) => {
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code: number | null) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** Resolves on the first SIGINT or SIGTERM. `vdiff serve` blocks on this. */
export function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.removeListener('SIGINT', done);
      process.removeListener('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}
