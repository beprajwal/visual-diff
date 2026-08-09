/**
 * cli — what every command receives and returns.
 *
 * A command is a pure-ish function of `(context, invocation) -> CommandResult`. It never writes to
 * a stream, never reads argv and never calls `process.exit`: it returns data plus the human lines
 * that describe it, and `main.ts` decides which of the two to print and which exit code to use.
 * That is what makes the `--json` contract testable without spawning a process.
 */

import type { CliError, ExitCode } from '../types.js';
import type { Ports } from './ports.js';

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string },
) => Promise<SpawnResult>;

export interface CommandContext {
  /** Directory the user invoked `vdiff` from. */
  cwd: string;
  /**
   * The user's home directory — the root a `--global` install writes under (D16).
   *
   * Optional so that a test may construct a context without one; `main()` always supplies
   * `os.homedir()`. Injected rather than read at the point of use because a test that resolved the
   * real home directory would install into the machine running it.
   */
  home?: string;
  ports: Ports;
  /** Tool version, stamped into every envelope. */
  version: string;
  /** Child-process runner, injected so `install-browser` is testable. */
  spawn: SpawnFn;
  /** Resolves on SIGINT/SIGTERM; `serve` awaits it to stay alive. */
  waitForShutdown: () => Promise<void>;
}

export interface CommandResult<T> {
  data: T;
  /** Printed to stdout only when `--json` is absent. */
  human: string[];
  /** Surfaced in the envelope, and on stderr in human mode. */
  warnings?: string[];
  /** Set when the command produced a result *and* failed — a partial run, for example. */
  error?: CliError;
  /** Defaults to 0. `diff` never sets this: findings are information, not a gate (spec §9). */
  exitCode?: ExitCode;
  /** Runs after output is flushed. `serve` blocks here until shutdown. */
  after?: () => Promise<void>;
}
