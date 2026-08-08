/**
 * The dev server side of the runner (spec §7, "Two paths, chosen automatically").
 *
 * Fast path: probe `readyOn`; if the user's dev server is already up, drive it and spawn nothing.
 * Slow path: allocate a port, run `config.app.dev` with `$PORT` substituted, poll `readyOn` until
 * healthy, and keep the server log so §10's "dev server never ready → exit 1 with the last 50
 * lines" is a retained artefact rather than a lost stream.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { DEFAULTS } from '../types.js';
import { deterministicEnv } from './determinism.js';
import { RunnerError } from './errors.js';

/** Substitute `$PORT` / `${PORT}` in a command or URL. */
export function substitutePort(template: string, port: number): string {
  return template.replace(/\$\{PORT\}|\$PORT\b/g, String(port));
}

/** Port of a base URL, falling back to the scheme default. */
export function portOfUrl(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.port !== '') return Number(parsed.port);
  if (parsed.protocol === 'http:') return 80;
  if (parsed.protocol === 'https:') return 443;
  return null;
}

/** Ask the OS for a free loopback port. */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not allocate a port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** One readiness probe. Any HTTP answer counts — a 404 still proves the server is listening. */
export async function probe(url: string, timeoutMs = 2_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** Aborts the wait early — used to fail fast when the dev process has already exited. */
  stop?: () => string | null;
}

export async function waitForReady(url: string, options: WaitOptions): Promise<void> {
  const interval = options.intervalMs ?? 150;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const stopped = options.stop?.() ?? null;
    if (stopped !== null) throw new RunnerError({ code: 'server-exited', message: stopped, kind: 'server-not-ready' });
    if (await probe(url)) return;
    if (Date.now() >= deadline) {
      throw new RunnerError({
        code: 'server-not-ready',
        message: `dev server never became ready at ${url} within ${options.timeoutMs}ms`,
        kind: 'server-not-ready',
      });
    }
    await delay(interval);
  }
}

/** Keep the tail of a log stream bounded; §10 only ever needs the last 50 lines. */
export class LogTail {
  private readonly lines: string[] = [];
  private partial = '';

  constructor(private readonly limit: number = DEFAULTS.serverLogTailLines) {}

  push(chunk: string): void {
    this.partial += chunk;
    const parts = this.partial.split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) {
      this.lines.push(line);
      if (this.lines.length > this.limit) this.lines.shift();
    }
  }

  text(): string {
    const all = this.partial === '' ? this.lines : [...this.lines, this.partial];
    return all.slice(-this.limit).join('\n');
  }
}

export interface DevServerHandle {
  url: string;
  port: number;
  log(): string;
  stop(): Promise<void>;
}

export interface StartDevServerOptions {
  command: string;
  cwd: string;
  readyOn: string;
  readyTimeoutMs: number;
  port?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn the configured dev command and wait for `readyOn`. On failure the child is killed and the
 * retained log travels on the error, so `run.ts` can write it to `server.log` in the run directory.
 */
export async function startDevServer(options: StartDevServerOptions): Promise<DevServerHandle> {
  const port = options.port ?? (await allocatePort());
  const command = substitutePort(options.command, port);
  const readyUrl = substitutePort(options.readyOn, port);
  const tail = new LogTail();

  const child: ChildProcess = spawn(command, {
    cwd: options.cwd,
    shell: true,
    env: deterministicEnv(port, options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let exited: string | null = null;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => tail.push(chunk));
  child.stderr?.on('data', (chunk: string) => tail.push(chunk));
  child.on('exit', (code, signal) => {
    exited = `dev server exited before becoming ready (${signal ?? `code ${code ?? 'unknown'}`}): ${command}`;
  });
  child.on('error', (error: Error) => {
    exited = `dev server could not start: ${error.message}`;
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGKILL');
    }
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i += 1) {
      await delay(20);
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };

  try {
    await waitForReady(readyUrl, {
      timeoutMs: options.readyTimeoutMs,
      stop: () => exited,
    });
  } catch (error) {
    await stop();
    if (RunnerError.is(error)) {
      throw new RunnerError({
        code: error.code,
        message: error.message,
        kind: 'server-not-ready',
        log: tail.text(),
        logName: 'server.log',
        hint: `command: ${command}`,
        cause: error,
      });
    }
    throw error;
  }

  return { url: readyUrl, port, log: () => tail.text(), stop };
}
