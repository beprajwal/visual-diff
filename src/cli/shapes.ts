/**
 * cli — the `data` payload of each command's `--json` envelope (spec §9, §11.6).
 *
 * `CliEnvelope<T>` in `src/types.ts` fixes the wrapper (`ok`, `command`, `version`, `data`,
 * `error`, `warnings`); these interfaces fix each `T`. They are the agent-facing API across four
 * harnesses, so they are pinned by contract tests and must not drift silently.
 *
 * Where a shape already exists in `src/types.ts` — `RunResult` for `run`, `ServeInfo` for `serve`,
 * `RunSummary` for `runs` — it is reused verbatim rather than restated.
 */

import type {
  AdapterId,
  DiffResult,
  FeedbackEntry,
  PairRef,
  RunId,
  RunSummary,
  ValidationIssue,
  ViewportId,
} from '../types.js';
import type { FileOutcome } from '../adapters/index.js';

/** `vdiff init` — what the scaffold wrote, and what it left alone. */
export interface InitData {
  root: string;
  dir: string;
  /** Project-root-relative, `/`-separated paths that were written. */
  created: string[];
  /** Paths that already existed and were left untouched. */
  skipped: string[];
  gitignore: 'created' | 'updated' | 'unchanged';
}

/** `vdiff flow new <name>` */
export interface FlowNewData {
  flow: string;
  path: string;
  created: boolean;
}

/** `vdiff flow check <name>` — only ever emitted for a valid spec; invalid ones are exit 2. */
export interface FlowCheckData {
  flow: string;
  path: string;
  valid: true;
  steps: number;
  viewports: ViewportId[];
  /** Step ids in declaration order — the keys the diff aligns on (D4). */
  stepIds: string[];
  warnings: ValidationIssue[];
}

/** `vdiff runs <flow>` — mirrors `RunsResponse` from the report API. */
export interface RunsData {
  flow: string;
  runs: RunSummary[];
}

/** `vdiff diff <flow> [base] [head]` */
export interface DiffData {
  flow: string;
  pair: PairRef;
  /** Absolute path of the stored `findings.json`. */
  path: string;
  /** True when the stored diff was reused rather than recomputed (spec §8). */
  cached: boolean;
  result: DiffResult;
}

/** `vdiff feedback [--ack]` */
export interface FeedbackData {
  count: number;
  entries: FeedbackEntry[];
  acked: boolean;
  /** Absolute path of `feedback/archive/<date>.jsonl`, set only when `--ack` was passed. */
  archive: string | null;
}

/** `vdiff pin <run>` */
export interface PinData {
  flow: string;
  runId: RunId;
  pinned: boolean;
}

/** `vdiff prune <run>` */
export interface PruneData {
  flow: string;
  runId: RunId;
  pruned: boolean;
}

/** `vdiff install <harness>` — the adapter files that were (or, with `--dry-run`, would be) written. */
export interface InstallData {
  harness: AdapterId;
  /** Human name of the harness, e.g. "Claude Code". */
  label: string;
  /** Absolute directory the paths below are relative to. */
  root: string;
  /** Project-relative paths created or updated. */
  written: string[];
  /** Paths left alone: already current, or edited by a human and preserved. */
  skipped: string[];
  /** Per-file outcome, so a caller can tell `preserved` from `unchanged`. */
  files: FileOutcome[];
  /** True when nothing was actually written. */
  dryRun: boolean;
}

/** `vdiff install-browser` */
export interface InstallBrowserData {
  browser: 'chromium';
  installed: boolean;
  /** The command that was executed, for reproducibility in a log. */
  command: string;
}

/** `vdiff --help` / `vdiff help` */
export interface HelpData {
  usage: string[];
  commands: Array<{ name: string; usage: string; summary: string }>;
}

/** `vdiff --version` */
export interface VersionData {
  version: string;
}
